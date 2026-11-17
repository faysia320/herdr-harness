// 사용자 결정으로 QA 게이트를 예외 처리한 업무의 게시 허가·종결 공통 규칙. 대장 잠금·저장·사건 기록은 프로젝트 CLI가 맡는다.
// 계약 v1을 바꾸지 않는다. 표지는 x_ 필드(x_decision_publish, x_closure)로만 남기고, 상태는 공통 전이표가 이미 허용하는 BLOCKED→DONE을 쓴다.
const { spawnSync } = require('node:child_process');
const KIND = 'user-decision';
const fail = (message) => { throw new Error(message); };
const text = (value) => typeof value === 'string' ? value.trim() : '';
const ms = (at) => { const v = Date.parse(at ?? ''); return Number.isFinite(v) ? v : null; };

// 지금 막힘이 시작된 시각. 그 전에 남긴 결정은 다른 막힘에 대한 것이라 인정하지 않는다.
const blockedSince = (task) => ms([...(task.history ?? [])].reverse().find((h) => h.to === 'BLOCKED')?.at) ?? 0;
const current = (task) => {
  const r = task.x_decision_publish;
  return r?.by === 'user' && text(r.quote) && (ms(r.at) ?? -1) >= blockedSince(task) ? r : null;
};

// 사용자 결정 원문과 예외 처리한 QA 회차. 회차는 끝난 QA 실행이어야 하고 PASS는 예외 대상이 아니다.
function decision(task, evidence) {
  const quote = text(evidence?.quote), source = text(evidence?.source), reason = text(evidence?.qa_reason);
  if (!quote) fail('사용자 결정 원문(quote)이 필요하다. 사용자가 실제로 한 말을 그대로 적는다.');
  if (!source) fail('결정 출처(source)가 필요하다. 예: Lead 대화 2026-11-16, Herdr 하네스 모드 사용자 선택.');
  if (!reason) fail('예외 처리한 QA 사유(qa_reason)가 필요하다.');
  const round = Number(evidence?.qa_round);
  if (!Number.isInteger(round) || round < 1) fail(`예외 처리한 QA 회차(qa_round)는 1 이상의 정수여야 한다: ${evidence?.qa_round}`);
  const run = (task.runs ?? []).findLast((r) => r.stage === 'qa' && r.round === round);
  if (!run || run.status === 'running' || !run.outcome) fail(`${task.id}에 끝난 QA r${round} 실행이 없다.`);
  if (run.outcome === 'PASS') fail(`${task.id} QA r${round}는 PASS라 사용자 결정 예외 대상이 아니다. 일반 QA 통과 절차를 쓴다.`);
  return { by: 'user', quote, source, qa_round: round, qa_outcome: run.outcome, qa_reason: reason };
}

function blocked(task) {
  if (task?.state !== 'BLOCKED') fail(`${task?.id}는 ${task?.state} 상태다. 사용자 결정 게시·종결은 BLOCKED 업무에만 쓴다.`);
  if (task.current) fail(`${task.id}에 진행 중 실행이 있다. 수집하거나 중단한 뒤 기록한다.`);
}

// 게시 전 결정 기록. 상태는 바꾸지 않는다. 같은 막힘에서 다시 기록하면 새 결정으로 바꾼다.
function authorize(task, evidence, { now = new Date().toISOString() } = {}) {
  blocked(task);
  const record = { ...decision(task, evidence), at: now };
  const next = { ...task, x_decision_publish: record, updated: now };
  return { task: next, event: { at: now, project: task.project, task: task.id, event: 'x_decision_publish', x_decision_publish: record } };
}

// publish-check 판정. BLOCKED 업무는 지금 막힘에서 남긴 사용자 결정 기록이 있어야 게시할 수 있다.
// 다른 상태는 이 규칙의 판정 대상이 아니다(기존 게시 검사 그대로).
function gate(task) {
  if (task?.state === 'DONE') return { allowed: true, kind: task.x_closure?.kind ?? 'qa' };
  if (task?.state !== 'BLOCKED') return { allowed: true, kind: null };
  const record = current(task);
  if (record) return { allowed: true, kind: KIND, decision: record };
  return { allowed: false, kind: null,
    reason: `${task.id}는 BLOCKED 상태이고 지금 막힘에 대한 사용자 결정 게시 기록이 없다. 사용자 결정 원문으로 게시 허가를 먼저 기록하거나 막힘을 해소한다.` };
}

// gh pr view 결과의 필요한 값만 읽는다. HERDR_HARNESS_GH(JSON 배열)는 시험용 gh 대체 명령이다.
function viewPr(cwd, number, env = process.env) {
  if (!Number.isInteger(number) || number < 1) fail(`PR 번호가 올바르지 않다: ${number}`);
  const base = env.HERDR_HARNESS_GH ? JSON.parse(env.HERDR_HARNESS_GH) : ['gh'];
  const r = spawnSync(base[0], [...base.slice(1), 'pr', 'view', String(number), '--json', 'number,state,mergeCommit,mergedAt,url,headRefName'], {
    cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer: 4 << 20,
  });
  if (r.error || r.status !== 0) fail(`gh pr view ${number} 실패: ${r.error?.message ?? (r.stderr.trim() || `종료 코드 ${r.status}`)}`);
  return JSON.parse(r.stdout);
}

// 병합된 PR과 merge SHA를 근거로 BLOCKED→DONE을 만든다. 결정 원문·QA 회차는 인자로 주거나 게시 전 기록을 이어받는다.
function close(task, evidence, pr, { now = new Date().toISOString() } = {}) {
  blocked(task);
  const prior = current(task);
  const given = Object.fromEntries(['quote', 'source', 'qa_round', 'qa_reason'].filter((k) => evidence?.[k] !== undefined && evidence[k] !== '').map((k) => [k, evidence[k]]));
  const record = decision(task, { ...prior, ...given });
  const number = Number(evidence?.pr), sha = text(evidence?.merge_sha).toLowerCase();
  if (!Number.isInteger(number) || number < 1) fail(`병합된 PR 번호(pr)가 필요하다: ${evidence?.pr}`);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) fail(`merge SHA(merge_sha)는 7~40자리 16진수여야 한다: ${evidence?.merge_sha}`);
  if (pr?.number !== number) fail(`gh가 돌려준 PR 번호가 다르다: ${pr?.number} ≠ ${number}`);
  if (pr.state !== 'MERGED') fail(`PR #${number}가 병합되지 않았다(${pr.state}). 병합 뒤 종결한다.`);
  const oid = text(pr.mergeCommit?.oid).toLowerCase();
  if (!oid || !oid.startsWith(sha)) fail(`PR #${number}의 merge SHA ${oid || '(없음)'}가 주어진 ${sha}와 다르다.`);
  if (task.branch && pr.headRefName && pr.headRefName !== task.branch) fail(`PR #${number}의 브랜치 ${pr.headRefName}가 업무 브랜치 ${task.branch}와 다르다.`);
  const closure = { kind: KIND, at: now, ...record, decided_at: prior?.at ?? null,
    pr: number, url: pr.url ?? null, merge_sha: oid, merged_at: pr.mergedAt ?? null };
  const why = `사용자 결정 종결: QA r${record.qa_round} ${record.qa_outcome} 예외 · PR #${number} 병합 ${oid.slice(0, 12)}`;
  const next = { ...task, state: 'DONE', pending: null, awaiting: null, resume_state: null, blocked_reason: null, updated: now, x_closure: closure,
    history: [...(task.history ?? []), { at: now, from: 'BLOCKED', to: 'DONE', why, x_closure: KIND }] };
  return { task: next, event: { at: now, project: task.project, task: task.id, event: 'state', from: 'BLOCKED', to: 'DONE', why, x_closure: closure } };
}

module.exports = { KIND, authorize, gate, close, viewPr };
