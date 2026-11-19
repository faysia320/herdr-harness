import { CONTRACT_VERSION as CONTRACT } from './contract.js';
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, exec, readTextFile, watchFolder, terminals, spaces, panes, machines, shared, setShared, theme, run, notify, playSound, props, closeOverlay, hc } from "herdr";
import { span, timeline, waitReasons, ledgerCapacityNote, answerKey, answerMessage, instructionMessage, workflowPhase, workflowLabel, v2Stages, v2Progress } from "./logic.js";
import { closedByDecision, decisions, pausedTasks, importantRecords, changes, snapshot, recordSnapshot, seenKey, validSeen, stateLabel, leadTerminal, decisionSignature, leadReport, decisionInbox, openRequests, waitingOn } from "./attention.js";
import { briefingContext, taskActivity, needsTerminal } from "./context.js";

// Herdr 하네스 대장을 읽기만 한다. 대장은 각 저장소의 Lead CLI만 쓴다(여기서 쓰면 전이 검사와 충돌한다).
// 세 저장소 공통 계약 v1(.agents/harness/CONTRACT.md): <root>/<config project.state_dir>/{ledger.json,events.jsonl}

const ENDED = ["DONE", "FAILED"];
const ORDER = ["BLOCKED", "QA", "IMPLEMENTING", "RESEARCHING", "READY_TO_IMPLEMENT", "QUEUED", "FAILED", "DONE"];
const DAY = 24 * 3600 * 1000;
const showsLocalResources = context => !context.machine && (context.kind === "basic" || context.kind === "harness");
// 조회가 이보다 오래 끝나지 않으면 멈춘 것으로 보고 다음 주기에 다시 읽는다.
const STUCK = 30000;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

// 화면에만 쓰는 한국어 이름. 대장 값(계약 코드값)은 그대로 둔다.
const LABEL = { QUEUED: "대기", RESEARCHING: "조사", READY_TO_IMPLEMENT: "구현 대기", IMPLEMENTING: "구현", QA: "QA", DONE: "QA 통과", BLOCKED: "막힘", FAILED: "실패" };
const STAGE = { research: "조사", architect: "설계 검토", implement: "구현", qa: "QA", publish: "PR 게시", ci: "CI", merged: "병합" };
const AWAIT = { "ac-approval": "AC 승인 대기", decision: "결정 대기", permission: "권한 대기" };
// 진행 막대 4칸: 조사 → 구현 → QA → 완료
const PHASES = ["조사", "구현", "QA", "로컬 QA 통과"];
const PHASE_OF_STATE = { QUEUED: -1, RESEARCHING: 0, READY_TO_IMPLEMENT: 1, IMPLEMENTING: 1, QA: 2, DONE: 3 };
const PHASE_OF_STAGE = { research: 0, architect: 0, implement: 1, qa: 2 };
const taskLabel = (task) => closedByDecision(task) ? "결정 종결" : workflowLabel(task) ?? LABEL[task.state] ?? task.state;

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
    ticket: typeof t.x_slug === "string" && /^ITSM-\d{4}-\d+$/.test(t.x_slug) ? t.x_slug : null,
    round: run?.round ?? null, rework: t.rework ?? 0, reason: t.blocked_reason ?? null, awaiting: t.awaiting ?? null,
    resume: t.resume_state ?? null, branch: t.branch ?? null, updated: time(t.updated), archived: Boolean(t.archived),
    run: run && { address: run.address, cli: run.cli, model: run.model, outcome: run.outcome ?? null, live: run.status === "running", started: time(run.started) },
    runs, history: (t.history ?? []).map((h) => ({ at: time(h.at), from: h.from, to: h.to, why: h.why ?? "", x_closure: h.x_closure ?? null })),
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
    const ledgerText = await readTextFile(`${dir}/ledger.json`);
    const ledger = parse(ledgerText);
    if (!ledger) throw new Error("작업 대장을 읽지 못했습니다");
    if (ledger.version !== CONTRACT) throw new Error(`지원하지 않는 계약 v${ledger.version ?? 0}`);
    if (ledger.project !== id) throw new Error("설정과 대장의 프로젝트가 다릅니다");
    if (!ledger.tasks || typeof ledger.tasks !== "object" || Array.isArray(ledger.tasks)) throw new Error("작업 대장 형식이 올바르지 않습니다");
    const rawTasks = Object.values(ledger.tasks);
    if (rawTasks.some((t) => !t?.id || !t.state || !Array.isArray(t.runs) || !Array.isArray(t.history))) throw new Error("업무 기록 형식이 올바르지 않습니다");
    const text = await readTextFile(`${dir}/events.jsonl`).catch(() => null);
    const eventLines = (text ?? "").split("\n").filter((s) => s.trim());
    const partial = text === null || eventLines.some((s) => !parse(s));
    let maxParallel = config.limits?.max_parallel ?? config.limits?.max_parallel_tasks;
    let execution, workflow;
    const bindingText = await readTextFile(`${dir}/harness-binding.json`);
    if (bindingText) {
      const binding = parse(bindingText);
      if (!binding || binding.project !== id) throw new Error("실행 정책 연결을 읽지 못했습니다");
      if (binding.adapterConfig) {
        const adapter = parse(await readTextFile(binding.adapterConfig));
        const policy = parse(await readTextFile(`${binding.release.replaceAll('\\', '/')}/policy/execution.json`));
        execution = policy;
        if (adapter?.project?.id !== id || policy?.version !== 1) throw new Error("공통 실행 정책을 읽지 못했습니다");
        maxParallel = adapter.execution_overrides?.limits?.max_parallel ?? policy.limits?.max_parallel;
        if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("공통 실행 한도가 올바르지 않습니다");
      }
      if (typeof binding.release === "string" && rawTasks.some(workflowPhase)) {
        workflow = parse(await readTextFile(`${binding.release.replaceAll('\\', '/')}/policy/workflow.json`).catch(() => null));
      }
    }
    const tasks = rawTasks.map((t) => {
      const task = { ...normalize(t), waits: waitReasons(t, ledger, maxParallel, config.git?.overlap_exempt_paths), project: project.name };
      if (workflowPhase(t)) {
        task.steps = v2Stages(t, execution);
        task.models = task.steps.flatMap((stage) => {
          const model = stage === "publish" ? workflow?.delivery?.publisher?.model : t.overrides?.[stage]?.model ?? workflow?.roles?.[stage]?.model;
          return workflow?.version === 2 && typeof model === "string" && model ? [`${STAGE[stage]} · ${model}`] : [];
        });
      }
      return task;
    });
    const events = lines(text).filter((e) => e.event === "state" && e.project === id)
      .map((e) => ({ at: time(e.at), task: e.task, from: e.from, to: e.to, why: e.why ?? "", x_closure: e.x_closure ?? null, project: project.name }));
    const inbox = decisionInbox(await readTextFile(`${dir}/decisions.json`).catch(() => undefined), id);
    const loaded = { ...project, projectId: id, dir, tasks, events, lead: ledger.lead?.terminal ?? null, note: null, stale: false, observedAt,
      capacityNote: ledgerCapacityNote(ledgerText),
      requests: inbox.requests, decisionStatus: inbox.status, decisionNote: inbox.note,
      historyNote: partial ? "사건 이력 일부를 읽지 못해 업무별 이력으로 보완했습니다." : null };
    // 전체 이력 병합·정렬은 파일 갱신 시 한 번만 하고 렌더·읽음 처리에서 재사용한다.
    loaded.attentionRecords = importantRecords(loaded);
    return loaded;
  } catch (e) { return { ...empty, note: String(e.message ?? e) }; }
}

export default class Harness extends View {
  init(_props, cx) {
    this.projects = []; this.open = null; this.showEnded = false; this.seen = null; this.error = null;
    this.expanded = new Set(); this.showChanges = false; this.changesCollapsed = false;
    this.answers = new Map(); this.typing = null;
    this.selectedAnswers = new Map();
    this.answerInput = InputState.new({ placeholder: "내용 입력 후 보내기 또는 Enter" });
    this.answerInput.on("submit", (_e, cx) => this.submitTyped(cx));
    this.refresh(cx);
    // 시각과 열린 자원 카드는 15초마다, 대장 감시 누락은 60초 전체 조회로 갱신한다.
    cx.timer.every(15000, (cx) => { this.refreshResources(cx); cx.notify(); });
    cx.timer.every(60000, (cx) => this.refresh(cx));
  }

  // 짧은 변경 묶음은 한 번만 읽는다. 읽는 도중 들어온 변경도 후속 조회에 남긴다.
  scheduleRefresh(cx, roots = null) {
    this.pendingRoots ??= new Set();
    if (roots === null) this.pendingFull = true;
    else for (const root of roots) this.pendingRoots.add(norm(root));
    if (this.refreshTimer) return;
    this.refreshTimer = true;
    cx.timer.after(200, (cx) => {
      this.refreshTimer = false;
      if (this.loading) return;
      if (!this.pendingFull && !this.pendingRoots.size) return;
      const roots = this.pendingFull ? null : [...this.pendingRoots];
      this.pendingFull = false; this.pendingRoots.clear();
      this.refresh(cx, roots);
    });
  }

  // 상태·설정 폴더를 감시한다. 제거되거나 경로가 바뀐 프로젝트의 감시는 다음 사건에서 끝난다.
  watch(dir, cx) {
    this.watched ??= new Set();
    if (this.watched.has(dir)) return;
    this.watched.add(dir);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(dir);
          if (norm(dir) === norm(`${appHome()}/mods/harness`)) this.scheduleRefresh(cx);
          else {
            const roots = this.projects.filter((p) => norm(p.dir) === norm(dir) || norm(`${p.root}/.agents/harness`) === norm(dir)).map((p) => p.root);
            if (!roots.length) break;
            this.scheduleRefresh(cx, roots);
          }
        }
      } catch { /* 60초 조회에서 다시 감시한다. */ }
      finally { this.watched.delete(dir); }
    });
  }

  refresh(cx, roots = null) {
    if (this.loading) {
      if (Date.now() - this.loadingSince < STUCK) { this.scheduleRefresh(cx, roots); return; }
      // 호스트 읽기 하나가 끝나지 않으면 이후 갱신이 모두 막힌다. 그 조회는 버리고 전체를 다시 읽는다.
      this.error = "이전 조회가 30초 넘게 끝나지 않아 다시 읽는 중입니다. 표시 자료가 최신이 아닐 수 있습니다.";
      roots = null;
    }
    const targets = roots === null ? null : new Set(roots.map(norm));
    if (targets === null) { this.pendingFull = false; this.pendingRoots?.clear(); }
    const generation = this.generation = (this.generation ?? 0) + 1;
    this.loading = true; this.loadingSince = Date.now();
    cx.spawn(async (cx) => {
      // 버린 조회가 늦게 끝나도 새 자료를 덮어쓰거나 진행 표시를 끄지 않는다.
      const current = () => generation === this.generation;
      try {
        const list = targets === null ? parse(await readTextFile(`${appHome()}/mods/harness/projects.json`).catch(() => null)) : null;
        if (targets === null && !Array.isArray(list?.projects)) throw new Error("mods/harness/projects.json을 읽지 못했습니다");
        if (targets === null && list.projects.some((p) => typeof p?.root !== "string" || !p.root || typeof p.name !== "string" || !p.name)) throw new Error("프로젝트 이름과 저장소 경로가 올바르지 않습니다");
        const loaded = await Promise.all((targets === null ? list.projects : this.projects).map((p) =>
          targets !== null && !targets.has(norm(p.root)) ? p : load({ name: p.name, root: p.root })));
        if (!current()) return;
        const projects = loaded.map((p) => {
          if (targets !== null && !targets.has(norm(p.root))) return p;
          // 설정 자체를 못 읽으면 동일 폴더의 마지막 자료를 stale로 보존한다. 확인된 다른 ID는 섞지 않는다.
          const previous = this.projects.find((old) => norm(old.root) === norm(p.root) && (p.projectId === null || old.projectId === p.projectId));
          if (p.stale && previous) return { ...previous, stale: true, note: `${p.note} · 마지막 정상 자료 표시` };
          if (p.decisionStatus !== "ready" && previous?.requests?.length) return { ...p, requests: previous.requests, decisionNote: `${p.decisionNote} · 마지막 정상 질문 유지` };
          return p;
        });
        this.alert(projects);
        this.projects = projects;
        if (targets === null) this.error = null;
        this.watch(`${appHome()}/mods/harness`, cx);
        for (const p of projects) {
          this.watch(`${p.root}/.agents/harness`, cx);
          if (p.dir) this.watch(p.dir, cx);
        }
      } catch (e) { if (current()) this.error = String(e); }
      finally {
        if (!current()) return;
        this.loading = false; cx.notify();
        if (this.pendingFull || this.pendingRoots?.size) this.scheduleRefresh(cx, []);
      }
    });
  }

  // 처음 읽은 상태는 기준으로만 삼고, 그 뒤 바뀐 업무만 알린다.
  alert(projects) {
    const now = new Map(projects.filter((p) => !p.stale).flatMap((p) => p.tasks.filter((t) => !t.archived).map((t) => [`${p.root}/${t.id}`, { ...t, waiting: waitingOn(t, p) }])));
    if (this.seen) for (const [key, t] of now) {
      const before = this.seen.get(key);
      if (!before || (before.state === t.state && before.signature === decisionSignature(t) && before.waiting === Boolean(t.waiting))) continue;
      // 정상 완료·복구·QA 재작업은 화면에서 묶어 본다. 알림은 새 사람 개입에만 쓴다.
      const level = t.state === "FAILED" ? "error" : t.state === "BLOCKED" && !t.waiting ? "warning" : null;
      if (!level) continue;
      const alertKey = `harness.attention.alert.${key}`, signature = decisionSignature(t);
      if (shared(alertKey) === signature) continue;
      setShared(alertKey, signature);
      notify({ title: `${t.id} ${taskLabel(t)}`, body: `${t.project} · ${t.title ?? ""}${t.reason ? `\n${t.reason}` : ""}`, level, timeout: 8000 });
      playSound("blocked");
    }
    this.seen = new Map([...now].map(([k, t]) => [k, { state: t.state, signature: decisionSignature(t), waiting: Boolean(t.waiting) }]));
  }

  visible(p) {
    return p.tasks
      .filter((t) => !t.archived && (t.state !== "BLOCKED" || waitingOn(t, p)) && (this.showEnded || !ENDED.includes(t.state)))
      .sort((a, b) => this.rank(a, p) - this.rank(b, p) || b.updated - a.updated);
  }

  // 선행 업무를 기다리는 막힘은 위임 대기 업무와 같은 자리에 둔다.
  rank(task, p) {
    return ORDER.indexOf(waitingOn(task, p) ? "READY_TO_IMPLEMENT" : task.state);
  }

  color(state, t) {
    return { RESEARCHING: t.ansi6, IMPLEMENTING: t.ansi4, QA: t.ansi5,
      READY_TO_IMPLEMENT: t.ansi3, QUEUED: t.muted, BLOCKED: t.ansi3,
      DONE: t.ansi2, FAILED: t.ansi1 }[state] ?? t.dim;
  }

  badge(task, color, t, label = taskLabel(task)) {
    return div().px(7).py(1).flex_none().rounded(5).bg(tint(color, 0.16)).text_size(10.5).font_medium().text_color(color)
      .tooltip(task.state).child(label);
  }

  // v2에서는 QA 뒤의 게시·CI·병합도 대장에 기록한 단계까지 칠한다.
  phases(task, color, t) {
    const stopped = task.state === "BLOCKED" || task.state === "FAILED";
    const phase = workflowPhase(task);
    let at = stopped ? PHASE_OF_STATE[task.resume] ?? PHASE_OF_STAGE[task.stage] ?? 0 : PHASE_OF_STATE[task.state] ?? -1;
    const steps = phase ? task.steps.map((stage) => STAGE[stage]) : PHASES;
    if (phase) at = task.steps.indexOf(v2Progress(task));
    return h_flex().gap(3).children(steps.map((name, i) => div().flex_1().h(3).rounded(2).tooltip(name)
      .bg(i < at || (task.state === "DONE" && at === steps.length - 1) ? tint(t.done, 0.7) : i === at ? color : t.border)));
  }

  task(p, task, live, t) {
    // 다른 업무를 기다리는 막힘은 사람 확인 대상이 아니므로 진행 목록에 대기로 둔다.
    const on = waitingOn(task, p), waits = on ? [{ text: `선행 업무 대기: ${on.join(", ")}` }] : task.waits;
    const key = `${p.name}/${task.id}`, opened = this.open === key, color = on ? t.dim : this.color(task.state, t);
    const term = task.run?.address ? live.get(task.run.address) : null;
    const step = [task.round ? `${task.round}회차` : null, task.rework ? `재작업 ${task.rework}` : null].filter(Boolean);
    const activity = taskActivity(task, live, p.projectId);
    const waiting = task.awaiting ? AWAIT[task.awaiting] ?? task.awaiting : null;
    const ended = ENDED.includes(task.state);
    // 실행 중이면 단계 경과 시간, 끝났으면 마지막 변경, 그 밖에는 현재 상태에 들어온 뒤 기다린 시간이다.
    const timing = task.run?.live && task.run.started ? elapsed(task.run.started)
      : ended || task.run?.live ? ago(task.updated)
      : `대기 ${elapsed(task.history.at(-1)?.at || task.updated)}`;
    return v_flex().id(`task-${key}`).flex_none().min_w(0).p(10).gap(6).rounded(8).cursor_pointer()
      .bg(opened ? t.selected : t.raised).border_1().border_color(opened ? t.accent : t.border)
      .hover((s) => s.bg(opened ? t.selected : t.hover))
      .when(ended && !opened, (e) => e.opacity(0.7))
      .on_click((_e, cx) => { this.open = opened ? null : key; cx.notify(); })
      .child(h_flex().gap(8).items_start()
        .child(div().flex_1().min_w(0).whitespace_normal().font_medium().text_size(13).child(task.title ?? task.id))
        .child(this.badge(task, color, t, on ? "선행 대기" : undefined)))
      .child(h_flex().flex_wrap().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_none().text_color(t.muted).font_family("JetBrainsMono Nerd Font Mono").child(task.id))
        .children(step.map((s) => div().flex_none().child(`· ${s}`)))
        .child(div().flex_1())
        .child(div().flex_none().child(timing)))
      .when(Boolean(activity?.text), (e) => e.child(div().text_size(12).text_color(t.muted).whitespace_normal().child(activity.text)))
      .when(Boolean(activity) && ["응답 완료", "대기"].includes(activity.label), (e) => e.child(div().text_size(11).text_color(t.dim).child(`${activity.label} · 단계 결과 수집 여부는 대장에서 확인`)))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(activity?.text ? "에이전트 보고" : "업무 대장"))
        .when(Boolean(term), (e) => e.child(this.button(`go-${key}`, "터미널 ↗", () => run("pane.focus", { terminal: term.address }), t))))
      .when(Boolean(waiting || task.reason), (e) => e.child(v_flex().gap(2).pl(8).py(2).border_l(2).border_color(t.blocked).text_size(11)
        .when(Boolean(waiting), (e) => e.child(div().font_medium().text_color(t.blocked).child(waiting)))
        .when(Boolean(task.reason), (e) => e.child(div().text_color(t.muted).child(task.reason)))))
      .when(Boolean(waits), (e) => e.child(this.waits(waits, t)))
      .when(opened, (e) => e.child(this.detail(task, t)));
  }

  // 왜 기다리는지 보여 준다. 사람 결정이 필요한 막힘과 구분되게 강조하지 않는다.
  waits(waits, t) {
    const rows = waits.length ? waits : [{ text: "막는 조건 없음 · Lead 위임 차례" }];
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
        .child(div().flex_1().min_w(0).whitespace_normal().text_color(t.dim).child([
          [STAGE[r.stage] ?? r.stage, r.round ? `${r.round}회차` : null].filter(Boolean).join(" "),
          workflowPhase(task) && r.model,
        ].filter(Boolean).join(" · ")))
        .child(div().flex_none().text_color(t.dim).child(span(r.ms)))
        .child(div().flex_none().w(64).truncate().text_color(tone[r.tone] ?? t.dim).child(r.result))));
  }

  detail(task, t) {
    const rows = task.history.slice(-8).reverse();
    const phase = workflowPhase(task);
    const delivery = phase && task.x_flow.delivery;
    const historyLabel = (state, event) => phase ? stateLabel(state, task, event) : LABEL[state] ?? state;
    const meta = [
      phase && ["file", [
        `v2 · ${taskLabel(task)}`,
        task.x_flow.verification?.verdict && `최근 검증 ${task.x_flow.verification.verdict}`,
        Number.isInteger(delivery?.pr) && `PR #${delivery.pr}`,
        phase === "merged" && typeof delivery?.merge === "string" && `병합 ${delivery.merge.slice(0, 12)}`,
      ].filter(Boolean).join(" · ")],
      task.branch && ["git-branch", task.branch],
      task.ticket && ["file", task.ticket],
      !phase && task.run?.model && ["terminal", `${task.run.cli ?? ""} ${task.run.model}`.trim()],
      task.run?.outcome && ["circle-check", `최근 판정 ${task.run.outcome}`],
    ].filter(Boolean);
    return v_flex().gap(6).pt(6).border_t(1).border_color(t.border).text_size(11)
      .child(this.phases(task, this.color(task.state, t), t))
      .when(!phase && task.state === "DONE" && !closedByDecision(task), (e) => e.child(div().text_color(t.muted).child("로컬 독립 QA 통과 · 커밋·PR·병합·배포는 별도 확인")))
      .when(closedByDecision(task), (e) => e.child(div().text_color(t.muted).child(`사용자 결정으로 QA r${task.x_closure.qa_round} ${task.x_closure.qa_outcome} 예외 · PR #${task.x_closure.pr} 병합 ${String(task.x_closure.merge_sha ?? "").slice(0, 12)}`))
        .child(div().text_color(t.dim).child(`결정 원문: ${task.x_closure.quote}`)))
      .children(meta.map(([icon, text]) => h_flex().gap(6).items_center().text_color(t.muted)
        .child(svg(ICON(icon)).size(12).flex_none().text_color(t.dim))
        .child(div().min_w(0).truncate().tooltip(text).child(text))))
      .when(Boolean(task.models?.length), (e) => e.child(v_flex().gap(2)
        .child(div().font_medium().text_color(t.muted).child("현재 위임 정책"))
        .children(task.models.map((line) => div().whitespace_normal().text_color(t.dim).child(line)))))
      .when(task.runs.length > 0, (e) => e.child(this.runs(task, t)))
      .when(rows.length > 0, (e) => e.child(v_flex().gap(0).pt(2)
        .children(rows.map((h, i) => h_flex().gap(8).items_start()
          .child(v_flex().w(10).flex_none().items_center().pt(4)
            .child(div().size(6).rounded_full().bg(i === 0 ? this.color(h.to, t) : t.dim))
            .when(i < rows.length - 1, (e) => e.child(div().w(1).h(18).bg(t.border))))
          .child(v_flex().flex_1().min_w(0).pb(4)
            .child(h_flex().gap(6)
              .child(div().flex_none().text_color(t.dim).child(clock(h.at)))
              .child(div().flex_none().text_color(i === 0 ? t.foreground : t.muted).child(`${historyLabel(h.from) ?? "—"} → ${h.x_closure ? "결정 종결" : historyLabel(h.to, h)}`)))
            .when(Boolean(h.why), (e) => e.child(div().text_color(t.dim).truncate().child(h.why))))))));
  }

  project(p, i, live, t) {
    const tasks = this.visible(p);
    return v_flex().flex_none().min_w(0).gap(8)
      .when(!p.note && !tasks.length, (e) => e.child(h_flex().px(6).pb(4).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(svg(ICON("check")).size(12).flex_none()).child("진행 중인 업무 없음")))
      .children(tasks.map((task) => this.task(p, task, live, t)));
  }

  // 공간 생성 당시 folder보다 첫 터미널의 현재 경로를 우선한다.
  currentProject() {
    return this.context().project;
  }

  context() {
    return briefingContext({ spaces: spaces(), panes: panes(), terminals: terminals(), machines: machines(), projects: this.projects ?? [] });
  }

  shown() {
    const current = this.currentProject();
    if (!current) return [];
    return [current];
  }

  button(id, label, action, t) {
    return div().id(id).px(8).py(4).rounded(5).flex_none().cursor_pointer().border_1().border_color(t.border)
      .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }

  leadButton(p, task, live, t, suffix) {
    const lead = !p.stale && !this.error && leadTerminal(p, live, task);
    return lead ? this.button(`lead-${suffix}`, "Lead 열기 ↗", () => run("agent.focus", { terminal: lead.address }), t)
      : div().text_size(11).text_color(t.dim).child(p.stale ? "자료 갱신 후 Lead 이동 가능" : `Lead 연결 없음${task?.x_lead ?? p.lead ? ` · ${task?.x_lead ?? p.lead}` : ""}`);
  }

  section(title, count, color, t) {
    return h_flex().gap(6).items_center().pt(4).pb(2)
      .child(div().font_semibold().text_size(12).child(title))
      .child(div().text_size(11).text_color(color ?? t.dim).child(String(count)));
  }

  requestCard(p, request, live, t) {
    return v_flex().flex_none().min_w(0).p(12).gap(7).rounded(8).bg(t.raised).border_1().border_color(t.blocked)
      .child(div().text_size(10.5).text_color(t.blocked).child(`답변 대기 · ${request.id}`))
      .child(div().whitespace_normal().font_semibold().text_size(12.5).child(request.question))
      .child(div().text_size(10.5).text_color(t.dim).child(`${p.name}${request.task ? ` · ${request.task}` : " · 업무 등록 전 질문"}`))
      .when(Boolean(request.reason), (e) => e.child(div().whitespace_normal().text_size(11).text_color(t.muted).child(request.reason)))
      .when(Boolean(request.recommendation) && !request.options.some((o) => o.label === request.recommendation), (e) => e.child(div().text_size(11).text_color(t.accent).child(`Lead 추천: ${request.recommendation}`)))
      .child(div().whitespace_normal().text_size(10.5).text_color(t.dim).child(`출처: ${request.source}`))
      .when(p.stale || p.decisionStatus !== "ready", (e) => e.child(div().text_size(10.5).text_color(t.blocked).child("마지막 정상 기록 · 현재 해소 여부 확인 필요")))
      .child(this.answerRow(p, request, live, t))
      .child(h_flex().child(this.leadButton(p, null, live, t, `request-${p.name}-${request.id}`)));
  }

  // 카드에서 고른 답은 Lead 터미널로만 전한다. 결정함 해소 기록은 Lead CLI가 한다.
  answerRow(p, request, live, t) {
    this.answers ??= new Map();
    this.selectedAnswers ??= new Map();
    const key = answerKey(p, request), sent = this.answers.get(key), id = `${p.name}-${request.id}`;
    const lead = !p.stale && !this.error && p.decisionStatus === "ready" && leadTerminal(p, live, null);
    const chosen = this.selectedAnswers.get(key);
    if (sent?.status === "sending") return div().text_size(11).text_color(t.muted).child(`Lead에 답 전달 중: ${sent.answer}`);
    if (sent?.status === "sent") return div().text_size(11).text_color(t.accent).child(`전달됨 · Lead 기록 대기 — ${sent.answer}`);
    // 입력 상태는 init에서 하나만 만들 수 있다. 직접 입력은 한 번에 한 카드에서만 연다.
    const typing = this.answerInput && this.typing?.key === key;
    if (typing) this.typing = { key, p, request, lead };
    return v_flex().gap(6)
      .when(sent?.status === "failed", (e) => e.child(div().text_size(10.5).text_color(t.blocked).child(`전달 실패: ${sent.error} — 다시 시도하세요.`)))
      .children(request.options.map((option, i) => v_flex().id(`answer-${id}-${i}`).w_full().min_w(0).px(10).py(8).gap(4).rounded(6)
        .bg(chosen === option.label ? t.selected : t.background).border_1().border_color(chosen === option.label ? t.accent : t.border)
        .when(Boolean(lead), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => {
          cx.stop_propagation(); this.selectedAnswers.set(key, option.label); this.typing = null; cx.notify();
        }))
        .child(h_flex().gap(7).items_start()
          .child(div().flex_1().min_w(0).whitespace_normal().text_size(12).font_medium().child(option.label))
          .when(request.recommendation === option.label, (e) => e.child(div().flex_none().text_size(11).text_color(t.accent).child("Lead 추천"))))
        .when(Boolean(option.impact), (e) => e.child(div().min_w(0).whitespace_normal().text_size(11).text_color(t.muted).child(option.impact)))))
      .when(!lead, (e) => e.child(div().text_size(11).text_color(t.dim).child("Lead가 연결되고 결정함이 최신일 때 여기서 답할 수 있습니다.")))
      .when(Boolean(lead), (e) => e.child(h_flex().gap(6).flex_wrap()
        .when(Boolean(chosen) && !typing, (e) => e.child(this.button(`answer-${id}-send`, "선택한 답변 보내기", (cx) => this.answer(p, request, lead, chosen, cx), t)))
        .when(Boolean(this.answerInput) && !typing, (e) => e.child(this.button(`answer-${id}-type`, "직접 입력…", (cx) => {
          this.answerInput.set_value(""); this.typing = { key, p, request, lead }; this.answerInput.focus(); cx.notify();
        }, t)))))
      .when(typing, (e) => e.child(h_flex().gap(6).items_center()
        .child(div().id(`answer-${id}-input`).flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(5).border_1().border_color(t.accent)
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.answerInput).h_full().text_size(11.5).text_color(t.foreground)))
        .child(this.button(`answer-${id}-text`, "보내기", (cx) => this.submitTyped(cx), t))
        .child(this.button(`answer-${id}-cancel`, "취소", (cx) => { this.typing = null; cx.notify(); }, t))));
  }

  submitTyped(cx) {
    const target = this.typing, value = this.answerInput?.value() ?? "";
    if (!target || !value.trim()) return;
    this.typing = null; this.answerInput.set_value("");
    if (target.kind === "instruction") { this.sendInstruction(target.p, target.d, target.lead, value, cx); return; }
    this.answer(target.p, target.request, target.lead, value, cx);
  }

  instructionKey(p, d) {
    return JSON.stringify([p.root, p.projectId, d.task.id, d.signature]);
  }

  instructionRow(p, d, live, t, detailKey = `decision-${p.name}-${d.task.id}`) {
    this.instructions ??= new Map();
    const key = this.instructionKey(p, d), id = `${p.name}-${d.task.id}`, sent = this.instructions.get(key);
    const lead = !p.stale && !this.error && leadTerminal(p, live, d.task);
    const typing = this.answerInput && this.typing?.kind === "instruction" && this.typing.key === key;
    const edit = (cx) => {
      this.instructions.delete(key);
      this.answerInput.set_value(sent?.status === "failed" ? sent.answer : "");
      this.typing = { kind: "instruction", key, p, d, lead }; this.answerInput.focus(); cx.notify();
    };
    return v_flex().min_w(0).gap(5)
      .when(Boolean(sent), (e) => e.child(div().whitespace_normal().text_size(11).text_color(sent.status === "failed" ? t.blocked : t.muted)
        .child(sent.status === "sending" ? "Lead에게 지시 전달 중…" : sent.status === "sent" ? `전달됨 · Lead 처리 대기 — ${sent.answer}` : `전달 실패: ${sent.error}`)))
      .when(!lead, (e) => e.child(div().whitespace_normal().text_size(11).text_color(t.dim).child("최신 대장과 Lead 연결을 확인하면 지시를 보낼 수 있습니다.")))
      .child(h_flex().gap(6).items_center()
        .when(Boolean(lead && this.answerInput) && !typing && sent?.status !== "sending", (e) => e.child(this.button(`instruction-${id}-edit`, sent?.status === "sent" ? "다른 지시 보내기" : sent?.status === "failed" ? "지시 다시 입력" : "Lead에게 지시…", edit, t)))
        .child(this.button(`more-${detailKey}`, this.expanded.has(detailKey) ? "근거 접기" : "근거 보기", (cx) => {
          this.expanded.has(detailKey) ? this.expanded.delete(detailKey) : this.expanded.add(detailKey); cx.notify();
        }, t)))
      .when(typing, (e) => e
        .child(div().whitespace_normal().text_size(11).text_color(t.muted).child("이 업무에 대한 지시를 Lead에게 전달합니다. 상태 변경은 Lead 처리 후 반영됩니다."))
        .child(h_flex().gap(6).items_center()
          .child(div().id(`instruction-${id}-input`).flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(5).border_1().border_color(t.accent)
            .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(this.answerInput).h_full().text_size(11.5).text_color(t.foreground)))
          .when(Boolean(lead), (e) => e.child(this.button(`instruction-${id}-send`, "보내기", (cx) => this.submitTyped(cx), t)))
          .child(this.button(`instruction-${id}-cancel`, "취소", (cx) => { this.typing = null; cx.notify(); }, t))));
  }

  sendInstruction(p, d, lead, value, cx) {
    const current = this.currentProject(), key = this.instructionKey(p, d);
    const actual = current?.tasks.find((task) => task.id === d.task.id && !task.archived && task.state === "BLOCKED" && !waitingOn(task, current));
    const live = new Map(terminals().filter((x) => x.state === "live").map((x) => [x.address, x]));
    const currentLead = current && !current.stale && !this.error && leadTerminal(current, live, actual);
    if (!current || current.root !== p.root || current.projectId !== p.projectId || !actual || decisionSignature(actual) !== d.signature
      || !lead || !currentLead || currentLead.address !== lead.address || currentLead.created_ms !== lead.created_ms) return;
    const message = instructionMessage(d.task, value);
    this.instructions ??= new Map();
    if (!message || ["sending", "sent"].includes(this.instructions.get(key)?.status)) return;
    const answer = String(value).trim();
    this.instructions.set(key, { status: "sending", answer }); cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try { r = await hc(["send", lead.address, message]); } catch (e) { r = { code: -1, stderr: e?.message ?? String(e) }; }
      this.instructions.set(key, r.code === 0 ? { status: "sent", answer } : { status: "failed", answer, error: (r.stderr || r.stdout || `종료 코드 ${r.code}`).trim().slice(0, 160) });
      cx.notify();
    });
  }

  answer(p, request, lead, value, cx) {
    // 클릭 이후 조회·revision·Lead·공간이 바뀌었으면 오래된 카드의 답을 보내지 않는다.
    const current = this.currentProject();
    const actual = current?.requests?.find((r) => r.id === request.id && r.status === "open");
    const currentLive = new Map(terminals().filter((x) => x.state === "live").map((x) => [x.address, x]));
    const currentLead = current && !current.stale && !this.error && current.decisionStatus === "ready" && leadTerminal(current, currentLive, null);
    if (!currentLead || !lead || !current || current.root !== p.root || current.projectId !== p.projectId || !actual || actual.revision !== request.revision || currentLead.address !== lead.address) return;
    const message = answerMessage(request, value), key = answerKey(p, request);
    if (!message || ["sending", "sent"].includes(this.answers.get(key)?.status)) return;
    const answer = String(value).replace(/\s+/g, " ").trim();
    this.answers.set(key, { status: "sending", answer });
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try { r = await hc(["send", lead.address, message]); } catch (e) { r = { code: -1, stderr: e?.message ?? String(e) }; }
      this.answers.set(key, r.code === 0 ? { status: "sent", answer } : { status: "failed", answer, error: (r.stderr || r.stdout || `종료 코드 ${r.code}`).trim().slice(0, 160) });
      cx.notify();
    });
  }

  decisionCard(p, d, live, t) {
    const key = `decision-${p.name}-${d.task.id}`, expanded = this.expanded.has(key);
    return v_flex().flex_none().min_w(0).p(10).gap(6).rounded(8).bg(tint(t.blocked, .05)).border_1().border_color(tint(t.blocked, .35))
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(10.5).font_medium().text_color(t.blocked).child(d.kind))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child(ago(d.since))))
      .child(div().whitespace_normal().font_medium().text_size(12.5).child(d.task.title ?? d.task.id))
      .child(div().text_size(10.5).text_color(t.dim).child(d.task.id))
      .child(div().whitespace_normal().text_size(12).text_color(t.foreground).child(d.reason))
      .when(d.affected.length > 0, (e) => e.child(div().whitespace_normal().text_size(11).text_color(t.muted)
        .child(`이 업무를 기다리는 후속 ${d.affected.length}건 · ${d.affected.map((x) => x.id).join(", ")}`)))
      .child(this.instructionRow(p, d, live, t))
      .when(expanded, (e) => e
        .when(Boolean(d.question && d.question !== d.reason), (e) => e.child(div().whitespace_normal().text_size(11).text_color(t.muted).child(d.question)))
        .child(div().whitespace_normal().text_size(11).text_color(t.dim).child("등록된 선택지 없음 · 자유 입력 지시를 Lead에게 전달할 수 있습니다."))
        .child(div().text_size(11).text_color(t.dim).child("답하기 전: 이 업무의 대기 상태 유지"))
        .child(this.detail(d.task, t)));
  }

  pausedCard(p, task, live, t) {
    const key = `paused-${p.name}-${task.id}`;
    return v_flex().flex_none().min_w(0).py(8).gap(5).border_t(1).border_color(t.border)
      .child(div().whitespace_normal().font_medium().text_size(12).child(task.title ?? task.id))
      .child(div().text_size(11).text_color(t.dim).child(`${task.id} · 사용자 요청으로 중단`))
      .child(this.instructionRow(p, { task, signature: decisionSignature(task) }, live, t, key))
      .when(this.expanded.has(key), (e) => e.child(this.detail(task, t)));
  }

  changeCard(p, r, t) {
    const key = `change-${p.name}-${r.id}`, expanded = this.expanded.has(key);
    const color = ["qa", "closed", "merged"].includes(r.kind) ? t.done : ["failed", "rework", "decision", "blocked"].includes(r.kind) ? t.blocked : t.muted;
    const body = r.body || `${stateLabel(r.from, r.task) ?? "—"} → ${r.to === "DONE" ? r.title : stateLabel(r.to, r.task)}`;
    return v_flex().id(`more-${key}`).flex_none().min_w(0).py(8).gap(3).border_t(1).border_color(t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { expanded ? this.expanded.delete(key) : this.expanded.add(key); cx.notify(); })
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11).font_medium().text_color(color).child(r.title))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child(`${clock(r.at)}  ${expanded ? "▾" : "▸"}`))
        .when(!p.stale && !this.error, (e) => e.child(this.button(`read-change-${r.id}`, "확인", () => {
          const current = this.currentProject();
          if (!current || current.root !== p.root || current.projectId !== p.projectId || current.stale || this.error) return;
          const record = current.attentionRecords?.find((x) => x.id === r.id);
          if (record) setShared(seenKey(current), recordSnapshot(current, record, Date.now(), shared(seenKey(current))));
        }, t))))
      .child(div().min_w(0).truncate().font_medium().text_size(12).tooltip(r.task.title ?? r.task.id).child(r.task.title ?? r.task.id))
      .child(div().text_size(10.5).text_color(t.dim).child(r.task.id))
      .when(!expanded && Boolean(r.body), (e) => e.child(div().text_size(11).text_color(t.muted).truncate().tooltip(r.body).child(r.body)))
      .when(expanded, (e) => e
        .child(div().whitespace_normal().text_size(11).text_color(t.muted).child(body))
        .when(r.kind === "qa", (e) => e.child(div().text_size(10.5).text_color(t.dim).child("커밋·PR·병합·배포는 별도 확인")))
        .child(this.detail(r.task, t)));
  }

  changeReadTools(p, t, records) {
    const seen = validSeen(shared(seenKey(p)));
    return h_flex().flex_wrap().gap(6).items_center()
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
    return v_flex().flex_none().min_w(0).gap(8)
      .when(Boolean(requests.length || inbox.length), (e) => e.child(this.section("내 결정·확인", `질문 ${requests.length} · 막힘 ${inbox.length}`, t.blocked, t)))
      .children(shown.filter((p) => p.note || p.historyNote).map((p) => div().px(2).text_size(11).text_color(t.blocked).child(`${p.name} · ${p.note ?? p.historyNote}`)))
      .children(requests.map(({ p, request }) => this.requestCard(p, request, live, t)))
      .children(shown.filter((p) => p.decisionNote).map((p) => div().px(2).text_size(11).text_color(t.muted).child(`${p.name} · ${p.decisionNote}`)))
      .children(shown.filter((p) => p.capacityNote).map((p) => div().text_size(11).text_color(t.blocked).child(p.capacityNote)))
      .when(!inbox.length && !requests.length, (e) => e.child(div().py(4).text_size(11).text_color(t.muted).child(shown.some((p) => p.stale || p.decisionStatus !== "ready") || this.error ? "최신 결정 상태를 확인할 수 없습니다." : "지금 내 답변을 기다리는 일은 없습니다.")))
      .children(inbox.map(({ p, d }) => this.decisionCard(p, d, live, t)));
  }

  refreshResources(cx) {
    if (!this.resourcesOpen || !showsLocalResources(this.context())) return;
    const started = Date.now();
    if (this.resourceReadAt != null && started - this.resourceReadAt < STUCK) return;
    this.resourceReadAt = started;
    cx.spawn(async (cx) => {
      try {
        const active = parse(await readTextFile(`${appHome()}/mods/harness/release.json`));
        if (this.resourceReadAt !== started) return;
        if (!active?.release) throw new Error("활성 릴리스를 찾지 못했습니다.");
        const result = await exec("node", [`${active.release}/bin/resource-status.mjs`], { timeout: 5000 });
        if (result.code !== 0) throw new Error("활성 릴리스의 자원 조회에 실패했습니다.");
        const data = JSON.parse(result.stdout);
        if (this.resourceReadAt !== started) return;
        if (!data?.preparation || !Array.isArray(data.heavy) || !Array.isArray(data.projects)) throw new Error("자원 상태를 읽지 못했습니다.");
        this.resourceData = data;
        this.resourceError = null;
      } catch (err) {
        if (this.resourceReadAt !== started) return;
        this.resourceData = null;
        this.resourceError = String(err.message ?? err);
      } finally {
        if (this.resourceReadAt === started) { this.resourceReadAt = null; cx.notify(); }
      }
    });
  }

  resourceCard(t) {
    const open = this.resourcesOpen, data = this.resourceData;
    const line = text => div().min_w(0).whitespace_normal().text_size(12).text_color(t.muted).child(text);
    const slotLabel = s => {
      if (s.state === "free") return "비어 있음";
      if (s.state === "unknown") return "잠금 정보 확인 필요";
      const since = time(s.started);
      return [s.state === "stale" ? "소유 프로세스 종료" : "점유 중", s.project, `PID ${s.pid}`,
        since ? `시작 후 ${Math.max(0, Math.floor((Date.now() - since) / 1000))}초` : null].filter(Boolean).join(" · ");
    };
    const pair = values => values ? values.map(v => `${v} ms`).join(" / ") : "—";
    const card = v_flex().flex_none().min_w(0).p(10).gap(6).rounded(8)
      .bg(open ? t.selected : t.raised).border_1().border_color(open ? t.accent : t.border)
      .child(div().id("harness-resource-toggle").font_medium().text_size(13).cursor_pointer()
        .on_click((_e, cx) => {
          this.resourcesOpen = !this.resourcesOpen;
          if (this.resourcesOpen) { this.resourceData = null; this.resourceError = null; this.refreshResources(cx); }
          cx.notify();
        }).child(open ? "준비·자원 ▴" : "준비·자원 ▾"));
    if (!open) return card;
    if (!data) return card.child(line(this.resourceError ?? "자원 상태 조회 중…"));
    card.child(line(`준비 슬롯 · ${slotLabel(data.preparation)}`));
    data.heavy.forEach((s, i) => card.child(line(`시험·빌드 슬롯 ${i + 1} · ${slotLabel(s)}`)));
    card.child(div().pt(4).font_medium().child(`프로젝트별 계측 · 종류별 최근 최대 ${data.limit}행`));
    if (!data.projects.length) card.child(line("표시할 계측 기록이 없습니다."));
    for (const p of data.projects) {
      card.child(div().pt(4).font_medium().whitespace_normal().child(p.project));
      if (p.preparations) {
        card.child(line(`대기 ${p.preparations}건 · p50 / p95   ${pair(p.wait)}`))
          .child(line(`점유 ${p.acquired}건 · p50 / p95   ${pair(p.run)}`))
          .child(line(`미획득 ${p.missed}건 · 0 이외 종료 코드 ${p.nonzero}건 · 종료 코드 없음 ${p.noExit}건`));
      }
      if (p.installs) {
        card.child(line(`의존성 설치 ${p.installs}건 · 전체 시도 평균 ${p.installMean} ms`));
        if (Number.isInteger(p.successfulInstalls)) {
          const mean = p.successfulInstallMean === null ? "—" : `${p.successfulInstallMean} ms`;
          card.child(line(`성공 ${p.successfulInstalls}건 · 성공 평균 ${mean}`));
        }
        card.child(line(Object.entries(p.methods).map(([method, count]) => `${method} ${count}건`).join(" · ")));
      }
      if (p.failedInstalls || p.timedOutInstalls) {
        card.child(line(`설치 실패 ${p.failedInstalls}건 · 시간 초과 ${p.timedOutInstalls}건`));
        const codes = Object.entries(p.errorCodes);
        if (codes.length) card.child(line(`오류 코드 · ${codes.map(([code, count]) => `${code} ${count}건`).join(" · ")}`));
      }
    }
    return card;
  }

  basicAgent(agent, t) {
    const key = `basic-${agent.address}`, opened = this.expanded.has(key), attention = needsTerminal(agent);
    const color = this.color(({ working: "IMPLEMENTING", blocked: "BLOCKED", error: "FAILED", done: "DONE", idle: "QUEUED" })[agent.status], t);
    return v_flex().flex_none().min_w(0).p(10).gap(6).rounded(8)
      .bg(opened ? t.selected : t.raised).border_1().border_color(opened ? t.accent : t.border)
      .child(h_flex().gap(8).items_start()
        .child(div().id(`activity-${agent.address}`).flex_1().min_w(0).font_medium().text_size(13).whitespace_normal().cursor_pointer()
          .on_click((_e, cx) => { opened ? this.expanded.delete(key) : this.expanded.add(key); cx.notify(); }).child(agent.title))
        .child(this.badge({ state: agent.status }, color, t, agent.label)))
      .child(div().text_size(12).text_color(t.muted).whitespace_normal().child(agent.message || "상태 보고에 작업 내용이 없습니다."))
      .when(attention, (e) => e.child(div().text_size(11).text_color(t.dim).child("질문·선택지 또는 오류 내용은 터미널에서 확인합니다.")))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child("CLI 상태 보고"))
        .child(this.button(`terminal-${agent.address}`, "터미널 ↗", () => {
          if (!this.context().agents.some((x) => x.address === agent.address)) return;
          run(agent.attached ? "pane.focus" : "terminal.peek", { terminal: agent.address });
        }, t)))
      .when(opened, (e) => e.child(v_flex().gap(3).p(8).rounded(6).bg(t.raised).text_size(11).text_color(t.muted)
        .child(`터미널 ${agent.address}`)
        .when(Boolean(agent.cwd), (e) => e.child(div().whitespace_normal().child(agent.cwd)))
        .child("활동 상태는 업무 완료나 QA 판정을 뜻하지 않습니다.")));
  }

  basic(context, t) {
    if (["unavailable", "loading", "none"].includes(context.kind)) return v_flex().min_w(0).py(16).gap(8)
      .child(div().font_medium().child(context.kind === "none" ? "현재 공간이 없습니다." : context.kind === "loading" ? "현재 공간의 연결을 확인하고 있습니다." : "현재 공간이 응답하지 않습니다."))
      .child(div().text_size(12).text_color(t.muted).child("현재 상태를 확인할 수 없습니다. 작업이 없다는 뜻은 아닙니다."))
      .when(Boolean(context.machine), (e) => e.child(h_flex().child(this.button("harness-machine-settings", "머신 연결 확인", () => run("app.settings", { section: "machines" }), t))));
    const needs = context.agents.filter(needsTerminal), other = context.agents.filter((a) => !needsTerminal(a));
    return v_flex().min_w(0).gap(8)
      .when(needs.length > 0, (e) => e.child(this.section("터미널 확인", needs.length, t.blocked, t)).children(needs.map((a) => this.basicAgent(a, t))))
      .when(other.length > 0, (e) => e.child(this.section("에이전트 활동", other.length, t.muted, t)).children(other.map((a) => this.basicAgent(a, t))))
      .when(context.agents.length === 0, (e) => e.child(v_flex().py(18).gap(9)
        .child(div().font_medium().child("아직 실행 중인 에이전트가 없습니다."))
        .child(div().text_size(12).text_color(t.muted).whitespace_normal().child("이 공간에서 실행한 에이전트의 활동과 입력이 필요한 터미널을 여기에 보여줍니다."))
        .when(Boolean(context.terminal), (e) => e.child(h_flex().child(this.button("harness-current-terminal", "현재 터미널 열기 ↗", () => run("pane.focus", { terminal: context.terminal }), t))))))
      .child(div().pt(6).text_size(11).text_color(t.dim).whitespace_normal().child("기본 브리핑은 에이전트 보고와 터미널을 보여줍니다. 업무 단계·QA·결정함은 하네스 연결 시 제공됩니다."));
  }

  contextHeader(context, shown, t, overlay) {
    const p = shown[0], tasks = (p?.tasks ?? []).filter((x) => !x.archived);
    const needs = p ? decisions(p).length + openRequests(p).length : context.agents.filter(needsTerminal).length;
    const unseen = p ? changes(p, shared(seenKey(p))).length : null;
    const mode = ["unavailable", "loading"].includes(context.kind) ? "연결 확인 필요" : p ? p.stale || this.error ? "하네스 확인 필요" : "하네스 연결" : this.error || this.loading ? "하네스 연결 확인 중" : "기본 브리핑";
    const ready = p && !p.stale && !this.error && p.decisionStatus === "ready";
    const summary = p ? [ready ? needs ? `내 결정·확인 ${needs}` : "내 답변 필요 없음" : "결정 상태 확인 필요", p.stale || this.error ? "업무 상태 확인 필요" : `진행 ${tasks.filter((x) => !ENDED.includes(x.state) && (x.state !== "BLOCKED" || waitingOn(x, p))).length}`, pausedTasks(p).length ? `사용자 중단 ${pausedTasks(p).length}` : null, unseen ? `새 변화 ${unseen}` : null].filter(Boolean).join(" · ")
      : ["unavailable", "loading", "none"].includes(context.kind) ? "현재 상태 확인 불가" : `에이전트 ${context.agents.length} · 터미널 확인 ${needs}`;
    return v_flex().flex_none().min_w(0).px(14).py(12).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_start()
        .child(div().flex_1().min_w(0).whitespace_normal().font_medium().text_size(14).child(context.name))
        .child(div().flex_none().px(6).py(2).rounded(4).text_size(11).text_color(t.muted).bg(t.raised).child(mode))
        .when(this.loading, (e) => e.child(svg(ICON("spinner")).size(12).flex_none().text_color(t.dim).spin(900)))
        .when(Boolean(overlay), (e) => e.child(div().id("harness-close").px(6).cursor_pointer().text_color(t.dim).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => closeOverlay(overlay)).child("✕"))))
      .when(Boolean(context.branch || context.machine || context.cwd), (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).tooltip(context.cwd ?? "").child([context.branch, context.machine, context.cwd].filter(Boolean).join(" · "))))
      .child(div().whitespace_normal().text_size(11).text_color(needs ? t.blocked : t.muted).child(summary));
  }

  changesFooter(shown, t) {
    const byProject = new Map(shown.map((p) => [p, changes(p, shared(seenKey(p)))]));
    const updates = shown.flatMap((p) => byProject.get(p).map((r) => ({ p, r }))).sort((a, b) => b.r.at - a.r.at);
    const visible = this.showChanges ? updates : updates.slice(0, 3);
    return v_flex().flex_none().min_w(0).px(14).py(10).gap(6).border_t(1).border_color(t.border)
      .child(h_flex().flex_wrap().gap(6).items_center()
        .child(h_flex().id("harness-change-toggle").gap(6).items_center().cursor_pointer()
          .on_click((_e, cx) => { this.changesCollapsed = !this.changesCollapsed; cx.notify(); })
          .child(this.section("알아둘 변화", updates.length, t.muted, t))
          .child(div().text_size(11).text_color(t.dim).child(this.changesCollapsed ? "▾" : "▴")))
        .child(div().flex_1())
        .when(shown.length === 1, (e) => e.child(this.changeReadTools(shown[0], t, byProject.get(shown[0])))))
      .when(!this.changesCollapsed && updates.length > 0, (e) => e.child(v_flex().id("harness-change-list").flex_none().h(Math.min(220, visible.length * 104 + (updates.length > 3 ? 32 : 0))).overflow_y_scrollbar().gap(4)
        .children(visible.map(({ p, r }) => this.changeCard(p, r, t)))
        .when(updates.length > 3, (e) => e.child(h_flex().child(this.button("harness-more-changes", this.showChanges ? "최근 3건만 보기" : `나머지 ${updates.length - 3}건 보기`, (cx) => {
          this.showChanges = !this.showChanges; cx.notify();
        }, t))))));
  }

  render(cx) {
    const t = theme(), overlay = props()?.overlay;
    const live = new Map(terminals().filter((x) => x.state === "live").map((x) => [x.address, x]));
    const context = this.context(), shown = context.project ? [context.project] : [];
    const all = shown.flatMap((p) => p.tasks.filter((x) => !x.archived).map((x) => ({ ...x, waiting: Boolean(waitingOn(x, p)) })));
    const body = v_flex().id("harness-list").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(8).gap(8);
    if (this.error) body.child(div().text_size(11).text_color(t.ansi1).child(this.error));
    if (shown.length) body.child(this.attention(shown, live, t));
    if (showsLocalResources(context)) body.child(this.resourceCard(t));
    if (!shown.length) body.child(this.basic(context, t));
    else {
      body.child(h_flex().items_center().gap(6)
          .child(this.section("진행 중", all.filter((x) => !ENDED.includes(x.state) && (x.state !== "BLOCKED" || x.waiting)).length, t.muted, t))
          .child(div().flex_1())
          .child(this.button("harness-ended", this.showEnded ? "종료 숨기기" : "종료 포함", (cx) => { this.showEnded = !this.showEnded; cx.notify(); }, t)))
        .children(shown.map((p) => this.project(p, this.projects.indexOf(p), live, t)));
      for (const p of shown) {
        const paused = pausedTasks(p);
        if (paused.length) body.child(v_flex().flex_none().min_w(0).gap(5)
          .child(this.section("사용자 요청으로 중단", paused.length, t.muted, t))
          .children(paused.map((task) => this.pausedCard(p, task, live, t))));
        const report = leadReport(p, live);
        if (report.available) body.child(h_flex().id(`lead-status-${p.name}`).py(4).gap(6).items_center().text_size(11).text_color(t.dim).cursor_pointer()
          .tooltip(report.text).on_click(() => run("agent.focus", { terminal: report.address }))
          .child(div().flex_none().child(`Lead · ${report.activity}`))
          .child(div().flex_1().min_w(0).truncate().child(report.text)));
      }
    }
    return v_flex().id("harness").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(this.contextHeader(context, shown, t, overlay))
      .child(body)
      .when(shown.length > 0, (e) => e.child(this.changesFooter(shown, t)));
  }
}
