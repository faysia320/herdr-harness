// Claude 로그인 계정별 사용량과 전환. 전환·이어서 실행은 설치된 하네스 release의 bin/claude-account.mjs가 한다.
// 사용량은 각 계정 설정 폴더의 usage-cache.json(상태줄이 Claude가 알려 준 한도로 갱신)을 읽는다.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { readTextFile, exec, home, theme, layout } from "herdr";

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const slash = (p) => String(p ?? "").replaceAll("\\", "/");

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// 초기화까지 남은 시간: 2d3h, 4h05m, 35m.
function left(reset, now) {
  const s = Math.floor(Number(reset) - now / 1000);
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s >= 86400) return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 60)}m`;
}
function ago(sec, now) {
  const m = Math.floor((now / 1000 - Number(sec)) / 60);
  return !Number.isFinite(m) ? "" : m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
}

export default class ClaudeAccounts extends View {
  init(_props, cx) {
    this.status = null; this.usage = new Map(); this.stopped = []; this.busy = null; this.error = null;
    this.refresh(cx, true);
    cx.timer.every(15000, (cx) => this.refresh(cx, false));
    cx.timer.every(60000, (cx) => this.refresh(cx, true));
  }

  async command(args) {
    const active = parse(await readTextFile(`${slash(home())}/.config/herdr-harness/active.json`));
    if (!active?.release) throw new Error("설치된 하네스 release를 찾지 못했습니다");
    const r = await exec("node", [`${slash(active.release)}/bin/claude-account.mjs`, ...args], { timeout: 60000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 200) || `종료 코드 ${r.code}`);
    return JSON.parse(r.stdout);
  }

  // full=true면 계정 상태(사용자 환경변수 조회)와 한도로 멈춘 세션도 다시 확인한다. 사용량 파일은 매번 읽는다.
  refresh(cx, full) {
    cx.spawn(async (cx) => {
      try {
        if (full || !this.status) {
          this.status = await this.command(["status"]);
          this.stopped = await this.command(["scan"]);
        }
        for (const a of this.status.accounts) this.usage.set(a.key, parse(await readTextFile(`${slash(a.dir)}/usage-cache.json`)));
        this.error = null;
      } catch (e) { this.error = e?.message ?? String(e); }
      cx.notify();
    });
  }

  act(label, args, cx) {
    if (this.busy) return;
    this.busy = label; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try { await this.command(args); } catch (e) { this.error = `${label} 실패: ${e?.message ?? e}`; }
      this.busy = null; cx.notify();
      this.refresh(cx, true);
    });
  }

  button(id, label, action, t) {
    return div().id(id).px(7).py(2).rounded(5).flex_none().cursor_pointer().border_1().border_color(t.border)
      .text_size(10.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }

  meter(name, part, now, t) {
    const used = part?.used;
    if (used === null || used === undefined) return div().text_size(10.5).text_color(t.dim).child(`${name} —`);
    const color = used >= 90 ? t.blocked ?? t.ansi1 : used >= 70 ? t.ansi3 : t.muted;
    const reset = left(part.reset, now);
    return div().text_size(10.5).text_color(color).child(`${name} ${Math.round(used)}%${reset ? ` (${reset})` : ""}`);
  }

  account(a, now, t) {
    const u = this.usage.get(a.key);
    const stale = u?.updated && now / 1000 - u.updated > 3 * 3600;
    if (narrow()) {
      const week = u?.seven_day?.used;
      return div().text_size(10).text_color(a.active ? t.foreground : t.dim).child(`${a.active ? "●" : "○"}${a.label} ${week === undefined || week === null ? "—" : `${Math.round(week)}%`}`);
    }
    return v_flex().gap(3).px(8).py(6).rounded(6).bg(a.active ? t.selected : t.background)
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11.5).font_semibold().text_color(a.active ? t.foreground : t.muted).child(`${a.active ? "●" : "○"} ${a.label}`))
        .child(div().flex_1().min_w(0).text_size(10).text_color(t.dim).child(a.email ?? (a.loggedIn ? "" : "로그인 필요")))
        .when(!a.active && a.loggedIn, (e) => e.child(this.button(`acct-use-${a.key}`, "전환", (cx) => this.act(`${a.label} 전환`, ["use", a.key], cx), t)
          .tooltip("새로 뜨는 Lead·에이전트가 이 계정을 씁니다. 실행 중인 세션은 그대로입니다."))))
      .child(h_flex().gap(8).items_center()
        .child(this.meter("5h", u?.five_hour, now, t))
        .child(this.meter("1w", u?.seven_day, now, t))
        .child(div().flex_1())
        .child(div().text_size(9.5).text_color(stale ? t.ansi3 : t.dim).child(u?.updated ? ago(u.updated, now) : "기록 없음")))
      .when(!a.loggedIn, (e) => e.child(div().text_size(9.5).text_color(t.dim).child(`터미널: $env:CLAUDE_CONFIG_DIR='${a.dir}'; claude → /login`)));
  }

  render(_cx) {
    const t = theme(), now = Date.now(), list = this.status?.accounts ?? [];
    return v_flex().id("claude-accounts").size_full().min_h(0).overflow_y_scrollbar().p(6).gap(5).bg(t.background).text_color(t.foreground)
      .child(h_flex().px(2).items_center().child(div().text_size(11).font_semibold().text_color(t.muted).child(narrow() ? "계정" : "Claude 계정")))
      .when(!list.length && !this.error, (e) => e.child(div().px(2).text_size(10.5).text_color(t.dim).child("확인 중…")))
      .children(list.map((a) => this.account(a, now, t)))
      .when(Boolean(this.status?.unknownDir), (e) => e.child(div().px(2).text_size(10).text_color(t.ansi3).child(`등록되지 않은 폴더 사용 중: ${this.status.unknownDir}`)))
      .children(narrow() ? [] : this.stopped.map((s) => v_flex().gap(3).px(8).py(5).rounded(6).border_1().border_color(t.blocked ?? t.ansi1)
        .child(div().text_size(10.5).text_color(t.blocked ?? t.ansi1).child(`한도로 멈춤 · ${s.name ?? s.address}`))
        .child(h_flex().child(this.button(`acct-resume-${s.address}`, "현재 계정으로 이어서 실행", (cx) => this.act(`${s.name ?? s.address} 이어서 실행`, ["resume", s.address], cx), t)
          .tooltip("같은 이름·위치로 다시 띄워 같은 대화를 지금 계정으로 이어 갑니다.")))))
      .when(Boolean(this.busy), (e) => e.child(div().px(2).text_size(10).text_color(t.muted).child(`${this.busy} 중…`)))
      .when(Boolean(this.error), (e) => e.child(div().px(2).text_size(10).text_color(t.blocked ?? t.ansi1).child(this.error)));
  }
}
