import { CONTRACT_VERSION as CONTRACT } from './contract.js';
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, readTextFile, watchFolder, terminals, spaces, shared, setShared, theme, run, notify, playSound, props, closeOverlay, nextCommand } from "herdr";
import { GitTree } from "./git-tree.js";
import { span, timeline, waitReasons } from "./logic.js";
import { decisions, changes, snapshot, seenKey, validSeen, stateLabel, leadTerminal, decisionSignature, leadReport, leadReportKey, decisionInbox, openRequests } from "./attention.js";

// Herdr 하네스 대장을 읽기만 한다. 대장은 각 저장소의 Lead CLI만 쓴다(여기서 쓰면 전이 검사와 충돌한다).
// 세 저장소 공통 계약 v1(.agents/harness/CONTRACT.md): <root>/<config project.state_dir>/{ledger.json,events.jsonl}

const ACTIVE = ["RESEARCHING", "IMPLEMENTING", "QA"];
const ENDED = ["DONE", "FAILED"];
const ORDER = ["BLOCKED", "QA", "IMPLEMENTING", "RESEARCHING", "READY_TO_IMPLEMENT", "QUEUED", "FAILED", "DONE"];
const DAY = 24 * 3600 * 1000;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

// 화면에만 쓰는 한국어 이름. 대장 값(계약 코드값)은 그대로 둔다.
const LABEL = { QUEUED: "대기", RESEARCHING: "조사", READY_TO_IMPLEMENT: "구현 대기", IMPLEMENTING: "구현", QA: "QA", DONE: "QA 통과", BLOCKED: "막힘", FAILED: "실패" };
const STAGE = { research: "조사", architect: "설계 검토", implement: "구현", qa: "QA" };
const AWAIT = { "ac-approval": "AC 승인 대기", decision: "결정 대기", permission: "권한 대기" };
// 진행 막대 4칸: 조사 → 구현 → QA → 완료
const PHASES = ["조사", "구현", "QA", "로컬 QA 통과"];
const PHASE_OF_STATE = { QUEUED: -1, RESEARCHING: 0, READY_TO_IMPLEMENT: 1, IMPLEMENTING: 1, QA: 2, DONE: 3 };
const PHASE_OF_STAGE = { research: 0, architect: 0, implement: 1, qa: 2 };
// spaces 모드와 같은 공간 색
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

const parse = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
const lines = (text) => (text ?? "").split("\n").map(parse).filter(Boolean);
const time = (at) => { const n = Date.parse(at ?? ""); return Number.isNaN(n) ? 0 : n; };
const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  return Date.now() - ms < DAY ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
};
const ago = (ms) => {
  if (!ms) return "";
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return clock(ms);
};
// 실행 중인 단계의 경과 시간. 착수 시각이 없으면 비워 둔다.
const elapsed = (ms) => ms ? span(Date.now() - ms) : "";
// claude-opus-5-5 → opus 5.5. 다른 모델 ID는 그대로 보여 주고, 없으면 CLI 이름을 쓴다.
const modelLabel = (run) => {
  const claude = /^claude-([a-z]+)-(\d+(?:-\d+)*)/.exec(run?.model ?? "");
  return claude ? `${claude[1]} ${claude[2].replaceAll("-", ".")}` : run?.model ?? run?.cli ?? "agent";
};
// #rrggbb에 투명도를 붙인다. 다른 형식은 그대로 쓴다.
const tint = (c, a) => /^#[0-9a-f]{6}$/i.test(c ?? "") ? `${c}${pad(Math.round(a * 255).toString(16))}` : c;
const norm = (p) => (p ?? "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

// 계약 §4·§5 업무를 화면용으로 줄인다.
function normalize(t) {
  const runs = t.runs ?? [];
  // current.run은 runs의 0부터 세는 위치다.
  const run = t.current ? runs[t.current.run] ?? runs.at(-1) : runs.at(-1);
  return {
    ...t,
    id: t.id, title: t.title, state: t.state, stage: t.current?.stage ?? t.pending ?? run?.stage ?? null,
    round: run?.round ?? null, rework: t.rework ?? 0, reason: t.blocked_reason ?? null, awaiting: t.awaiting ?? null,
    resume: t.resume_state ?? null, branch: t.branch ?? null, updated: time(t.updated), archived: Boolean(t.archived),
    run: run && { address: run.address, cli: run.cli, model: run.model, outcome: run.outcome ?? null, live: run.status === "running", started: time(run.started) },
    runs, history: (t.history ?? []).map((h) => ({ at: time(h.at), from: h.from, to: h.to, why: h.why ?? "" })),
  };
}

async function load(project) {
  let empty = { ...project, dir: null, projectId: null, tasks: [], events: [], lead: null, stale: true };
  try {
    const config = parse(await readTextFile(`${project.root}/.agents/harness/config.json`));
    if (!config?.project?.id || !config.project.state_dir) throw new Error("하네스 설정을 읽지 못했습니다");
    const id = config.project.id, dir = `${project.root}/${config.project.state_dir}`;
    empty = { ...empty, dir, projectId: id };
    const observedAt = Date.now();
    const ledger = parse(await readTextFile(`${dir}/ledger.json`));
    if (!ledger) throw new Error("작업 대장을 읽지 못했습니다");
    if (ledger.version !== CONTRACT) throw new Error(`지원하지 않는 계약 v${ledger.version ?? 0}`);
    if (ledger.project !== id) throw new Error("설정과 대장의 프로젝트가 다릅니다");
    if (!ledger.tasks || typeof ledger.tasks !== "object" || Array.isArray(ledger.tasks)) throw new Error("작업 대장 형식이 올바르지 않습니다");
    const rawTasks = Object.values(ledger.tasks);
    if (rawTasks.some((t) => !t?.id || !t.state || !Array.isArray(t.runs) || !Array.isArray(t.history))) throw new Error("업무 기록 형식이 올바르지 않습니다");
    const text = await readTextFile(`${dir}/events.jsonl`).catch(() => null);
    const eventLines = (text ?? "").split("\n").filter((s) => s.trim());
    const partial = text === null || eventLines.some((s) => !parse(s));
    const maxParallel = config.limits?.max_parallel ?? config.limits?.max_parallel_tasks;
    const tasks = rawTasks.map((t) => ({ ...normalize(t), waits: waitReasons(t, ledger, maxParallel, config.git?.overlap_exempt_paths), project: project.name }));
    const events = lines(text).filter((e) => e.event === "state" && e.project === id)
      .map((e) => ({ at: time(e.at), task: e.task, from: e.from, to: e.to, why: e.why ?? "", project: project.name }));
    const inbox = decisionInbox(await readTextFile(`${dir}/decisions.json`).catch(() => undefined), id);
    return { ...project, projectId: id, dir, tasks, events, lead: ledger.lead?.terminal ?? null, note: null, stale: false, observedAt,
      requests: inbox.requests, decisionStatus: inbox.status, decisionNote: inbox.note,
      historyNote: partial ? "사건 이력 일부를 읽지 못해 업무별 이력으로 보완했습니다." : null };
  } catch (e) { return { ...empty, note: String(e.message ?? e) }; }
}

export default class Harness extends View {
  init(_props, cx) {
    this.page = "brief"; this.git = new GitTree();
    this.projects = []; this.open = null; this.showEnded = false; this.seen = null; this.error = null;
    this.allProjects = false; this.expanded = new Set(); this.showChanges = false; this.showTransitions = false;
    this.refresh(cx);
    // 상대 시각("3분 전")과 진행 시간도 이 타이머로 갱신된다.
    cx.timer.every(15000, (cx) => this.refresh(cx));
    cx.timer.every(30000, (cx) => {
      if (this.page === "git") this.git.refresh(this.shown().find((p) => p.root === this.git.root) ?? this.shown()[0], cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "git" || command === "brief") { this.page = command; cx.notify(); }
      }
    });
  }

  // 대장 폴더 변경을 기다렸다가 다시 읽는다. 감시가 끊기면 15초 타이머가 대신한다.
  watch(dir, cx) {
    this.watched ??= new Set();
    if (this.watched.has(dir)) return;
    this.watched.add(dir);
    cx.spawn(async (cx) => {
      try { for (;;) { await watchFolder(dir); this.refresh(cx); } }
      catch { this.watched.delete(dir); }
    });
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const list = parse(await readTextFile(`${appHome()}/mods/harness/projects.json`).catch(() => null));
        if (!Array.isArray(list?.projects)) throw new Error("mods/harness/projects.json을 읽지 못했습니다");
        const loaded = await Promise.all(list.projects.map(load));
        const projects = loaded.map((p) => {
          // 설정 자체를 못 읽으면 동일 폴더의 마지막 자료를 stale로 보존한다. 확인된 다른 ID는 섞지 않는다.
          const previous = this.projects.find((old) => norm(old.root) === norm(p.root) && (p.projectId === null || old.projectId === p.projectId));
          if (p.stale && previous) return { ...previous, stale: true, note: `${p.note} · 마지막 정상 자료 표시` };
          if (p.decisionStatus !== "ready" && previous?.requests?.length) return { ...p, requests: previous.requests, decisionNote: `${p.decisionNote} · 마지막 정상 질문 유지` };
          return p;
        });
        for (const p of projects) if (p.dir) this.watch(p.dir, cx);
        this.alert(projects);
        this.projects = projects; this.error = list ? null : "mods/harness/projects.json을 읽지 못했습니다";
      } catch (e) { this.error = String(e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // 처음 읽은 상태는 기준으로만 삼고, 그 뒤 바뀐 업무만 알린다.
  alert(projects) {
    const now = new Map(projects.filter((p) => !p.stale).flatMap((p) => p.tasks.filter((t) => !t.archived).map((t) => [`${p.root}/${t.id}`, t])));
    if (this.seen) for (const [key, t] of now) {
      const before = this.seen.get(key);
      if (!before || (before.state === t.state && before.signature === decisionSignature(t))) continue;
      // 정상 완료·복구·QA 재작업은 화면에서 묶어 본다. 알림은 새 사람 개입에만 쓴다.
      const level = t.state === "FAILED" ? "error" : t.state === "BLOCKED" ? "warning" : null;
      if (!level) continue;
      const alertKey = `harness.attention.alert.${key}`, signature = decisionSignature(t);
      if (shared(alertKey) === signature) continue;
      setShared(alertKey, signature);
      notify({ title: `${t.id} ${LABEL[t.state] ?? t.state}`, body: `${t.project} · ${t.title ?? ""}${t.reason ? `\n${t.reason}` : ""}`, level, timeout: 8000 });
      playSound("blocked");
    }
    this.seen = new Map([...now].map(([k, t]) => [k, { state: t.state, signature: decisionSignature(t) }]));
  }

  visible(p) {
    return p.tasks
      .filter((t) => !t.archived && t.state !== "BLOCKED" && (this.showEnded || !ENDED.includes(t.state)))
      .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.updated - a.updated);
  }

  color(state, t) {
    if (ACTIVE.includes(state)) return t.working;
    return { BLOCKED: t.blocked, DONE: t.done, FAILED: t.ansi1, READY_TO_IMPLEMENT: t.accent }[state] ?? t.dim;
  }

  // 저장소 폴더와 같은 공간의 색을 쓴다. 없으면 순서대로 고른다.
  mark(p, i) {
    // 공간 폴더는 처음 연 위치로 남아 저장소와 다를 수 있어 이름을 먼저 본다.
    const mine = spaces().filter((s) => !s.machine);
    const space = mine.find((s) => s.name === p.name) ?? mine.find((s) => norm(s.folder) === norm(p.root));
    const key = (space && (shared("space.colors") ?? {})[space.id]) ?? ["ansi3", "ansi6", "ansi4", "ansi5", "ansi2"][i % 5];
    return key.startsWith("#") ? key : MARK[key] ?? theme()[key];
  }

  badge(task, color, t) {
    return div().px(7).py(1).flex_none().rounded(5).bg(tint(color, 0.16)).text_size(10.5).font_medium().text_color(color)
      .tooltip(task.state).child(LABEL[task.state] ?? task.state);
  }

  // 조사 → 구현 → QA → 완료. 막힘·실패는 멈춘 칸을 그 색으로 칠한다.
  phases(task, color, t) {
    const stopped = task.state === "BLOCKED" || task.state === "FAILED";
    const at = stopped ? PHASE_OF_STATE[task.resume] ?? PHASE_OF_STAGE[task.stage] ?? 0 : PHASE_OF_STATE[task.state] ?? -1;
    return h_flex().gap(3).children(PHASES.map((name, i) => div().flex_1().h(3).rounded(2).tooltip(name)
      .bg(i < at || task.state === "DONE" ? tint(t.done, 0.7) : i === at ? color : t.border)));
  }

  task(p, task, live, t) {
    const key = `${p.name}/${task.id}`, opened = this.open === key, color = this.color(task.state, t);
    const term = task.run?.address ? live.get(task.run.address) : null;
    const step = [STAGE[task.stage] ?? task.stage, task.round ? `${task.round}회차` : null, task.rework ? `재작업 ${task.rework}` : null].filter(Boolean);
    const waiting = task.awaiting ? AWAIT[task.awaiting] ?? task.awaiting : null;
    const ended = ENDED.includes(task.state);
    // 실행 중이면 단계 경과 시간, 끝났으면 마지막 변경, 그 밖에는 현재 상태에 들어온 뒤 기다린 시간이다.
    const timing = task.run?.live && task.run.started ? elapsed(task.run.started)
      : ended || task.run?.live ? ago(task.updated)
      : `대기 ${elapsed(task.history.at(-1)?.at || task.updated)}`;
    return v_flex().id(`task-${key}`).flex_none().px(10).py(8).gap(6).rounded(8).cursor_pointer()
      .bg(opened ? t.selected : t.background).border_1().border_color(opened ? t.border : t.background)
      .hover((s) => s.bg(opened ? t.selected : t.hover))
      .when(ended && !opened, (e) => e.opacity(0.7))
      .on_click((_e, cx) => { this.open = opened ? null : key; cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_medium().text_size(12.5).child(task.title ?? task.id))
        .child(this.badge(task, color, t)))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_none().text_color(t.muted).font_family("JetBrainsMono Nerd Font Mono").child(task.id))
        .children(step.map((s) => div().flex_none().child(`· ${s}`)))
        .child(div().flex_1())
        .child(div().flex_none().child(timing))
        .when(Boolean(term), (e) => e.child(h_flex().id(`go-${key}`).flex_none().gap(4).items_center().px(6).py(1).rounded(5)
          .bg(t.raised).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip("에이전트 터미널로 이동")
          .on_click((_e, cx) => { cx.stop_propagation(); run("agent.focus", { terminal: term.address }); })
          .child(div().size(6).rounded_full().bg(term.status === "working" ? t.working : t.dim))
          .child(modelLabel(task.run)))))
      .child(this.phases(task, color, t))
      .when(Boolean(waiting || task.reason), (e) => e.child(v_flex().gap(2).pl(8).py(2).border_l(2).border_color(t.blocked).text_size(11)
        .when(Boolean(waiting), (e) => e.child(div().font_medium().text_color(t.blocked).child(waiting)))
        .when(Boolean(task.reason), (e) => e.child(div().text_color(t.muted).child(task.reason)))))
      .when(Boolean(task.waits), (e) => e.child(this.waits(task, t)))
      .when(opened, (e) => e.child(this.detail(task, t)));
  }

  // 왜 기다리는지 보여 준다. 사람 결정이 필요한 막힘과 구분되게 강조하지 않는다.
  waits(task, t) {
    const rows = task.waits.length ? task.waits : [{ text: "막는 조건 없음 · Lead 위임 차례" }];
    return v_flex().gap(2).pl(8).py(2).border_l(2).border_color(t.border).text_size(11).text_color(t.muted)
      .children(rows.map((w) => div().truncate().when(Boolean(w.tip), (e) => e.tooltip(w.tip)).child(w.text)));
  }

  // 실행별 소요 시간. 재작업이 어디서 시간을 쓰는지 단계별 합계와 함께 보여 준다.
  runs(task, t) {
    const { rows, totals } = timeline(task.runs, Date.now());
    const tone = { good: t.done, warn: t.blocked, bad: t.ansi1, live: t.working };
    return v_flex().gap(3).pb(2)
      .child(div().text_color(t.muted).font_medium().child(totals.map((x) => `${STAGE[x.stage] ?? x.stage} ${span(x.ms)}`).join(" · ")))
      .children(rows.map((r) => h_flex().gap(8).items_center().when(Boolean(r.note), (e) => e.tooltip(r.note))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child([STAGE[r.stage] ?? r.stage, r.round ? `${r.round}회차` : null].filter(Boolean).join(" ")))
        .child(div().flex_none().text_color(t.dim).child(span(r.ms)))
        .child(div().flex_none().w(64).truncate().text_color(tone[r.tone] ?? t.dim).child(r.result))));
  }

  detail(task, t) {
    const rows = task.history.slice(-8).reverse();
    const meta = [
      task.branch && ["git-branch", task.branch],
      task.run?.model && ["terminal", `${task.run.cli ?? ""} ${task.run.model}`.trim()],
      task.run?.outcome && ["circle-check", `최근 판정 ${task.run.outcome}`],
    ].filter(Boolean);
    return v_flex().gap(6).pt(6).border_t(1).border_color(t.border).text_size(11)
      .when(task.state === "DONE", (e) => e.child(div().text_color(t.muted).child("로컬 독립 QA 통과 · 커밋·PR·병합·배포는 별도 확인")))
      .children(meta.map(([icon, text]) => h_flex().gap(6).items_center().text_color(t.muted)
        .child(svg(ICON(icon)).size(12).flex_none().text_color(t.dim))
        .child(div().min_w(0).truncate().child(text))))
      .when(task.runs.length > 0, (e) => e.child(this.runs(task, t)))
      .when(rows.length > 0, (e) => e.child(v_flex().gap(0).pt(2)
        .children(rows.map((h, i) => h_flex().gap(8).items_start()
          .child(v_flex().w(10).flex_none().items_center().pt(4)
            .child(div().size(6).rounded_full().bg(i === 0 ? this.color(h.to, t) : t.dim))
            .when(i < rows.length - 1, (e) => e.child(div().w(1).h(18).bg(t.border))))
          .child(v_flex().flex_1().min_w(0).pb(4)
            .child(h_flex().gap(6)
              .child(div().flex_none().text_color(t.dim).child(clock(h.at)))
              .child(div().flex_none().text_color(i === 0 ? t.foreground : t.muted).child(`${LABEL[h.from] ?? h.from ?? "—"} → ${LABEL[h.to] ?? h.to}`)))
            .when(Boolean(h.why), (e) => e.child(div().text_color(t.dim).truncate().child(h.why))))))));
  }

  project(p, i, live, t) {
    const tasks = this.visible(p), counts = {};
    for (const task of p.tasks) if (!task.archived) counts[task.state] = (counts[task.state] ?? 0) + 1;
    const lead = p.lead ? live.get(p.lead) : null;
    const fill = this.mark(p, i);
    return v_flex().flex_none().gap(4).p(6).rounded(10).bg(t.raised)
      .child(h_flex().h(28).px(4).gap(8).items_center()
        .child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff")
          .child([...p.name][0]?.toUpperCase() ?? "?"))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12.5).child(p.name))
        .children(["BLOCKED", ...ACTIVE, "READY_TO_IMPLEMENT", "QUEUED"].filter((s) => counts[s]).map((s) =>
          div().flex_none().px(6).rounded(5).bg(tint(this.color(s, t), 0.14)).text_size(10.5).text_color(this.color(s, t)).child(`${LABEL[s]} ${counts[s]}`)))
        .when(Boolean(p.lead), (e) => e.child(div().size(7).flex_none().rounded_full()
          .bg(lead ? (lead.status === "working" ? t.working : t.done) : t.border)
          .tooltip(lead ? `Lead ${p.lead} · ${lead.status ?? "실행 중"}` : `Lead ${p.lead} · 꺼짐`))))
      .when(Boolean(p.note), (e) => e.child(div().px(6).pb(4).text_size(11).text_color(t.dim).child(p.note)))
      .when(!p.note && !tasks.length, (e) => e.child(h_flex().px(6).pb(4).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(svg(ICON("check")).size(12).flex_none()).child("진행 중인 업무 없음")))
      .children(tasks.map((task) => this.task(p, task, live, t)));
  }

  // 선택된 공간의 저장소만 보인다. 맞는 저장소가 없는 공간에서는 harness-auto가 패널을 숨긴다. 알림은 세 저장소 모두 계속 받는다.
  shown() {
    if (this.allProjects) return this.projects;
    const space = spaces().find((s) => s.active && !s.machine);
    // 공간 folder는 처음 만든 위치로 남아 다른 저장소를 가리킬 수 있어 이름만 본다(harness-auto와 같은 판정).
    const match = space && this.projects.find((p) => p.name === space.name);
    return match ? [match] : [];
  }

  button(id, label, action, t) {
    return div().id(id).px(8).py(4).rounded(5).flex_none().cursor_pointer().border_1().border_color(t.border)
      .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }

  leadButton(p, task, live, t, suffix) {
    const lead = !p.stale && leadTerminal(p, live, task);
    return lead ? this.button(`lead-${suffix}`, "Lead에서 결정하기 ↗", () => run("agent.focus", { terminal: lead.address }), t)
      : div().text_size(11).text_color(t.dim).child(p.stale ? "자료 갱신 후 Lead 이동 가능" : `Lead 연결 없음${task?.x_lead ?? p.lead ? ` · ${task?.x_lead ?? p.lead}` : ""}`);
  }

  section(title, count, color, t) {
    return h_flex().gap(6).items_center().pt(4).pb(2)
      .child(div().font_semibold().text_size(12).child(title))
      .child(div().text_size(11).text_color(color ?? t.dim).child(String(count)));
  }

  leadReportCard(p, report, t) {
    return v_flex().flex_none().min_w(0).p(12).gap(7).rounded(8).bg(t.raised).border_1().border_color(t.accent)
      .child(h_flex().gap(6).items_center()
        .child(div().font_medium().text_size(11).text_color(t.accent).child("Lead 응답 확인"))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child(report.activity)))
      .child(div().text_size(12).child(report.text))
      .child(div().text_size(10.5).text_color(t.dim).child(`${p.name} · ${report.address}${report.retained ? " · 마지막 수신 응답" : ""}`))
      .when(Boolean(report.progress), (e) => e.child(div().text_size(11).text_color(t.muted).child(`진행 상태: ${report.progress}`)))
      .child(div().text_size(10.5).text_color(t.muted).child("질문별 답변·해소 여부는 대화에서 확인하세요."))
      .child(h_flex().child(this.button(`lead-report-${p.name}`, "Lead에서 확인하기 ↗", () => run("agent.focus", { terminal: report.address }), t)));
  }

  requestCard(p, request, live, t) {
    return v_flex().flex_none().min_w(0).p(12).gap(7).rounded(8).bg(t.raised).border_1().border_color(t.blocked)
      .child(div().text_size(10.5).text_color(t.blocked).child(`답변 대기 · ${request.id}`))
      .child(div().font_semibold().text_size(12.5).child(request.question))
      .child(div().text_size(10.5).text_color(t.dim).child(`${p.name}${request.task ? ` · ${request.task}` : " · 업무 등록 전 질문"}`))
      .when(Boolean(request.reason), (e) => e.child(div().text_size(11).text_color(t.muted).child(request.reason)))
      .children(request.options.map((option) => div().text_size(11).child(`• ${option.label}${option.impact ? ` — ${option.impact}` : ""}`)))
      .when(Boolean(request.recommendation), (e) => e.child(div().text_size(11).text_color(t.accent).child(`Lead 추천: ${request.recommendation}`)))
      .child(div().text_size(10.5).text_color(t.dim).child(`출처: ${request.source}`))
      .when(p.stale || p.decisionStatus !== "ready", (e) => e.child(div().text_size(10.5).text_color(t.blocked).child("마지막 정상 기록 · 현재 해소 여부 확인 필요")))
      .child(h_flex().child(this.leadButton(p, null, live, t, `request-${p.name}-${request.id}`)));
  }

  decisionCard(p, d, live, t) {
    const key = `decision-${p.name}-${d.task.id}`;
    return v_flex().flex_none().min_w(0).p(12).gap(7).rounded(8).bg(t.raised).border_1().border_color(t.blocked)
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(10.5).font_medium().text_color(t.blocked).child(d.kind))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child(ago(d.since))))
      .child(div().font_semibold().text_size(12.5).child(d.task.title ?? d.task.id))
      .child(div().text_size(10.5).text_color(t.dim).child(`${p.name} · ${d.task.id}`))
      .child(div().text_size(12).text_color(t.foreground).child(d.reason))
      .when(Boolean(d.question && d.question !== d.reason), (e) => e.child(div().text_size(11).text_color(t.muted).child(d.question)))
      .child(div().text_size(11).text_color(t.muted).child(d.affected.length
        ? `이 업무를 기다리는 후속 ${d.affected.length}건 · ${d.affected.map((x) => x.id).join(", ")}` : "직접 연결된 후속 대기 업무 없음"))
      .child(div().text_size(11).text_color(t.dim).child("선택지·추천·선택별 영향: 대장에 미기록 · Lead에서 확인"))
      .child(div().text_size(11).text_color(t.dim).child("답하기 전: 이 업무의 대기 상태 유지"))
      .child(h_flex().flex_wrap().gap(6).items_center()
        .child(this.leadButton(p, d.task, live, t, key))
        .child(this.button(`more-${key}`, this.expanded.has(key) ? "근거 접기" : "근거 보기", (cx) => {
          this.expanded.has(key) ? this.expanded.delete(key) : this.expanded.add(key); cx.notify();
        }, t)))
      .when(this.expanded.has(key), (e) => e.child(this.detail(d.task, t)));
  }

  changeCard(p, r, t) {
    const key = `change-${p.name}-${r.id}`, expanded = this.expanded.has(key);
    const color = r.kind === "qa" ? t.done : ["failed", "rework", "decision", "blocked"].includes(r.kind) ? t.blocked : t.muted;
    const body = r.body || `${stateLabel(r.from) ?? "—"} → ${stateLabel(r.to)}`;
    return v_flex().id(`more-${key}`).flex_none().min_w(0).px(10).py(7).gap(3).rounded(8).bg(t.raised)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { expanded ? this.expanded.delete(key) : this.expanded.add(key); cx.notify(); })
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11).font_medium().text_color(color).child(r.title))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child(`${clock(r.at)}  ${expanded ? "▾" : "▸"}`)))
      .child(div().min_w(0).truncate().font_medium().text_size(12).tooltip(r.task.title ?? r.task.id).child(r.task.title ?? r.task.id))
      .child(div().text_size(10.5).text_color(t.dim).child(this.allProjects ? `${p.name} · ${r.task.id}` : r.task.id))
      .when(expanded, (e) => e
        .child(div().text_size(11).text_color(t.muted).child(body))
        .when(r.kind === "qa", (e) => e.child(div().text_size(10.5).text_color(t.dim).child("커밋·PR·병합·배포는 별도 확인")))
        .child(this.detail(r.task, t)));
  }

  changeReadTools(p, t) {
    const seen = validSeen(shared(seenKey(p))), records = changes(p, seen);
    return h_flex().flex_wrap().gap(6).items_center()
      .when(this.allProjects, (e) => e.child(div().text_size(11).text_color(t.muted).child(p.name)))
      .child(div().text_size(10.5).text_color(t.dim).child(p.stale ? "갱신 실패 · 확인 기준 유지" : seen ? `${ago(seen.at)} 확인` : "최근 24시간"))
      .when(!p.stale && !this.error, (e) => e.child(this.button(`read-${p.name}`, records.length ? `변화 ${records.length}건 모두 읽음` : "현재까지 확인", () => {
        // 화면에 적재된 변화만 읽음 처리하며 결정함과 업무 상태는 바꾸지 않는다.
        setShared(seenKey(p), snapshot(p, Date.now(), shared(seenKey(p))));
      }, t).tooltip("접힌 변화를 포함해 이 저장소의 변화를 모두 확인합니다. 승인하거나 업무를 재개하지 않습니다.")));
  }

  attention(shown, live, t) {
    const requests = shown.flatMap((p) => openRequests(p).map((request) => ({ p, request })));
    const inbox = shown.flatMap((p) => decisions(p).map((d) => ({ p, d })))
      .sort((a, b) => b.d.affected.length - a.d.affected.length || (b.d.task.priority ?? 0) - (a.d.task.priority ?? 0) || a.d.since - b.d.since);
    const updates = shown.flatMap((p) => changes(p, shared(seenKey(p))).map((r) => ({ p, r }))).sort((a, b) => b.r.at - a.r.at);
    const reports = shown.map((p) => {
      const key = leadReportKey(p), previous = shared(key), report = leadReport(p, live, previous);
      // 다른 작업이 시작돼도 직전 응답을 참고할 수 있다. 읽음·승인·미해결 상태로 저장하지 않는다.
      if (report.remember && JSON.stringify(report.remember) !== JSON.stringify(previous)) setShared(key, report.remember);
      return { p, report };
    });
    const reportCount = reports.filter(({ report }) => report.available).length;
    return v_flex().flex_none().gap(8)
      .child(this.section("내 결정·확인", `질문 ${requests.length} · 막힘 ${inbox.length} · 보고 ${reportCount}`, t.blocked, t))
      .children(shown.filter((p) => p.note || p.historyNote).map((p) => div().px(2).text_size(11).text_color(t.blocked).child(`${p.name} · ${p.note ?? p.historyNote}`)))
      .children(requests.map(({ p, request }) => this.requestCard(p, request, live, t)))
      .children(shown.filter((p) => p.decisionNote).map((p) => div().px(2).text_size(11).text_color(t.muted).child(`${p.name} · ${p.decisionNote}`)))
      .children(reports.map(({ p, report }) => report.available ? this.leadReportCard(p, report, t)
        : div().px(2).text_size(11).text_color(t.dim).child(`${p.name} · ${report.reason}`)))
      .when(!inbox.length && !requests.length, (e) => e.child(div().px(2).text_size(11).text_color(t.muted).child(shown.some((p) => p.stale) ? "최신 결정 대장을 확인할 수 없습니다." : "작업 대장에 등록된 막힘은 없습니다.")))
      .children(inbox.map(({ p, d }) => this.decisionCard(p, d, live, t)))
      .child(h_flex().flex_wrap().gap(6).items_center()
        .child(this.section("알아둘 변화", updates.length, t.muted, t))
        .child(div().flex_1())
        .when(shown.length === 1, (e) => e.child(this.changeReadTools(shown[0], t))))
      .when(shown.length > 1, (e) => e.children(shown.map((p) => this.changeReadTools(p, t))))
      .when(!updates.length, (e) => e.child(div().p(10).text_size(11).text_color(t.dim).child("새로운 중요한 변화가 없습니다.")))
      .children((this.showChanges ? updates : updates.slice(0, 3)).map(({ p, r }) => this.changeCard(p, r, t)))
      .when(updates.length > 3, (e) => e.child(h_flex().child(this.button("harness-more-changes", this.showChanges ? "최근 3건만 보기" : `나머지 ${updates.length - 3}건 보기`, (cx) => {
        this.showChanges = !this.showChanges; cx.notify();
      }, t))));
  }

  render(cx) {
    const t = theme(), overlay = props()?.overlay;
    const live = new Map(terminals().filter((x) => x.state === "live").map((x) => [x.address, x]));
    const shown = this.shown();
    const recent = shown.flatMap((p) => p.events).sort((a, b) => b.at - a.at).slice(0, 5);
    const all = shown.flatMap((p) => p.tasks.filter((x) => !x.archived));
    const active = all.filter((x) => ACTIVE.includes(x.state)).length, blocked = all.filter((x) => x.state === "BLOCKED").length;
    const summary = [active && `진행 ${active}`, blocked && `막힘 ${blocked}`].filter(Boolean).join(" · ") || "대기 중";
    return v_flex().id("harness").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(44).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON("layers")).size(15).flex_none().text_color(t.muted))
        .child(div().font_semibold().text_size(13.5).child(this.page === "git" ? "Git Tree" : "내 작업 브리핑"))
        .child(div().text_size(11).text_color(blocked ? t.blocked : t.dim).child(summary))
        .child(div().flex_1())
        .when(this.loading, (e) => e.child(svg(ICON("spinner")).size(12).flex_none().text_color(t.dim)))
        .child(this.button("harness-scope", this.allProjects ? "전체 저장소" : "현재 저장소", (cx) => { this.allProjects = !this.allProjects; cx.notify(); }, t))
        .when(Boolean(overlay), (e) => e.child(div().id("harness-close").px(6).cursor_pointer().text_color(t.dim).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => closeOverlay(overlay)).child("✕"))))
      .child(h_flex().flex_none().px(8).py(7).gap(4).border_b(1).border_color(t.border)
        .children([["brief", "브리핑"], ["git", "Git Tree"]].map(([page, title]) =>
          div().id(`harness-tab-${page}`).flex_1().py(6).rounded(6).cursor_pointer().text_size(11.5).font_medium()
            .bg((this.page ?? "brief") === page ? t.selected : t.background).text_color((this.page ?? "brief") === page ? t.foreground : t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.page = page; cx.notify(); })
            .child(h_flex().justify_center().items_center().gap(6)
              .child(svg(ICON(page === "git" ? "git-branch" : "layers")).size(12)).child(title)))))
      .when(this.page === "git", (e) => e.child(this.git.render(shown, cx)))
      .when(this.page !== "git", (e) => e.child(v_flex().id("harness-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(8)
        .when(Boolean(this.error), (e) => e.child(div().px(8).text_color(t.ansi1).child(this.error)))
        .when(!this.error && this.projects.length > 0 && !shown.length, (e) => e.child(div().px(8).text_size(11).text_color(t.dim).child("이 공간에 연결된 하네스 저장소가 없습니다")))
        .when(shown.length > 0, (e) => e
          .child(h_flex().items_center().gap(6)
            .child(this.section("진행 중", all.filter((x) => !ENDED.includes(x.state) && x.state !== "BLOCKED").length, t.working, t))
            .child(div().flex_1())
            .child(this.button("harness-ended", this.showEnded ? "종료 숨기기" : "종료 포함", (cx) => { this.showEnded = !this.showEnded; cx.notify(); }, t)))
          .children(shown.map((p) => this.project(p, this.projects.indexOf(p), live, t)))
          .child(this.attention(shown, live, t).pt(8).border_t(1).border_color(t.border))
          .child(h_flex().pt(4).child(this.button("harness-transitions", this.showTransitions ? "최근 전이 접기" : "최근 전이 보기", (cx) => { this.showTransitions = !this.showTransitions; cx.notify(); }, t)))
          .when(this.showTransitions, (e) => e.child(v_flex().flex_none().px(6).py(6).gap(4).text_size(11)
        .when(!recent.length, (e) => e.child(div().text_color(t.dim).child("없음")))
        .children(recent.map((ev) => h_flex().gap(8).items_center()
          .child(div().w(36).flex_none().text_color(t.dim).child(clock(ev.at)))
          .child(div().flex_none().text_color(t.muted).font_family("JetBrainsMono Nerd Font Mono").child(ev.task ?? ""))
          .child(div().flex_none().text_color(t.dim).child(LABEL[ev.from] ?? ev.from ?? "—"))
          .child(div().flex_none().text_color(t.dim).child("→"))
          .child(div().flex_none().font_medium().text_color(this.color(ev.to, t)).child(LABEL[ev.to] ?? ev.to))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).tooltip(ev.why).child(ev.why)))))))));
  }
}
