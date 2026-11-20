import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decisionStore } from '../core/decision-store.js';
import { decisionInbox, resolvedForTask } from '../core/decisions.js';
import { run } from '../core/process.js';

function fixture(t, tasks = { 'F-1': { state: 'DONE' } }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'herdr-core-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledger = { version: 1, project: 'fixture', lead: { terminal: 't1' }, tasks };
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
test('업무별 해소 결정 조회: 전역·다른 업무·열린 질문을 빼고 store와 bridge가 같은 원문을 돌려주며 파일을 바꾸지 않는다', (t) => {
  const f = fixture(t, { 'F-1': { state: 'QA' }, 'F-2': { state: 'QUEUED' }, 'F-3': { state: 'QUEUED' } });
  const file = join(f.stateDir, 'decisions.json');
  const ask = (id, input) => f.call({ action: 'request', id, input: { question: `${id}?`, source: 'fixture 질문', ...input } });
  const resolve = (id, input, revision = 1) => f.call({ action: 'resolve', id, input: { source: 'fixture 사용자 답변', ...input }, revision });
  ask('global', {}); resolve('global', { quote: '전역 답' });
  ask('other', { task: 'F-2' }); resolve('other', { quote: '다른 업무 답' });
  ask('c-open', { task: 'F-1' });
  ask('b-pick', { task: 'f-1', options: [{ label: '배포 후 실기기 확인', impact: 'PASS를 막지 않는다' }, { label: 'QA에서 브라우저 실행' }] });
  ask('a-free', { task: 'F-1' });
  // 선택은 실제 선택지 label만 받는다. 선택지가 없는 질문의 자유 답변에는 선택을 만들지 않는다.
  const before = readFileSync(file);
  assert.throws(() => resolve('b-pick', { quote: 'x', selection: '배포 후' }), /selection/);
  assert.throws(() => resolve('a-free', { quote: 'x', selection: '아무거나' }), /selection/);
  assert.throws(() => resolve('b-pick', { quote: 'x', selection: '  ' }), /selection/);
  assert.deepEqual(readFileSync(file), before);
  const quote = '배포 후 "실기기"로 확인\n둘째 줄 \\ 역슬래시';
  const picked = resolve('b-pick', { quote, selection: ' 배포 후 실기기 확인 ' });
  assert.equal(picked.resolution.selection, '배포 후 실기기 확인');
  // 같은 입력 재시도는 멱등이고, 다른 선택·선택 생략으로 덮어쓰지 않는다.
  assert.deepEqual(resolve('b-pick', { quote, selection: '배포 후 실기기 확인' }), picked);
  assert.throws(() => resolve('b-pick', { quote, selection: 'QA에서 브라우저 실행' }), /이미 해소/);
  assert.throws(() => resolve('b-pick', { quote }), /이미 해소/);
  resolve('a-free', { quote: '자유 답변' });
  const expected = [
    { id: 'a-free', task: 'F-1', question: 'a-free?', selection: null, quote: '자유 답변', source: 'fixture 사용자 답변', revision: 2, resolvedAt: '2026-01-01T00:00:00Z' },
    { id: 'b-pick', task: 'f-1', question: 'b-pick?', selection: '배포 후 실기기 확인', quote, source: 'fixture 사용자 답변', revision: 2, resolvedAt: '2026-01-01T00:00:00Z' },
  ];
  const stored = readFileSync(file), ledgerBytes = readFileSync(join(f.stateDir, 'ledger.json'));
  // 읽기는 Lead 확인 없이 허용한다(by 없음). 업무 ID 대소문자는 구분하지 않는다.
  const read = (task) => decisionStore({ stateDir: f.stateDir, project: 'fixture', ledger: f.ledger, action: 'resolved-for-task', task });
  assert.deepEqual(read('F-1'), expected);
  assert.deepEqual(read('f-1'), expected);
  assert.deepEqual(read('F-3'), []);
  assert.throws(() => read('F-9'), /작업이 없다/);
  assert.throws(() => read(undefined), /작업이 없다/);
  const bridge = (input) => run(process.execPath, [fileURLToPath(new URL('../bin/decision-bridge.mjs', import.meta.url))], { input: JSON.stringify({ stateDir: f.stateDir, project: 'fixture', ledger: f.ledger, ...input }) });
  const piped = bridge({ action: 'resolved-for-task', task: 'F-1' });
  assert.equal(piped.code, 0, piped.stderr);
  assert.deepEqual(JSON.parse(piped.stdout), expected);
  const missing = bridge({ action: 'resolved-for-task', task: 'F-9' });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /작업이 없다/);
  assert.deepEqual([readFileSync(file), readFileSync(join(f.stateDir, 'ledger.json'))], [stored, ledgerBytes]);
  // selection이 없는 이전 해소 기록은 null로 읽고 quote에서 선택을 추측하지 않는다.
  const data = JSON.parse(stored);
  delete data.requests['b-pick'].resolution.selection;
  writeFileSync(file, JSON.stringify(data));
  assert.equal(read('F-1')[1].selection, null);
  assert.deepEqual(resolvedForTask(data, 'F-1').map((d) => d.id), ['a-free', 'b-pick']);
  // 손상·다른 프로젝트의 결정함은 0건이 아니라 오류다.
  for (const raw of ['{', '{"version":1,"project":"other","requests":{}}', JSON.stringify({ ...data, requests: { x: { ...data.requests['b-pick'], resolution: { ...data.requests['b-pick'].resolution, selection: '' } } } })]) {
    writeFileSync(file, raw);
    assert.throws(() => read('F-1'));
    assert.notEqual(bridge({ action: 'resolved-for-task', task: 'F-1' }).code, 0);
    assert.equal(readFileSync(file, 'utf8'), raw);
  }
});
test('공통 실행기는 인자 리터럴·종료 코드·timeout을 보존한다', () => {
  const literal = '한글 $(no) `no` & ;';
  const r = run(process.execPath, ['-e', 'process.stdout.write(process.argv[1]);process.exitCode=7', literal]);
  assert.equal(r.stdout, literal); assert.equal(r.code, 7);
  assert.equal(run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 100 }).code, 124);
});
