// 기본 Claude 설정의 사용량을 표시한다. 로그인·전환은 Claude CLI에서 직접 한다.
// 사용량은 기본 설정의 usage-cache.json(상태줄이 갱신)을 읽는다.
// Codex 사용량은 보기 전용으로 아래에 함께 그린다.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { readTextFile, exec, home, theme, layout } from "herdr";

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const slash = (p) => String(p ?? "").replaceAll("\\", "/");
const CLAUDE = "#D97757", CODEX = "#10A37F";

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
const known = (v) => v !== null && v !== undefined;

export default class ClaudeAccounts extends View {
  init(_props, cx) {
    this.status = null; this.usage = new Map(); this.refreshing = false; this.codex = null;
    this.refreshError = null;
    this.refresh(cx, true);
    cx.timer.every(15000, (cx) => this.refresh(cx, false));
    cx.timer.every(60000, (cx) => this.refresh(cx, true));
  }

  async command(args) {
    const active = parse(await readTextFile(`${slash(home())}/.config/herdr-harness/active.json`));
    if (!active?.release) throw new Error("설치된 하네스 release를 찾지 못했습니다");
    const r = await exec("node", [`${slash(active.release)}/bin/claude-account.mjs`, ...args], { timeout: 120000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 200) || `종료 코드 ${r.code}`);
    return JSON.parse(r.stdout);
  }

  // full=true면 Codex 사용량도 다시 읽는다. Claude 사용량 파일은 매번 읽는다.
  refresh(cx, full) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        if (full || !this.status) {
          this.status = await this.command(["status"]);

          // Codex는 보기 전용이라 실패해도 Claude 표시는 그대로 둔다.
          try { this.codex = await this.command(["codex"]); } catch { this.codex = null; }
        }
        for (const a of this.status.accounts) this.usage.set(a.key, parse(await readTextFile(slash(a.usageFile))));
        this.refreshError = null;
      } catch (e) { this.refreshError = e?.message ?? String(e); }
      this.refreshing = false; cx.notify();
    });
  }

  // 사용률 색: 여유(초록) → 주의(노랑, 70%) → 위험(빨강, 90%).
  tone(used, t) {
    return used >= 90 ? (t.ansi1 ?? t.blocked) : used >= 70 ? (t.ansi3 ?? t.working) : (t.ansi2 ?? t.done);
  }

  // 주간 사용량 한 줄: 막대 + 퍼센트 + 초기화까지 남은 시간.
  gauge(week, now, t) {
    if (!known(week?.used)) {
      return v_flex().gap(3)
        .child(div().h(6).w_full().rounded_full().bg(t.hover))
        .child(div().text_size(9.5).text_color(t.dim).child("사용량 기록 없음"));
    }
    const pct = Math.max(0, Math.min(100, week.used)), color = this.tone(pct, t), reset = left(week.reset, now);
    return v_flex().gap(3)
      .child(div().h(6).w_full().rounded_full().bg(t.hover).overflow_hidden()
        .child(div().h_full().w(`${Math.max(pct, 2)}%`).rounded_full().bg(color)))
      .child(h_flex().items_center()
        .child(div().text_size(12).font_bold().text_color(color).child(`${Math.round(pct)}%`))
        .child(div().pl(5).text_size(9.5).text_color(t.dim).child("주간"))
        .child(div().flex_1())
        .child(div().text_size(9.5).text_color(t.dim).child(reset ? `${reset} 후 초기화` : "")));
  }

  // 서비스 머리글: 브랜드 색 점 + 이름 + 오른쪽 상태.
  heading(name, color, t, extra) {
    return h_flex().px(2).pt(2).gap(6).items_center()
      .child(div().size(7).flex_none().rounded_full().bg(color))
      .child(div().text_size(10.5).font_semibold().text_color(t.muted).child(name))
      .child(div().flex_1())
      .when(Boolean(extra), (e) => e.child(extra));
  }

  // 왼쪽 정사각 배지: 계정·서비스 머리글자.
  badge(text, on, t) {
    return h_flex().size(20).flex_none().rounded(6).items_center().justify_center().bg(on ? t.accent : t.hover)
      .text_size(10.5).font_bold().text_color(on ? t.background : t.muted).child(text);
  }

  // 사이드바를 좁게 접었을 때: 머리글자와 주간 퍼센트만.
  compact(label, week, t, active) {
    return div().text_size(10).font_medium().text_color(known(week?.used) ? this.tone(week.used, t) : t.dim)
      .child(`${active ? "●" : ""}${label} ${known(week?.used) ? `${Math.round(week.used)}%` : "—"}`);
  }

  account(a, now, t) {
    const u = this.usage.get(a.key), week = u?.seven_day;
    if (narrow()) return this.compact("Claude", week, t, false);
    return v_flex().gap(6).px(9).py(8).rounded(8).bg(t.raised ?? t.background).border_1().border_color(t.border)
      .child(h_flex().gap(7).items_center()
        .child(this.badge("C", false, t))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(10.5).font_medium().text_color(t.muted).child("Claude"))
          .child(div().text_size(9).text_color(t.dim).child(u?.updated ? `${ago(u.updated, now)} 갱신` : "사용량 기록 없음"))))
      .child(this.gauge(week, now, t));
  }

  codexCard(now, t) {
    const c = this.codex, week = c?.seven_day;
    if (narrow()) return this.compact("CX", week, t, false);
    return v_flex().gap(6).px(9).py(8).rounded(8).bg(t.raised ?? t.background).border_1().border_color(t.border)
      .child(h_flex().gap(7).items_center()
        .child(this.badge("C", false, t))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(10.5).font_medium().text_color(t.muted).child(`Codex${c?.plan ? ` · ${String(c.plan).toUpperCase()}` : ""}`))
          .child(div().text_size(9).text_color(t.dim).child(c?.updated ? `${ago(c.updated, now)} 세션 기준` : "최근 Codex 세션 없음")))
        .child(div().px(7).py(1).rounded_full().border_1().border_color(t.border).text_size(9).text_color(t.dim).child("보기 전용")))
      .child(this.gauge(week, now, t));
  }

  render(_cx) {
    const t = theme(), now = Date.now(), list = this.status?.accounts ?? [];
    return v_flex().id("claude-accounts").size_full().min_h(0).overflow_y_scrollbar().p(7).gap(6).bg(t.background).text_color(t.foreground)
      .child(this.heading("Claude 사용량", CLAUDE, t))
      .children(list.map((a) => this.account(a, now, t)))
      .child(div().h(1).mx(2).my(2).bg(t.border))
      .child(this.heading("Codex", CODEX, t))
      .child(this.codexCard(now, t))
      .when(Boolean(this.refreshError), (e) => e.child(div().px(2).text_size(9.5).text_color(t.ansi1 ?? t.blocked).child(this.refreshError)));
  }
}
