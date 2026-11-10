import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../scripts/build.mjs';
import { run } from '../core/process.js';
import { validateLedger } from '../core/contract.js';
const require = createRequire(import.meta.url);
const { plan, archive, restore } = require('../core/ledger-archive.cjs');
const { ledgerArchive } = require('../adapters/runtime.cjs');
const NOW = '2026-11-10T00:00:00.000Z';
const day = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();
const task = (id, state, age, extra = {}) => ({
  id, project: 'fx', title: id, state, updated: day(age), created: day(age + 1), depends: [], current: null, description: 'x'.repeat(2000),
  candidate: { head: 'h', fingerprint: 'f', paths: ['a'] }, approval: { by: 'user', at: day(age + 1), quote: '승인' },
  runs: [{ stage: 'research', round: 1, model: 'm1', evidence: { models: ['m1'] } }, { stage: 'qa', round: 1, cli: 'codex', model: 'm2', outcome: 'PASS', fingerprint_end: 'f', evidence: {} }],
  history: [{ at: day(age + 1), from: 'QUEUED', to: 'RESEARCHING' }, { at: day(age), from: 'QA', to: 'DONE', why: 'PASS' }], ...extra,
});
const ledger = () => ({ version: 1, project: 'fx', seq: 9, lead: { terminal: null }, tasks: Object.fromEntries([
  task('T-1', 'DONE', 10), task('T-2', 'DONE', 9), task('T-3', 'FAILED', 8), task('T-4', 'DONE', 7), task('T-5', 'DONE', 0.5),
  task('T-6', 'DONE', 6), task('T-7', 'QA', 1, { depends: ['T-2'] }),
].map((t) => [t.id, t])) });

test('최근·의존·진행 중·호출자 보존 업무를 빼고 오래 끝난 업무만 보관 대상으로 고른다', () => {
  assert.deepEqual(plan(ledger(), { now: NOW, keep_recent: 1 }), ['T-6', 'T-4', 'T-3', 'T-1']);
  assert.deepEqual(plan(ledger(), { now: NOW, keep_recent: 1, keep: ['T-4'] }), ['T-6', 'T-3', 'T-1']);
  assert.deepEqual(plan(ledger(), { now: NOW }), ['T-1']);
});

test('보관하면 화면용 요약만 남기고 원본을 지문과 함께 복원할 수 있다', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'herdr-ledger-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const before = ledger(), r = archive(before, stateDir, { now: NOW, keep_recent: 1 });
  assert.deepEqual(r.moved, ['T-6', 'T-4', 'T-3', 'T-1']); assert.ok(r.after < r.before);
  validateLedger(r.ledger, 'fx');
  const s = r.ledger.tasks['T-1'];
  assert.deepEqual([s.state, s.title, s.approval.quote, s.runs.length, s.runs[0].model, s.runs[0].outcome, s.history.length, s.history[0].to], ['DONE', 'T-1', '승인', 1, 'm2', 'PASS', 1, 'DONE']);
  assert.equal(s.description, undefined); assert.equal(s.candidate, undefined); assert.equal(s.runs[0].evidence, undefined);
  assert.deepEqual(r.ledger.tasks['T-7'], before.tasks['T-7']);
  assert.ok(existsSync(join(stateDir, 'archive/tasks/T-1.json')));
  assert.deepEqual(restore(s, stateDir), before.tasks['T-1']);
  assert.equal(restore(before.tasks['T-7'], stateDir), before.tasks['T-7']);
  // 이미 보관한 업무는 다시 고르지 않고, 같은 원본의 재시도는 기존 파일을 재사용한다.
  assert.deepEqual(plan(r.ledger, { now: NOW, keep_recent: 1 }), []);
  assert.deepEqual(archive(before, stateDir, { now: NOW, ids: ['T-1'] }).moved, ['T-1']);
  // FAILED→QUEUED로 다시 열었다가 다시 끝난 업무는 기존 보관본을 덮어쓰지 않고 지문을 붙인 파일에 쓴다.
  const changed = ledger(); changed.tasks['T-1'].title = '다른 내용';
  const again = archive(changed, stateDir, { now: NOW, ids: ['T-1'] }).ledger.tasks['T-1'];
  assert.match(again.x_archive.file, /^archive\/tasks\/T-1\.[0-9a-f]{12}\.json$/);
  assert.equal(restore(again, stateDir).title, '다른 내용'); assert.deepEqual(restore(s, stateDir), before.tasks['T-1']);
  assert.throws(() => restore({ ...again, x_archive: { ...again.x_archive, file: '../ledger.json' } }, stateDir), /경로/);
  assert.throws(() => archive(before, stateDir, { now: NOW, ids: ['T-7'] }), /보관할 수 없는/);
  writeFileSync(join(stateDir, 'archive/tasks/T-3.json'), '{}');
  assert.throws(() => restore(r.ledger.tasks['T-3'], stateDir), /지문/);
});

test('binding으로 고정한 대장 보관 규칙은 JSON 진입점에서 같고 경계 변조를 거부한다', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'herdr-ledger-binding-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const built = build(), file = join(stateDir, 'harness-binding.json');
  writeFileSync(file, JSON.stringify({ version: 1, project: 'fx', release: built.release, manifestHash: built.manifestHash }));
  const input = { action: 'plan', project: 'fx', stateDir, ledger: ledger(), options: { now: NOW, keep_recent: 1 } };
  const r = run(process.execPath, ['adapters/runtime.cjs', file, 'ledger'], { input: JSON.stringify(input) });
  assert.equal(r.code, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), ledgerArchive(file, input));
  const done = ledgerArchive(file, { ...input, action: 'archive' });
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'archive/tasks/T-1.json'), 'utf8')).id, 'T-1');
  assert.equal(ledgerArchive(file, { ...input, action: 'restore', ledger: done.ledger, id: 'T-1' }).description.length, 2000);
  assert.throws(() => ledgerArchive(file, { ...input, ledger: { ...ledger(), project: 'other' } }), /프로젝트/);
  assert.throws(() => ledgerArchive(file, { ...input, project: 'other' }), /경계/);
});
