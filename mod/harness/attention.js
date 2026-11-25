export { decisionInbox } from './decisions.js';
import { workflowLabel, workflowPhase } from './logic.js';
// 사람의 확인에 필요한 정보만 계산한다. 대장 변경·자동 승인·문장 의미 추론은 하지 않는다.
export const at = (value) => typeof value === "number" ? value : Date.parse(value ?? "") || 0;
const str = (value) => typeof value === "string" ? value.trim() : "";
const excerpt = (value, max = 88) => value.length > max ? value.slice(0, max - 1).trimEnd() + "…" : value;
const active = (p) => p.tasks.filter((t) => !t.archived);
export const projectKey = (p) => JSON.stringify([p.root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(), p.projectId]);
export const seenKey = (p) => `harness.attention.v1.${projectKey(p)}`;
// 사용자 결정으로 QA 게이트를 예외 처리해 병합·종결한 업무. DONE이지만 로컬 QA 통과가 아니다.
export const closedByDecision = (t) => t?.state === "DONE" && t.x_closure?.kind === "user-decision";
export const stateLabel = (s, task, event) => {
  if (s === "DONE" && event?.to === "DONE") return TITLE[doneKind(event, task)];
  return ({ DONE: task && workflowPhase(task) ? "종결" : "로컬 QA 통과", FAILED: "실패", BLOCKED: "막힘", QA: "QA", IMPLEMENTING: "구현", RESEARCHING: "조사", READY_TO_IMPLEMENT: "구현 대기", QUEUED: "대기" }[s] ?? s);
};

export const openRequests = (p) => (p.requests ?? []).filter((r) => r.status === "open").sort((a, b) => at(a.created) - at(b.created) || a.id.localeCompare(b.id));

// 명시적으로 사용자 중단만 기록된 업무를 답변 요청으로 세지 않는다.
// 결정 필드가 함께 있으면 중단 문구보다 그 필드를 우선한다.
export const userPaused = (task) => task.state === "BLOCKED" && !task.awaiting && !str(task.x_pending_decision)
  && /^(?:사용자 )?중단:\s*사용자 요청[.!。]?\s*$/.test(str(task.reason));
export const pausedTasks = (p) => active(p).filter(userPaused);

export const needsAnswer = (task) => task.state === "BLOCKED" &&
  (["permission", "decision", "ac-approval"].includes(task.awaiting) || Boolean(str(task.x_pending_decision)));

export function qaEvidence(task) {
  const result = task.x_flow?.verification;
  if (!task.candidate?.fingerprint || result?.candidate !== task.candidate.fingerprint ||
      !["FAIL", "BLOCKED", "CONDITIONAL PASS"].includes(result.verdict) || !Array.isArray(result.findings)) return [];
  return result.findings.map((f) => str(f?.evidence)).filter(Boolean);
}

// 이전 대장의 병합 메모는 Lead의 보고로만 표시한다. 대장의 상태나 병합 증명을 바꾸지는 않는다.
export function blockedSummary(d) {
  const task = d.task, flow = task.x_flow;
  const reason = d.reason.replace(/^(?:사용자 )?중단:\s*/, "").trim();
  const brief = excerpt(reason);
  const first = qaEvidence(task)[0];
  const evidence = first ? excerpt(first) : null;
  if (needsAnswer(task)) return { label: d.kind, text: d.question || brief, evidence };
  if (["publish", "ci", "delivery-blocked"].includes(workflowPhase(task)) && flow.verification?.verdict === "PASS") {
    const note = /^PR #(\d+) Lead 병합 [a-f0-9]{7,64}(?=\s*(?:\(|—|$))/i.exec(reason);
    const pr = flow.delivery?.pr;
    if ((note && (!pr || Number(note[1]) === pr)) || (pr && /^사용자 결정 [^:\n]+: DEV-14 기준 Lead 병합 — QA r\d+ PASS 후보/.test(reason))) {
      return { label: "대장 종결 보류", source: pr ? "병합 증명" : "PR 게시 기록", text: `Lead 병합 기록 · PR #${pr || note[1]}`,
        next: pr ? "Lead가 대장의 병합 증명을 확인할 차례입니다." : "대장에 최초 게시 PR 연결 기록이 없어 Lead 확인이 필요합니다." };
    }
  }
  return { label: d.kind === "확인 필요" ? "진행 중단" : d.kind, text: brief, evidence };
}

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
  return tasks.filter((t) => t.state === "BLOCKED" && !userPaused(t) && !waitingOn(t, p)).map((task) => {
    const entry = [...task.history].reverse().find((h) => h.to === "BLOCKED");
    const affected = tasks.filter((t) => t.id !== task.id && !["DONE", "FAILED"].includes(t.state) && (t.depends ?? []).includes(task.id));
    return { task, affected, since: at(entry?.at) || task.updated,
      kind: ({ "ac-approval": "완료 기준 승인", decision: "방향 결정", permission: "권한 결정" })[task.awaiting]
        ?? workflowLabel(task)
        ?? (waitMark(task.reason)?.every((id) => p.tasks.find((t) => t.id === id)?.state === "DONE") ? "선행 업무 끝남 · 재개 필요" : "확인 필요"),
      reason: str(task.reason) || str(entry?.why) || "대장에 사유가 기록되지 않았습니다.",
      question: str(task.x_pending_decision),
      signature: decisionSignature(task) };
  }).sort((a, b) => b.affected.length - a.affected.length || (b.task.priority ?? 0) - (a.task.priority ?? 0) || a.since - b.since);
}

const MERGE_SHA = /^병합 SHA 확인: ([a-f0-9]{40}|[a-f0-9]{64})$/i;
// 현재 병합 상태를 만든 마지막 전이인지 확인한다.
function lastMerge(e, task) {
  const last = task.history.at(-1);
  return task.state === "DONE" && task.x_flow?.phase === "merged" && last?.to === "DONE" &&
    at(last.at) === at(e.at) && last.from === e.from && (last.why ?? "") === (e.why ?? "");
}

function doneKind(e, task) {
  if (e.x_closure) return "closed";
  if (!workflowPhase(task)) return "qa";
  // SW·VDP가 해당 전이에 쓴 병합 근거는 업무가 다시 열려도 그대로다.
  // 구버전 대장의 근거 없는 행에는 현재 상태를 소급하지 않는다. 마지막 전이만 보완한다.
  return MERGE_SHA.test(e.why ?? "") || lastMerge(e, task) ? "merged" : "ended";
}

function kindOf(e, task) {
  if (e.to === "DONE") return doneKind(e, task);
  if (e.to === "FAILED") return "failed";
  if (e.to === "BLOCKED") return waitMark(e.why) ? "waiting" : "blocked";
  if (e.from === "BLOCKED") return "resolved";
  if (e.from === "QA" && e.to === "READY_TO_IMPLEMENT") return "rework";
  return null;
}
const TITLE = { qa: "로컬 QA 통과", merged: "병합 완료", ended: "업무 종결", failed: "실행 실패", blocked: "사람 확인 필요", waiting: "선행 업무 대기", resolved: "막힘 해소", rework: "QA 재작업", closed: "사용자 결정 종결", decision: "결정 사유 변경", approval: "사람이 남긴 승인 근거", note: "최근 실행 결과" };

// «최근 결과»에는 사용자가 알아야 할 결과만 올린다. 나머지 기록은 업무 카드에서 본다.
const SHOWN = new Set(["merged", "ended", "closed", "rework", "failed", "blocked", "decision"]);

const TECH = [
  [/https?:\/\/\S+/gi, " "],
  [/(?<![A-Za-z])[A-Za-z]:[\\/][^\s,;()"'`]*/g, " "],
  [/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, " "],
  // 경로는 빼되 «2/2», «CI/CD», «준비/자원» 같은 짧은 병기는 남긴다.
  [/[\w.@~*가-힣-]*[\\/][^\s,;()"'`»·]+/g, (x) => /^[A-Z0-9가-힣][\w가-힣]*\/[A-Z0-9가-힣][\w가-힣]*$/.test(x) ? x : " "],
  [/(?:sha(?:1|256)[:=]\s*)?\b(?:(?=[a-f]*\d)(?=\d*[a-f])[a-f0-9]{7,64}|[a-f0-9]{32,64})\b(?:(?:으로|에서|까지|부터|을|를|이|가|은|는|와|과|의|에|로|도|만)(?![가-힣]))?/gi, " "],
  [/[\w.-]+\.(?:[cm]?[jt]sx?|jsonl?|md|rs|py|ya?ml|toml|txt|log|lock|html|css|ps1|sh)(?!\w)(?:(?:으로|에서|까지|부터|을|를|이|가|은|는|와|과|의|에|로|도|만)(?![가-힣]))?/gi, " "],
  [/(?<![\w-])--[a-z][\w-]*(?:=[^\s)]+)?/gi, " "],
];

// 막힌 사유에서 JSON·경로·SHA 같은 기술 토큰을 붙은 조사와 함께 빼고 80자 이내로 줄인다. 뜻을 새로 만들지 않는다.
export function plainReason(value) {
  let text = str(value).replace(/`+/g, "");
  for (let before; before !== text;) { before = text; text = text.replace(/\{[^{}]*\}|\[[^[\]]*"[^[\]]*\]/g, " "); }
  text = text.replace(/\{\s*"[\s\S]*$/, " ");
  const parts = text.split(/\s+\/\s+|;\s+|\r?\n/).map((part) => {
    let s = part.trim().replace(/^(?:(?:사용자 )?중단|code|test|environment|verification|decision):\s*/i, "");
    for (const [pattern, to] of TECH) s = s.replace(pattern, to);
    return s.replace(/\(\s*[,·]?\s*\)|\[[\s,]*\]|«\s*»|"\s*"|'\s*'/g, " ").replace(/\s+/g, " ")
      .replace(/\s+([,.:;)])/g, "$1").replace(/^[\s,.:;·—–-]+|[\s,:;·—–-]+$/g, "");
  }).filter((s) => /[가-힣A-Za-z]/.test(s));
  return excerpt([...new Set(parts)].join(" · "), 80);
}

// 사용자에게 보여 줄 결과 문장. 원문은 카드를 펼쳤을 때만 보인다.
function resultText(kind, task, e, body) {
  const merged = (pr) => `main에 병합됐어요${Number.isInteger(pr) ? ` · PR #${pr}` : ""}`;
  if (kind === "merged") {
    // 다시 열린 업무의 예전 병합에 나중 PR 번호를 붙이지 않는다.
    const delivery = task.x_flow?.delivery, sha = MERGE_SHA.exec(e.why ?? "")?.[1].toLowerCase();
    const same = sha && typeof delivery?.merge === "string" ? delivery.merge.toLowerCase() === sha : lastMerge(e, task);
    return merged(same ? delivery?.pr : null);
  }
  if (kind === "closed") return "사용자 결정으로 마쳤어요";
  if (kind === "ended") {
    if (e.closure?.kind === "merged-accepted") return merged(e.closure.pr);
    if (e.closure?.kind === "local-only") return "게시 없이 마쳤어요";
    return e.closure?.kind === "policy-exception" ? "사용자 결정으로 마쳤어요" : "업무를 마쳤어요";
  }
  if (kind === "rework") return task.state === "DONE" ? "QA에서 문제가 나와 다시 고쳤어요" : "QA에서 문제가 나와 다시 고치는 중";
  if (kind === "failed") return "실행이 실패했어요 · Lead 확인 필요";
  if (kind === "blocked" || kind === "decision") {
    if (userPaused(task)) return "사용자 요청으로 멈췄어요";
    // «막힘 해소»를 따로 올리지 않으므로 이미 풀린 확인 요청은 여기서 구분한다.
    if (task.state !== "BLOCKED") return "확인이 필요했지만 지금은 풀렸어요";
    const reason = plainReason(body);
    return `확인이 필요해요${reason ? ` · ${reason}` : ""}`;
  }
  return null;
}

// 사건 파일과 업무 history의 같은 전이는 한 번만 표시한다. 시각이 같아도 내용이 다르면 보존한다.
export function importantRecords(p) {
  const tasks = new Map(active(p).map((t) => [t.id, t]));
  const records = new Map();
  const add = (r) => records.set(r.id, { ...r, title: TITLE[r.kind] });
  const events = [...(p.events ?? []), ...[...tasks.values()].flatMap((t) => t.history.map((h) => ({ ...h, task: t.id })))];
  for (const e of events) {
    if (!tasks.has(e.task) || e.from === e.to || !at(e.at)) continue;
    const kind = kindOf(e, tasks.get(e.task));
    if (!kind) continue;
    const id = JSON.stringify(["state", e.task, at(e.at), e.from ?? null, e.to, e.why ?? ""]);
    const closure = e.closure ?? e.x_closure ?? null, task = tasks.get(e.task), body = str(e.why);
    if (!closure && records.get(id)?.closure) continue;
    add({ id, task, kind, at: at(e.at), body, from: e.from, to: e.to, closure, text: resultText(kind, task, e, body) });
  }
  for (const t of tasks.values()) {
    if (t.state === "BLOCKED") {
      // 동일 상태에서 사유가 바뀌어도 새 확인 항목이다. updated만 변하면 같은 항목이다.
      const signature = decisionSignature(t);
      add({ id: JSON.stringify(["decision", t.id, signature]), task: t, kind: "decision", at: t.updated, body: str(t.reason), signature, text: resultText("decision", t, {}, t.reason) });
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
    if (!SHOWN.has(r.kind)) return false;
    // 첫 화면은 최근 하루만. 과거 전체를 새 소식으로 쏟아내지 않는다.
    if (!seen && r.at < now - 86400000) return false;
    if (r.kind === "decision") {
      if ((p.observedAt ?? 0) < (seen?.observedAt ?? 0)) return false;
      if (waitingOn(r.task, p)) return false;
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

// 한 변화를 확인해도 나머지 변화와 미해결 결정은 그대로 남긴다.
export function recordSnapshot(p, record, now = Date.now(), previous = null) {
  const seen = validSeen(previous), records = p.attentionRecords ?? importantRecords(p);
  if (seen && (p.observedAt ?? 0) < (seen.observedAt ?? 0)) return seen;
  const currentIds = new Set(records.map((r) => r.id));
  const ids = new Set(seen?.ids ?? []);
  if (currentIds.has(record.id)) ids.add(record.id);
  const decisions = { ...(seen?.decisions ?? {}) };
  if (currentIds.has(record.id) && record.kind === 'decision') decisions[record.task.id] = record.signature;
  return { version: 1, at: now, observedAt: p.observedAt ?? now, ids: [...ids], decisions };
}

export function digest(records) {
  const count = (kind) => new Set(records.filter((r) => r.kind === kind).map((r) => r.task.id)).size;
  return [{ kind: "qa", label: "QA 통과", count: count("qa") }, { kind: "merged", label: "병합 완료", count: count("merged") }, { kind: "closed", label: "결정 종결", count: count("closed") }, { kind: "rework", label: "재작업", count: count("rework") },
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
    activity: ({ working: "작업 중", done: "응답 완료", idle: "대기", blocked: "입력 필요", error: "오류" })[terminal.status] ?? "상태 미확인" };
}
