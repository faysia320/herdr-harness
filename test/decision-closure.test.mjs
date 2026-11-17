import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../scripts/build.mjs';
import { run } from '../core/process.js';
import { TRANSITIONS, validateLedger } from '../core/contract.js';
const require = createRequire(import.meta.url);
const { authorize, gate, close, viewPr } = require('../core/decision-closure.cjs');
const { plan, archive } = require('../core/ledger-archive.cjs');
const { decisionClosure } = require('../adapters/runtime.cjs');
const NOW = '2026-11-17T03:00:00.000Z', SHA = 'abcdef0123456789abcdef0123456789abcdef01';
// SW-0106 모양: QA r3 FAIL·재작업 상한으로 BLOCKED decision.
const blocked = (extra = {}) => ({
  id: 'T-6', project: 'fx', title: 'T-6', state: 'BLOCKED', awaiting: 'decision', resume_state: 'QA', pending: 'implement', blocked_reason: '재작업 상한 2회 도달 — QA FAIL',
  branch: 'codex/t-6', current: null, depends: [], created: '2026-11-15T00:00:00.000Z', updated: '2026-11-16T12:23:24.146Z',
  runs: [{ stage: 'qa', round: 2, status: 'done', outcome: 'FAIL' }, { stage: 'qa', round: 3, status: 'done', outcome: 'FAIL' }],
  history: [{ at: '2026-11-16T12:10:07.909Z', from: 'BLOCKED', to: 'QA', why: '재개' }, { at: '2026-11-16T12:23:24.146Z', from: 'QA', to: 'BLOCKED', why: '재작업 상한 2회 도달 — QA FAIL' }],
  ...extra,
});
const evidence = { quote: 'AC-4 정정하고 PR 게시해', source: 'Lead 대화 2026-11-16', qa_round: 3, qa_reason: 'AC-4 최소 높이 기준 정정' };
const pr = { number: 1013, state: 'MERGED', mergeCommit: { oid: SHA }, mergedAt: '2026-11-16T14:00:00Z', url: 'https://example.test/pr/1013', headRefName: 'codex/t-6' };

test('근거 없는 BLOCKED 업무는 게시를 거부하고 지금 막힘의 사용자 결정 기록이 있으면 허용한다', () => {
  assert.equal(gate(blocked()).allowed, false);
  assert.match(gate(blocked()).reason, /사용자 결정 게시 기록이 없다/);
  const r = authorize(blocked(), evidence, { now: NOW });
  assert.equal(r.task.state, 'BLOCKED'); assert.equal(r.task.updated, NOW);
  assert.deepEqual(r.task.x_decision_publish, { by: 'user', quote: evidence.quote, source: evidence.source, qa_round: 3, qa_outcome: 'FAIL', qa_reason: evidence.qa_reason, at: NOW });
  assert.equal(r.event.event, 'x_decision_publish');
  assert.deepEqual([gate(r.task).allowed, gate(r.task).kind], [true, 'user-decision']);
  // 이전 막힘에서 남긴 결정은 새 막힘의 게시 근거가 아니다.
  const reblocked = { ...r.task, history: [...r.task.history, { at: '2026-11-17T04:00:00.000Z', from: 'QA', to: 'BLOCKED', why: '다시 막힘' }] };
  assert.equal(gate(reblocked).allowed, false);
  // DONE·진행 상태는 이 규칙의 판정 대상이 아니다.
  assert.deepEqual(gate({ id: 'D', state: 'DONE' }), { allowed: true, kind: 'qa' });
  assert.deepEqual(gate({ id: 'Q', state: 'QA' }), { allowed: true, kind: null });
});

test('결정 기록은 원문·출처·사유와 끝난 비PASS QA 회차를 요구하고 BLOCKED·실행 없음에서만 받는다', () => {
  for (const k of ['quote', 'source', 'qa_reason']) assert.throws(() => authorize(blocked(), { ...evidence, [k]: ' ' }), new RegExp(k));
  assert.throws(() => authorize(blocked(), { ...evidence, qa_round: 0 }), /qa_round/);
  assert.throws(() => authorize(blocked(), { ...evidence, qa_round: 9 }), /QA r9 실행이 없다/);
  assert.throws(() => authorize(blocked({ runs: [{ stage: 'qa', round: 3, status: 'done', outcome: 'PASS' }] }), evidence), /PASS/);
  assert.throws(() => authorize(blocked({ runs: [{ stage: 'qa', round: 3, status: 'running', outcome: null }] }), evidence), /끝난 QA/);
  assert.throws(() => authorize(blocked({ state: 'QA' }), evidence), /BLOCKED 업무에만/);
  assert.throws(() => authorize(blocked({ current: { stage: 'qa', run: 1 } }), evidence), /진행 중 실행/);
});

test('병합된 PR과 merge SHA로 BLOCKED를 사용자 결정 종결 DONE으로 만들고 일반 QA 통과와 구분한다', () => {
  const r = close(blocked(), { ...evidence, pr: 1013, merge_sha: SHA.slice(0, 7) }, pr, { now: NOW });
  const t = r.task;
  assert.deepEqual([t.state, t.awaiting, t.resume_state, t.blocked_reason, t.pending, t.updated], ['DONE', null, null, null, null, NOW]);
  assert.deepEqual(t.x_closure, { kind: 'user-decision', at: NOW, by: 'user', quote: evidence.quote, source: evidence.source, qa_round: 3, qa_outcome: 'FAIL',
    qa_reason: evidence.qa_reason, decided_at: null, pr: 1013, url: pr.url, merge_sha: SHA, merged_at: pr.mergedAt });
  assert.deepEqual(t.history.at(-1), { at: NOW, from: 'BLOCKED', to: 'DONE', why: `사용자 결정 종결: QA r3 FAIL 예외 · PR #1013 병합 ${SHA.slice(0, 12)}`, x_closure: 'user-decision' });
  assert.deepEqual([r.event.event, r.event.from, r.event.to, r.event.x_closure.pr], ['state', 'BLOCKED', 'DONE', 1013]);
  assert.ok(TRANSITIONS.BLOCKED.includes('DONE'));
  assert.deepEqual(gate(t), { allowed: true, kind: 'user-decision' });
  // 계약 v1 대장으로 그대로 읽히고, 끝난 업무로 보관되며 요약에 표지가 남는다.
  const ledger = { version: 1, project: 'fx', seq: 6, tasks: { 'T-6': t } };
  validateLedger(ledger, 'fx');
  assert.deepEqual(plan(ledger, { now: '2026-11-19T00:00:00.000Z', keep_recent: 0 }), ['T-6']);
  const dir = mkdtempSync(join(tmpdir(), 'herdr-closure-'));
  try {
    const s = archive(ledger, dir, { now: '2026-11-19T00:00:00.000Z', ids: ['T-6'] }).ledger.tasks['T-6'];
    assert.deepEqual([s.x_closure.kind, s.x_closure.pr, s.history[0].x_closure], ['user-decision', 1013, 'user-decision']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('게시 전 결정 기록을 종결이 이어받고 PR 근거가 맞지 않으면 종결하지 않는다', () => {
  const authorized = authorize(blocked(), evidence, { now: '2026-11-16T13:00:00.000Z' }).task;
  const t = close(authorized, { pr: 1013, merge_sha: SHA }, pr, { now: NOW }).task;
  assert.deepEqual([t.x_closure.quote, t.x_closure.qa_round, t.x_closure.decided_at], [evidence.quote, 3, '2026-11-16T13:00:00.000Z']);
  const e = { ...evidence, pr: 1013, merge_sha: SHA };
  assert.throws(() => close(blocked(), { pr: 1013, merge_sha: SHA }, pr), /quote/);
  assert.throws(() => close(blocked(), { ...e, merge_sha: 'xyz' }, pr), /merge_sha/);
  assert.throws(() => close(blocked(), { ...e, pr: undefined }, pr), /PR 번호/);
  assert.throws(() => close(blocked(), e, { ...pr, number: 1012 }), /PR 번호가 다르다/);
  assert.throws(() => close(blocked(), e, { ...pr, state: 'OPEN' }), /병합되지 않았다/);
  assert.throws(() => close(blocked(), { ...e, merge_sha: 'abcdef1' }, { ...pr, mergeCommit: { oid: 'f'.repeat(40) } }), /merge SHA/);
  assert.throws(() => close(blocked(), e, { ...pr, headRefName: 'other' }), /브랜치/);
  assert.throws(() => close(blocked({ state: 'DONE' }), e, pr), /BLOCKED 업무에만/);
});

test('binding으로 고정한 결정 종결 규칙은 JSON 진입점에서 같고 PR은 release 쪽 gh 조회로만 확인한다', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'herdr-closure-binding-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const built = build(), file = join(stateDir, 'harness-binding.json');
  writeFileSync(file, JSON.stringify({ version: 1, project: 'fx', release: built.release, manifestHash: built.manifestHash }));
  const fake = join(stateDir, 'gh.mjs');
  writeFileSync(fake, `process.stdout.write(JSON.stringify(${JSON.stringify(pr)}));`);
  const env = { ...process.env, HERDR_HARNESS_GH: JSON.stringify([process.execPath, fake]) };
  const input = { action: 'gate', project: 'fx', stateDir, task: blocked() };
  const r = run(process.execPath, ['adapters/runtime.cjs', file, 'closure'], { input: JSON.stringify(input) });
  assert.equal(r.code, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), decisionClosure(file, input));
  const closeInput = { ...input, action: 'close', cwd: stateDir, now: NOW, evidence: { ...evidence, pr: 1013, merge_sha: SHA }, pr_view: { ...pr, state: 'OPEN' } };
  const c = run(process.execPath, ['adapters/runtime.cjs', file, 'closure'], { input: JSON.stringify(closeInput), env });
  assert.equal(c.code, 0, c.stderr); assert.equal(JSON.parse(c.stdout).task.state, 'DONE');
  assert.equal(viewPr(stateDir, 1013, env).mergeCommit.oid, SHA);
  assert.throws(() => decisionClosure(file, { ...closeInput, cwd: 'relative' }), /cwd/);
  assert.throws(() => decisionClosure(file, { ...input, task: { ...blocked(), project: 'other' } }), /업무 프로젝트/);
  assert.throws(() => decisionClosure(file, { ...input, project: 'other' }), /경계/);
});
