import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../core/process.js';
import { validateLedger } from '../core/contract.js';
const require = createRequire(import.meta.url);
const { plan, archive, restore } = require('../core/ledger-archive.cjs');
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
// 폐지 전 사용자 결정 종결(x_closure)로 끝난 과거 업무. x_flow가 없다.
const closed = () => ({
  id: 'T-6', project: 'fx', title: 'T-6', state: 'DONE', awaiting: null, resume_state: null, pending: null, blocked_reason: null,
  branch: 'codex/t-6', current: null, depends: [], created: '2026-11-15T00:00:00.000Z', updated: '2026-11-17T03:00:00.000Z',
  runs: [{ stage: 'qa', round: 2, status: 'done', outcome: 'CONDITIONAL PASS' }, { stage: 'qa', round: 3, status: 'done', outcome: 'FAIL' }],
  history: [{ at: '2026-11-16T12:23:24.146Z', from: 'QA', to: 'BLOCKED', why: '재작업 상한 2회 도달 — QA FAIL' },
    { at: '2026-11-17T03:00:00.000Z', from: 'BLOCKED', to: 'DONE', why: '사용자 결정 종결: QA r3 FAIL 예외', x_closure: 'user-decision' }],
  x_decision_publish: { by: 'user', quote: 'AC-4 정정하고 PR 게시해', source: 'Lead 대화 2026-11-16', qa_round: 3, qa_outcome: 'FAIL', qa_reason: '기준 정정', at: '2026-11-16T13:00:00.000Z' },
  x_closure: { kind: 'user-decision', at: '2026-11-17T03:00:00.000Z', by: 'user', quote: 'AC-4 정정하고 PR 게시해', qa_round: 3, qa_outcome: 'FAIL', pr: 1013, merge_sha: SHA },
});

test('과거 사용자 결정 종결 기록은 대장으로 읽히고 보관 요약과 복원에서 유지된다', () => {
  const ledger = { version: 1, project: 'fx', seq: 6, tasks: { 'T-6': closed() } };
  validateLedger(ledger, 'fx');
  assert.deepEqual(plan(ledger, { now: '2026-11-19T00:00:00.000Z', keep_recent: 0 }), ['T-6']);
  const dir = mkdtempSync(join(tmpdir(), 'herdr-closure-'));
  try {
    const s = archive(ledger, dir, { now: '2026-11-19T00:00:00.000Z', ids: ['T-6'] }).ledger.tasks['T-6'];
    assert.deepEqual([s.x_closure.kind, s.x_closure.pr, s.history.at(-1).x_closure], ['user-decision', 1013, 'user-decision']);
    const full = restore(s, dir);
    assert.deepEqual([full.runs.map(r => r.outcome), full.x_decision_publish, full.x_closure], [['CONDITIONAL PASS', 'FAIL'], closed().x_decision_publish, closed().x_closure]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('폐지한 closure 진입점은 일반 결정함으로 넘어가지 않고 거부한다', () => {
  for (const action of ['authorize', 'gate', 'close']) {
    const r = run(process.execPath, ['adapters/runtime.cjs', 'binding.json', 'closure'], { input: JSON.stringify({ action, project: 'fx', task: closed() }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /폐지/);
  }
});
