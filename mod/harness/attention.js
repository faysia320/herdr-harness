export { decisionInbox } from './decisions.js';
// 사람의 확인에 필요한 정보만 계산한다. 대장 변경·자동 승인·문장 의미 추론은 하지 않는다.
export const at = (value) => typeof value === "number" ? value : Date.parse(value ?? "") || 0;
const str = (value) => typeof value === "string" ? value.trim() : "";
const active = (p) => p.tasks.filter((t) => !t.archived);
export const projectKey = (p) => JSON.stringify([p.root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(), p.projectId]);
export const seenKey = (p) => `harness.attention.v1.${projectKey(p)}`;
export const stateLabel = (s) => ({ DONE: "로컬 QA 통과", FAILED: "실패", BLOCKED: "막힘", QA: "QA", IMPLEMENTING: "구현", RESEARCHING: "조사", READY_TO_IMPLEMENT: "구현 대기", QUEUED: "대기" }[s] ?? s);

export const openRequests = (p) => (p.requests ?? []).filter((r) => r.status === "open").sort((a, b) => at(a.created) - at(b.created) || a.id.localeCompare(b.id));

export function decisionSignature(t) {
  const entry = [...(t.history ?? [])].reverse().find((h) => h.to === "BLOCKED");
  return JSON.stringify([t.state, t.awaiting ?? null, t.reason ?? null, str(t.x_pending_decision), at(entry?.at)]);
}

// Lead가 다른 업무를 기다리려고 멈춘 막힘은 stop 사유를 «선행 대기 ID[,ID]: …»로 시작한다. 사유의 뜻은 추측하지 않고 이 표식만 읽는다.
const WAIT_MARK = /^(?:(?:사용자 )?중단:\s*)?선행 대기\s+([A-Z][A-Z0-9]*-\d+(?:\s*,\s*[A-Z][A-Z0-9]*-\d+)*)\s*:/;
export const waitMark = (why) => WAIT_MARK.exec(str(why))?.[1].split(",").map((id) => id.trim()) ?? null;

// 아직 끝나지 않은 선행 업무를 돌려준다. 선행 업무가 없거나 실패했거나 모두 끝났으면 null이며 사람이 확인할 막힘으로 남긴다.
export function waitingOn(task, p) {
  const ids = task.state === "BLOCKED" ? waitMark(task.reason) : null;
  if (!ids) return null;
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  if (ids.some((id) => !byId.has(id) || byId.get(id).state === "FAILED")) return null;
  const pending = ids.filter((id) => byId.get(id).state !== "DONE");
  return pending.length ? pending : null;
}

export function decisions(p) {
  const tasks = active(p);
  return tasks.filter((t) => t.state === "BLOCKED" && !waitingOn(t, p)).map((task) => {
    const entry = [...task.history].reverse().find((h) => h.to === "BLOCKED");
    const affected = tasks.filter((t) => t.id !== task.id && t.state !== "DONE" && (t.depends ?? []).includes(task.id));
    return { task, affected, since: at(entry?.at) || task.updated,
      kind: ({ "ac-approval": "완료 기준 승인", decision: "방향 결정", permission: "권한 결정" })[task.awaiting]
        ?? (waitMark(task.reason)?.every((id) => p.tasks.find((t) => t.id === id)?.state === "DONE") ? "선행 업무 끝남 · 재개 필요" : "확인 필요"),
      reason: str(task.reason) || str(entry?.why) || "대장에 사유가 기록되지 않았습니다.",
      question: str(task.x_pending_decision),
      signature: decisionSignature(task) };
  }).sort((a, b) => b.affected.length - a.affected.length || (b.task.priority ?? 0) - (a.task.priority ?? 0) || a.since - b.since);
}

function kindOf(e) {
  if (e.to === "DONE") return "qa";
  if (e.to === "FAILED") return "failed";
  if (e.to === "BLOCKED") return waitMark(e.why) ? "waiting" : "blocked";
  if (e.from === "BLOCKED") return "resolved";
  if (e.from === "QA" && e.to === "READY_TO_IMPLEMENT") return "rework";
  return null;
}
const TITLE = { qa: "로컬 QA 통과", failed: "실행 실패", blocked: "사람 확인 필요", waiting: "선행 업무 대기", resolved: "막힘 해소", rework: "QA 재작업", decision: "결정 사유 변경", approval: "사람이 남긴 승인 근거", note: "최근 실행 결과" };

// 사건 파일과 업무 history의 같은 전이는 한 번만 표시한다. 시각이 같아도 내용이 다르면 보존한다.
export function importantRecords(p) {
  const tasks = new Map(active(p).map((t) => [t.id, t]));
  const records = new Map();
  const add = (r) => records.set(r.id, { ...r, title: TITLE[r.kind] });
  const events = [...(p.events ?? []), ...[...tasks.values()].flatMap((t) => t.history.map((h) => ({ ...h, task: t.id })))];
  for (const e of events) {
    if (!tasks.has(e.task) || e.from === e.to || !at(e.at)) continue;
    const kind = kindOf(e);
    if (!kind) continue;
    const id = JSON.stringify(["state", e.task, at(e.at), e.from ?? null, e.to, e.why ?? ""]);
    add({ id, task: tasks.get(e.task), kind, at: at(e.at), body: str(e.why), from: e.from, to: e.to });
  }
  for (const t of tasks.values()) {
    if (t.state === "BLOCKED") {
      // 동일 상태에서 사유가 바뀌어도 새 확인 항목이다. updated만 변하면 같은 항목이다.
      const signature = decisionSignature(t);
      add({ id: JSON.stringify(["decision", t.id, signature]), task: t, kind: "decision", at: t.updated, body: str(t.reason), signature });
    }
    if (t.approval?.by === "user" && str(t.approval.quote)) {
      add({ id: JSON.stringify(["approval", t.id, t.approval]), task: t, kind: "approval", at: at(t.approval.at), body: t.approval.quote });
    }
    const last = t.runs.at(-1);
    if (last?.status !== "running" && str(last?.note)) {
      add({ id: JSON.stringify(["note", t.id, last.ended, last.outcome, last.note]), task: t, kind: "note", at: at(last.ended), body: last.note });
    }
  }
  return [...records.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

export function validSeen(value) {
  return value?.version === 1 && Array.isArray(value.ids) && value.decisions && typeof value.decisions === "object" ? value : null;
}

export function changes(p, value, now = Date.now()) {
  const seen = validSeen(value), ids = new Set(seen?.ids ?? []);
  const records = p.attentionRecords ?? importantRecords(p);
  return records.filter((r) => {
    // 첫 화면은 최근 하루만. 과거 전체를 새 소식으로 쏟아내지 않는다.
    if (!seen && r.at < now - 86400000) return false;
    if (r.kind === "decision") {
      if ((p.observedAt ?? 0) < (seen?.observedAt ?? 0)) return false;
      // 새로운 막힘은 결정함과 상태 기록으로 전달하고 같은 상태의 사유 변경만 여기 올린다.
      const before = seen?.decisions[r.task.id];
      return Boolean(before && before !== r.signature);
    }
    return !ids.has(r.id);
  });
}

export function snapshot(p, now = Date.now(), previous = null) {
  const seen = validSeen(previous), observedAt = p.observedAt ?? 0;
  // 다른 화면에서 더 새 자료를 이미 읽었으면 오래된 화면의 클릭으로 기준을 되돌리지 않는다.
  if (seen && observedAt < (seen.observedAt ?? 0)) return seen;
  return { version: 1, at: now, observedAt, ids: [...new Set([...(seen?.ids ?? []), ...(p.attentionRecords ?? importantRecords(p)).map((r) => r.id)])],
    decisions: Object.fromEntries(decisions(p).map((d) => [d.task.id, d.signature])) };
}

export function digest(records) {
  const count = (kind) => new Set(records.filter((r) => r.kind === kind).map((r) => r.task.id)).size;
  return [{ kind: "qa", label: "QA 통과", count: count("qa") }, { kind: "rework", label: "재작업", count: count("rework") },
    { kind: "failed", label: "실패", count: count("failed") }, { kind: "resolved", label: "막힘 해소", count: count("resolved") }].filter((x) => x.count);
}

// Lead가 살아 있는지와 로컬 대장이 가리키는 터미널인지 확인한다. 메시지는 보내지 않는다.
export function leadTerminal(p, live, task) {
  const address = task?.x_lead ?? p.lead;
  const term = address && live.get(address);
  if (!term || address.includes("/")) return null;
  const owner = term.labels?.["harness.project"];
  return owner && owner !== p.projectId ? null : term;
}

// 업무 대장 밖의 질문도 Lead의 OSC 보고에 실린다. 활동 상태나 읽음을 질문 해소로 해석하지 않는다.
// 보고 한 개에 질문이 여럿일 수 있으므로 원문을 보여 주고 질문 건수를 추측하지 않는다.
export const leadReportKey = (p) => `harness.lead-report.v1.${projectKey(p)}`;
export function leadReport(p, live, previous = null) {
  if (p.stale) return { available: false, reason: "대장 갱신 실패로 현재 Lead를 확인할 수 없습니다." };
  const terminal = leadTerminal(p, live);
  if (!terminal || terminal.state !== "live") return { available: false, reason: "Lead 연결이 없어 별도 질문 여부를 확인할 수 없습니다." };
  const text = str(terminal.report?.msg);
  const prior = previous?.address === terminal.address && previous?.created === terminal.created_ms && str(previous?.text) ? previous : null;
  const completed = ["done", "idle", "blocked", "error"].includes(terminal.status);
  const retained = prior && (!completed || !text);
  const shown = retained ? prior.text : text;
  if (!shown) return { available: false, reason: "Lead의 상태 메시지가 없어 별도 질문 여부를 확인할 수 없습니다." };
  return { available: true, address: terminal.address, text: shown, retained: Boolean(retained),
    progress: retained && text !== shown ? text : null,
    // status_ms는 메시지 시각이 아니므로 보고 시각으로 표시하지 않는다.
    remember: completed && text ? { address: terminal.address, created: terminal.created_ms, text } : null,
    activity: ({ working: "작업 중", done: "응답 완료", idle: "입력 대기", blocked: "입력 필요", error: "오류" })[terminal.status] ?? "상태 미확인" };
}
