import test from 'node:test';
import assert from 'node:assert/strict';
import { decisions, pausedTasks, blockedSummary, importantRecords, changes, snapshot, recordSnapshot, projectKey, digest, plainReason, leadTerminal, leadReport, decisionInbox, openRequests, waitingOn } from './attention.js';

const now = Date.parse('2026-11-09T02:00:00Z');
const task = (id, state, patch = {}) => ({ id, state, title: id, reason: '', awaiting: null, updated: now - 1000, runs: [], history: [], depends: [], ...patch });
const project = (tasks, events = []) => ({ name: 'fixture', projectId: 'fixture', root: 'D:/fixture', tasks, events, lead: 't7' });
const transition = (id, from, to, why = '', delta = 1000) => ({ task: id, from, to, why, at: now - delta });

test('막힌 업무의 QA 발견 근거는 같은 후보의 비통과 결과에서 가져온다', () => {
  const verification = { candidate: 'old', verdict: 'FAIL', findings: [{ evidence: 'run.test.mjs · 입력 누락' }] };
  const t = task('SW-1', 'BLOCKED', { candidate: { fingerprint: 'current' }, x_flow: { version: 2, phase: 'diagnose', verification } });
  const [d] = decisions(project([t]));
  assert.equal(blockedSummary(d).evidence, null);
  verification.candidate = 'current';
  assert.equal(blockedSummary(d).evidence, verification.findings[0].evidence);
  verification.verdict = 'PASS';
  assert.equal(blockedSummary(d).evidence, null);
});

test('명시적 사용자 중단은 결정에서 분리하며 결정 필드와 다른 막힘은 보존한다', () => {
  const p = project([
    task('paused', 'BLOCKED', { reason: '중단: 사용자 요청' }),
    task('question', 'BLOCKED', { reason: '중단: 사용자 요청', awaiting: 'decision' }),
    task('pending', 'BLOCKED', { reason: '중단: 사용자 요청', x_pending_decision: '범위를 골라 주세요' }),
    task('environment', 'BLOCKED', { reason: '중단: 환경 오류 — 사용자 결정 대기' }),
    task('archived', 'BLOCKED', { reason: '중단: 사용자 요청', archived: true }),
    task('done', 'DONE', { reason: '중단: 사용자 요청' }),
  ]);
  assert.deepEqual(pausedTasks(p).map((t) => t.id), ['paused']);
  assert.deepEqual(new Set(decisions(p).map((d) => d.task.id)), new Set(['question', 'pending', 'environment']));
});

test('한 변화 확인은 다른 미확인 결과·결정을 유지하고 오래된 화면은 최신 기준을 덮지 않는다', () => {
  const p = project([task('a', 'DONE'), task('b', 'FAILED'), task('c', 'BLOCKED', { reason: '선택 필요' })],
    [transition('a', 'QA', 'DONE', 'PASS'), transition('b', 'QA', 'FAILED', '실패')]);
  p.observedAt = now; p.attentionRecords = importantRecords(p);
  const before = JSON.stringify(p), qa = p.attentionRecords.find((r) => r.kind === 'qa');
  const read = recordSnapshot(p, qa, now);
  assert.equal(JSON.stringify(p), before); assert.equal(decisions(p).length, 1);
  assert.deepEqual(changes(p, read, now).map((r) => r.kind), ['failed']);
  const newer = { ...read, observedAt: now + 1, ids: [...read.ids, 'new-event'] };
  assert.equal(recordSnapshot(p, qa, now + 2, newer), newer);
  const restored = recordSnapshot({ ...p, observedAt: now + 3 }, qa, now + 4, newer);
  assert.ok(restored.ids.includes('new-event'));
});

test('현재 막힘만 결정함에 남고 직접 후속 영향·우선순위 순으로 정렬한다', () => {
  const p = project([task('a', 'BLOCKED', { awaiting: 'decision' }), task('b', 'BLOCKED', { priority: 20 }),
    task('c', 'QUEUED', { depends: ['a'] }), task('d', 'DONE', { awaiting: 'decision' }), task('e', 'BLOCKED', { archived: true })]);
  assert.deepEqual(decisions(p).map((d) => d.task.id), ['a', 'b']);
  assert.equal(decisions(p)[0].affected.length, 1);
  assert.equal(decisions(p)[0].kind, '방향 결정');
  assert.match(decisions(p)[0].reason, /기록되지/);
});

test('네 대기 종류를 구분하고 읽음은 대장이나 결정함을 바꾸지 않는다', () => {
  const p = project(['ac-approval', 'decision', 'permission', null].map((awaiting, i) => task(String(i), 'BLOCKED', { awaiting })));
  const before = JSON.stringify(p), seen = snapshot(p, now);
  assert.deepEqual(decisions(p).map((d) => d.kind), ['완료 기준 승인', '방향 결정', '권한 결정', '확인 필요']);
  assert.equal(decisions(p).length, 4); assert.equal(JSON.stringify(p), before);
  assert.equal(changes(p, seen, now).length, 0);
  p.tasks[0].state = 'IMPLEMENTING';
  assert.equal(decisions(p).length, 3);
});

test('event/history 중복은 합치고 같은 시각의 서로 다른 사건은 보존한다', () => {
  const e = transition('a', 'QA', 'DONE', 'PASS');
  const t = task('a', 'DONE', { history: [{ ...e, at: new Date(e.at).toISOString() }] });
  const p = project([t, task('b', 'FAILED')], [e, transition('b', 'IMPLEMENTING', 'FAILED', '실패')]);
  assert.equal(importantRecords(p).length, 2);
  assert.deepEqual(digest(importantRecords(p)).map((x) => x.kind).sort(), ['failed', 'qa']);
  assert.deepEqual(changes(p, null, now).map((r) => r.kind), ['failed']);
});

test('updated만 변경되면 새 소식이 아니며 같은 상태의 사유 변경은 다시 보인다', () => {
  const t = task('a', 'BLOCKED', { reason: '범위 선택', history: [transition('a', 'RESEARCHING', 'BLOCKED')] });
  const p = project([t]), seen = snapshot(p, now);
  t.updated = now + 1000;
  assert.equal(changes(p, seen, now).length, 0);
  t.reason = '권한 선택';
  assert.deepEqual(changes(p, seen, now).map((r) => r.kind), ['decision']);
});

test('해제 후 같은 이유로 다시 막혀도 새 회차가 보인다', () => {
  const t = task('a', 'BLOCKED', { reason: '선택', history: [transition('a', 'RESEARCHING', 'BLOCKED')] });
  const p = project([t]), seen = snapshot(p, now);
  t.history.push(transition('a', 'BLOCKED', 'IMPLEMENTING', '답변', 500), transition('a', 'IMPLEMENTING', 'BLOCKED', '선택', 100));
  assert.ok(changes(p, seen, now).some((r) => r.kind === 'blocked'));
});

test('사유 A를 읽고 B를 읽은 뒤 A로 돌아오면 새 변경이다', () => {
  const t = task('a', 'BLOCKED', { reason: 'A' }), p = project([t]);
  const first = snapshot(p, now);
  t.reason = 'B';
  const second = snapshot(p, now + 1, first);
  t.reason = 'A';
  assert.deepEqual(changes(p, second, now).map((r) => r.body), ['A']);
});

test('오래된 인스턴스의 읽음은 최신 사유의 확인 기준을 되돌리지 않는다', () => {
  const older = { ...project([task('a', 'BLOCKED', { reason: 'A' })]), observedAt: 100 };
  const newer = { ...project([task('a', 'BLOCKED', { reason: 'B' })]), observedAt: 200 };
  const first = snapshot(older, now), second = snapshot(newer, now + 1, first);
  const lateClick = snapshot(older, now + 2, second);
  assert.deepEqual(lateClick, second);
  assert.equal(changes(newer, lateClick, now).length, 0);
  assert.equal(changes(older, lateClick, now).length, 0);
});

test('처음은 하루 이내만, 확인 후 늦게 수집된 과거 사건도 누락하지 않는다', () => {
  const t = task('a', 'DONE', { history: [transition('a', 'QA', 'DONE', '오래된 결과', 90000000)] });
  const p = project([t]);
  assert.equal(changes(p, null, now).length, 0);
  const seen = snapshot(p, now);
  p.events.push(transition('a', 'QA', 'READY_TO_IMPLEMENT', '뒤늦게 수집', 100000000));
  assert.equal(changes(p, seen, now).length, 1);
});

test('사건 파일이 사라졌다 돌아와도 이미 확인한 사건을 반복하지 않는다', () => {
  const p = project([task('a', 'DONE')], [transition('a', 'QA', 'DONE')]);
  const first = snapshot(p, now), original = p.events;
  p.events = [];
  const second = snapshot(p, now + 1, first);
  p.events = original;
  assert.equal(changes(p, second, now).length, 0);
});

test('최근 결과에는 알아야 할 결과만 쉬운 문장으로 남고 막힌 사유의 기술 토큰은 빠진다', () => {
  const sha = 'a'.repeat(40), v2 = (phase, delivery = null) => ({ version: 2, phase, delivery });
  const rows = [
    ['merged', 'DONE', 'QA', `병합 SHA 확인: ${sha}`, { x_flow: v2('merged', { pr: 28, merge: sha }) }, {}, 'main에 병합됐어요 · PR #28'],
    ['older', 'DONE', 'QA', `병합 SHA 확인: ${sha}`, { x_flow: v2('merged', { pr: 99, merge: 'b'.repeat(40) }) }, {}, 'main에 병합됐어요'],
    ['accepted', 'DONE', 'QA', '사용자 승인 병합 종결', { x_flow: v2('closed') }, { closure: { kind: 'merged-accepted', pr: 30 } }, 'main에 병합됐어요 · PR #30'],
    ['local', 'DONE', 'QA', '로컬 종결(게시·병합 없음): 확인', { x_flow: v2('closed') }, { closure: { kind: 'local-only' } }, '게시 없이 마쳤어요'],
    ['ended', 'DONE', 'QA', '종료', { x_flow: v2('closed') }, {}, '업무를 마쳤어요'],
    ['closed', 'DONE', 'BLOCKED', '사용자 결정 종결', {}, { x_closure: 'user-decision' }, '사용자 결정으로 마쳤어요'],
    ['rework', 'READY_TO_IMPLEMENT', 'QA', 'code: 수정', {}, {}, 'QA에서 문제가 나와 다시 고치는 중'],
    ['failed', 'FAILED', 'IMPLEMENTING', 'exit 1', {}, {}, '실행이 실패했어요 · Lead 확인 필요'],
    ['blocked', 'BLOCKED', 'QA', '중단: 민감 경로 변경: core/a.cjs / 민감 경로 변경: test/b.mjs', { reason: '중단' }, {}, '확인이 필요해요 · 민감 경로 변경'],
    ['bare', 'BLOCKED', 'QA', `{"run":{"head":"${sha}"}}`, { reason: '중단' }, {}, '확인이 필요해요'],
    ['released', 'QA', 'QA', '중단: 환경', {}, {}, '확인이 필요했지만 지금은 풀렸어요'],
    ['passed', 'DONE', 'QA', 'PASS', {}, {}, null],
    ['waiting', 'BLOCKED', 'QA', '중단: 선행 대기 B-2: 순서', { reason: '중단: 선행 대기 B-2: 순서' }, {}, null],
    ['resolved', 'QA', 'BLOCKED', '답변', {}, {}, null],
  ];
  const tasks = rows.map(([id, state, from, why, patch, extra]) =>
    task(id, state, { ...patch, history: [{ ...transition(id, from, id === 'released' ? 'BLOCKED' : state, why), ...extra }] }));
  tasks.push(task('B-2', 'IMPLEMENTING', { approval: { by: 'user', quote: '승인', at: new Date(now).toISOString() }, runs: [{ status: 'done', note: '메모', ended: new Date(now).toISOString() }] }));
  const p = project(tasks), shown = changes(p, null, now);
  assert.deepEqual(Object.fromEntries(shown.map((r) => [r.task.id, r.text])), Object.fromEntries(rows.filter((r) => r[6]).map((r) => [r[0], r[6]])));
  // 같은 전이의 사건 행에 종결 근거가 없어도 업무 이력의 근거를 잃지 않는다.
  p.events = [transition('local', 'QA', 'DONE', '로컬 종결(게시·병합 없음): 확인')];
  assert.equal(importantRecords(p).find((r) => r.task.id === 'local').text, '게시 없이 마쳤어요');
  // 확인한 막힘이 선행 대기로 바뀐 것은 새 결과가 아니다.
  const waiting = p.tasks.find((t) => t.id === 'waiting'), reason = waiting.reason;
  waiting.reason = '범위 선택'; const seen = snapshot(p, now); waiting.reason = reason;
  assert.equal(changes(p, seen, now).length, 0);
  // 예전 판이 저장한 version 1 기록(빠진 종류 포함)도 그대로 읽는다.
  assert.equal(changes(p, { version: 1, at: now, ids: importantRecords(p).map((r) => r.id), decisions: {} }, now).length, 0);

  assert.equal(plainReason('code: `mod/harness/main.js`를 고친 뒤 C:\\Users\\a\\x.log와 0419dfdf를 확인(--apply)'), '고친 뒤 확인');
  assert.equal(plainReason('동시 실행 2/2 · CI/CD·준비/자원 20261125 확인'), '동시 실행 2/2 · CI/CD·준비/자원 20261125 확인');
  assert.equal(plainReason('가'.repeat(200)).length, 80);
});

test('확인 기준은 root/id로 분리되며 직렬화·두 인스턴스에 재사용된다', () => {
  const p = project([task('a', 'DONE')], [transition('a', 'QA', 'DONE')]);
  const second = JSON.parse(JSON.stringify(snapshot(p, now)));
  assert.equal(changes(p, second, now).length, 0);
  assert.equal(projectKey(p), projectKey({ ...p, root: 'd:\\fixture\\' }));
  assert.notEqual(projectKey(p), projectKey({ ...p, projectId: 'other' }));
  assert.notEqual(projectKey(p), projectKey({ ...p, root: 'D:/another' }));
});

test('QA 재작업·실패·QA 통과와 명시적 승인 근거만 분류한다', () => {
  const p = project([task('a', 'DONE', { approval: { by: 'auto', quote: '자동' } }), task('b', 'FAILED'), task('c', 'READY_TO_IMPLEMENT'),
    task('d', 'IMPLEMENTING', { approval: { by: 'user', quote: '신규 고객부터', at: new Date(now).toISOString() } })],
    [transition('a', 'QA', 'DONE'), transition('b', 'IMPLEMENTING', 'FAILED'), transition('c', 'QA', 'READY_TO_IMPLEMENT')]);
  const r = importantRecords(p);
  assert.deepEqual(r.map((x) => x.kind).sort(), ['approval', 'failed', 'qa', 'rework']);
  assert.equal(r.find((x) => x.kind === 'qa').title, '로컬 QA 통과');
  assert.ok(!JSON.stringify(r).includes('배포 완료'));
});

test('Lead는 연결이 존재하는 로컬 터미널만 대상으로 삼는다', () => {
  const p = project([]), live = new Map([['t7', { address: 't7' }], ['t8', { address: 't8', labels: { 'harness.project': 'other' } }]]);
  assert.equal(leadTerminal(p, live).address, 't7');
  assert.equal(leadTerminal(p, live, { x_lead: 't8' }), null);
  assert.equal(leadTerminal(p, live, { x_lead: 'missing' }), null);
});

test('DONE 뒤 병합·미등록 업무 질문은 BLOCKED 없이 Lead 보고에 보인다', () => {
  const p = project([task('SW-0045', 'DONE')]);
  const message = 'PR #793 준비됨; 병합 여부와 콜아웃 업무 답 대기';
  const t = { address: 't7', state: 'live', status: 'done', created_ms: 10, report: { app: 'claude-code', msg: message } };
  const live = new Map([['t7', t]]);
  assert.equal(decisions(p).length, 0);
  assert.equal(leadReport(p, live).text, message);
  p.tasks = []; t.status = 'idle';
  assert.equal(leadReport(p, live).text, message);
  t.report.msg = '범위 좁게 진행하기로 답변받음';
  assert.equal(leadReport(p, live).text, t.report.msg);
});

test('진행 중 상태는 직전 응답의 해결 증거가 아니며 새 응답만 기록을 교체한다', () => {
  const p = project([]), t = { address: 't7', state: 'live', status: 'done', created_ms: 10, report: { msg: '콜아웃 범위 답 대기' } };
  const live = new Map([['t7', t]]), previous = leadReport(p, live).remember;
  t.status = 'working'; t.report.msg = '다른 업무 QA';
  let report = leadReport(p, live, previous);
  assert.equal(report.text, '콜아웃 범위 답 대기'); assert.equal(report.progress, '다른 업무 QA'); assert.equal(report.retained, true);
  t.report = {}; assert.equal(leadReport(p, live, previous).text, previous.text);
  t.status = 'idle'; t.report.msg = '범위 답변 반영 완료';
  report = leadReport(p, live, previous);
  assert.equal(report.text, '범위 답변 반영 완료'); assert.equal(report.retained, false);
  t.created_ms = 20; t.report = {};
  assert.equal(leadReport(p, live, previous).available, false);
});

test('Lead 부재·다른 프로젝트·원격·stale·빈 보고를 질문 없음으로 판정하지 않는다', () => {
  const p = project([]), t = { address: 't7', state: 'live', status: 'done', report: { msg: '질문' } };
  const live = new Map([['t7', t]]);
  for (const candidate of [{ ...p, stale: true }, { ...p, lead: 'missing' }, { ...p, lead: 'remote/t7' }]) {
    const report = leadReport(candidate, live); assert.equal(report.available, false); assert.match(report.reason, /확인할 수 없습니다/);
  }
  t.labels = { 'harness.project': 'other' }; assert.equal(leadReport(p, live).available, false);
  t.labels = {}; t.report.msg = ' '; assert.equal(leadReport(p, live).available, false);
  t.report.msg = '질문'; t.state = 'exited'; assert.equal(leadReport(p, live).available, false);
});

test('질문별 기록은 DONE·보관·Lead 교체·새 보고·읽음과 독립적으로 명시 해소까지 유지한다', () => {
  const request = { id: 'callout-scope', question: '콜아웃 등록 여부와 범위?', source: 'fixture 실제 질문', task: null, options: [], status: 'open', revision: 1, created: new Date(now).toISOString() };
  const inbox = decisionInbox(JSON.stringify({ version: 1, project: 'fixture', requests: { [request.id]: request } }), 'fixture');
  const p = { ...project([task('a', 'DONE', { archived: true })]), requests: inbox.requests };
  snapshot(p, now); p.lead = 'new-lead';
  assert.equal(openRequests(p).length, 1);
  p.tasks = []; assert.equal(openRequests(p).length, 1);
  p.requests = [{ ...request, status: 'resolved', revision: 2, resolution: { quote: '좁게', source: 'fixture 답변' } }];
  assert.equal(openRequests(p).length, 0);
});

test('질문 파일 누락·잘못된 프로젝트·버전·입력은 정상 빈 결정함으로 숨기지 않는다', () => {
  assert.equal(decisionInbox(null, 'fixture').status, 'missing');
  for (const text of [undefined, '{broken', '{}', JSON.stringify({ version: 2, project: 'fixture', requests: {} }), JSON.stringify({ version: 1, project: 'other', requests: {} }), JSON.stringify({ version: 1, project: 'fixture', requests: { a: {} } })]) {
    assert.equal(decisionInbox(text, 'fixture').status, 'error');
  }
  assert.equal(decisionInbox(JSON.stringify({ version: 1, project: 'fixture', requests: {} }), 'fixture').status, 'ready');
});

test('«선행 대기 ID:» 표식으로 멈춘 업무는 선행 업무가 진행 중일 때만 결정함에서 빠진다', () => {
  const blocked = (why) => task('a', 'BLOCKED', { reason: `중단: 선행 대기 B-2, C-3: ${why}`, history: [transition('a', 'QA', 'BLOCKED', `중단: 선행 대기 B-2, C-3: ${why}`)] });
  const p = project([blocked('시험 수정 후 QA'), task('B-2', 'IMPLEMENTING'), task('C-3', 'DONE'), task('d', 'BLOCKED', { reason: '중단: B-2와 충돌, 순서 결정 필요' })]);
  assert.deepEqual(waitingOn(p.tasks[0], p), ['B-2']);
  assert.deepEqual(decisions(p).map((d) => d.task.id), ['d']);
  assert.equal(importantRecords(p).find((r) => r.task.id === 'a' && r.kind !== 'decision').title, '선행 업무 대기');
  p.tasks[1].state = 'DONE';
  assert.equal(waitingOn(p.tasks[0], p), null);
  assert.equal(decisions(p).find((d) => d.task.id === 'a').kind, '선행 업무 끝남 · 재개 필요');
  p.tasks[1].state = 'FAILED';
  assert.equal(decisions(p).find((d) => d.task.id === 'a').kind, '확인 필요');
  for (const reason of ['사용자 중단: 선행 대기 Z-9: 없음', '중단: SW-0108 병합 후 QA']) {
    const q = project([task('a', 'BLOCKED', { reason })]);
    assert.equal(waitingOn(q.tasks[0], q), null); assert.equal(decisions(q).length, 1);
  }
});

test('사용자 결정 종결 DONE은 결정함에서 빠지고 QA 통과와 다른 변화로 보인다', async () => {
  const { closedByDecision } = await import('./attention.js');
  const closure = { kind: 'user-decision', qa_round: 3, qa_outcome: 'FAIL', pr: 1013, merge_sha: 'abc', quote: 'AC-4 정정하고 PR 게시해' };
  const closed = task('a', 'DONE', { x_closure: closure, history: [transition('a', 'BLOCKED', 'DONE', '사용자 결정 종결', 500)].map((h) => ({ ...h, x_closure: 'user-decision' })) });
  const passed = task('b', 'DONE', { history: [transition('b', 'QA', 'DONE', 'PASS', 400)] });
  const p = project([closed, passed, task('c', 'QUEUED', { depends: ['a'] })], [{ ...transition('a', 'BLOCKED', 'DONE', '사용자 결정 종결', 500), x_closure: closure }]);
  assert.equal(decisions(p).length, 0);
  assert.deepEqual([closedByDecision(closed), closedByDecision(passed), closedByDecision(task('x', 'BLOCKED', { x_closure: closure }))], [true, false, false]);
  const records = importantRecords(p);
  assert.deepEqual(records.map((r) => [r.task.id, r.kind, r.title]), [['b', 'qa', '로컬 QA 통과'], ['a', 'closed', '사용자 결정 종결']]);
  assert.deepEqual(digest(records), [{ kind: 'qa', label: 'QA 통과', count: 1 }, { kind: 'closed', label: '결정 종결', count: 1 }]);
});
