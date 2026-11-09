import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionStore } from '../core/decision-store.js';
import { decisionInbox } from '../core/decisions.js';
import { run } from '../core/process.js';

function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'herdr-core-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledger = { version: 1, project: 'fixture', lead: { terminal: 't1' }, tasks: { 'F-1': { state: 'DONE' } } };
  writeFileSync(join(stateDir, 'ledger.json'), JSON.stringify(ledger));
  const base = { stateDir, project: 'fixture', ledger, by: 't1', at: '2026-01-01T00:00:00Z' };
  return { stateDir, ledger, call: (v) => decisionStore({ ...base, ...v }) };
}
test('미등록·DONE 질문, 멱등성, revision, 명시 답변 해소가 UI와 같은 계약이다', (t) => {
  const f = fixture(t), before = readFileSync(join(f.stateDir, 'ledger.json'));
  const input = { question: '범위를 정해주세요', source: 'fixture 대화' };
  const first = f.call({ action: 'request', id: 'scope', input });
  assert.deepEqual(f.call({ action: 'request', id: 'scope', input }), first);
  f.call({ action: 'request', id: 'merge', input: { ...input, task: 'F-1' } });
  const changed = { ...input, question: '변경된 범위?' };
  assert.throws(() => f.call({ action: 'request', id: 'scope', input: changed }), /revision/);
  f.call({ action: 'request', id: 'scope', input: changed, revision: 1 });
  const answer = { quote: '좁게', source: 'fixture 사용자 답변' };
  assert.throws(() => f.call({ action: 'resolve', id: 'scope', input: answer, revision: 1 }), /revision/);
  const resolved = f.call({ action: 'resolve', id: 'scope', input: answer, revision: 2 });
  assert.deepEqual(f.call({ action: 'resolve', id: 'scope', input: answer, revision: 2 }), resolved);
  assert.throws(() => f.call({ action: 'request', id: 'scope', input }), /다시 열/);
  const raw = readFileSync(join(f.stateDir, 'decisions.json'), 'utf8');
  assert.deepEqual(decisionInbox(raw, 'fixture').requests.filter((r) => r.status === 'open').map((r) => r.id), ['merge']);
  assert.deepEqual(readFileSync(join(f.stateDir, 'ledger.json')), before);
});
test('권한·입력·용량·형식 오류는 이전 파일을 보존한다', (t) => {
  const f = fixture(t), file = join(f.stateDir, 'decisions.json');
  f.call({ action: 'request', id: 'q', input: { question: '질문', source: '출처' } });
  const before = readFileSync(file);
  for (const patch of [
    { by: 'intruder' }, { input: { question: '질문' } }, { input: { question: '질문', source: '출처', task: 'missing' } },
    { id: 'constructor' }, { input: { question: 'x'.repeat(8001), source: '출처' } },
  ]) assert.throws(() => f.call({ action: 'request', id: 'other', input: { question: '질문', source: '출처' }, ...patch }));
  assert.deepEqual(readFileSync(file), before);
  for (const raw of ['{', '{"version":1,"project":"other","requests":{}}']) {
    writeFileSync(file, raw);
    assert.throws(() => f.call({ action: 'request', id: 'q', input: { question: '질문', source: '출처' } }));
    assert.equal(readFileSync(file, 'utf8'), raw);
    assert.equal(decisionInbox(raw, 'fixture').status, 'error');
  }
});
test('공통 실행기는 인자 리터럴·종료 코드·timeout을 보존한다', () => {
  const literal = '한글 $(no) `no` & ;';
  const r = run(process.execPath, ['-e', 'process.stdout.write(process.argv[1]);process.exitCode=7', literal]);
  assert.equal(r.stdout, literal); assert.equal(r.code, 7);
  assert.equal(run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 100 }).code, 124);
});
