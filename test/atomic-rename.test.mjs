import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionStore } from '../core/decision-store.js';
const { renameRetry } = createRequire(import.meta.url)('../core/atomic-rename.cjs');

const dir = (t) => {
  const d = mkdtempSync(join(tmpdir(), 'hh-atomic-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const failure = (code) => Object.assign(new Error(`${code}: rename`), { code });
// 처음 fails번은 code로 실패하고 그 뒤는 실제 rename을 한다. 시험마다 복원한다.
function flaky(t, code, fails) {
  const real = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => { calls++; if (calls <= fails) throw failure(code); return real(from, to); });
  return () => calls;
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`${code} 일시 실패 뒤 다시 시도해 rename에 성공한다`, (t) => {
    const d = dir(t), from = join(d, 'a.tmp'), to = join(d, 'a.json');
    writeFileSync(to, 'old'); writeFileSync(from, 'new');
    const calls = flaky(t, code, 2);
    renameRetry(from, to, { delay: 1 });
    assert.equal(calls(), 3);
    assert.equal(readFileSync(to, 'utf8'), 'new');
    assert.deepEqual(readdirSync(d), ['a.json']);
  });
}

test('계속 실패하면 정해진 횟수 뒤 마지막 오류를 던진다', (t) => {
  const d = dir(t), from = join(d, 'a.tmp'), to = join(d, 'a.json');
  writeFileSync(to, 'old'); writeFileSync(from, 'new');
  const calls = flaky(t, 'EPERM', Infinity);
  assert.throws(() => renameRetry(from, to, { retries: 3, delay: 1 }), { code: 'EPERM' });
  assert.equal(calls(), 4);
  assert.equal(readFileSync(to, 'utf8'), 'old');
});

test('목록 밖 오류는 기다리지 않고 바로 던진다', (t) => {
  const d = dir(t);
  const calls = flaky(t, 'ENOENT', Infinity);
  assert.throws(() => renameRetry(join(d, 'x'), join(d, 'y')), { code: 'ENOENT' });
  assert.equal(calls(), 1);
});

// 결정함 저장(decision resolve) 경로에서 같은 잠금이 풀리면 revision 2가 저장되고, 끝내 안 풀리면 원본과 임시 파일 정리가 유지된다.
function decisions(t) {
  const stateDir = dir(t);
  const ledger = { version: 1, project: 'fixture', lead: { terminal: 't1' }, tasks: {} };
  const call = (v) => decisionStore({ stateDir, project: 'fixture', ledger, by: 't1', at: '2026-01-01T00:00:00Z', id: 'q', ...v });
  call({ action: 'request', input: { question: 'Scope?', source: 'fixture' } });
  return { stateDir, file: join(stateDir, 'decisions.json'), call };
}
const resolve = { action: 'resolve', revision: 1, input: { quote: 'Yes', source: 'fixture' } };

test('decision resolve는 rename 일시 EPERM 뒤 revision 2를 저장하고 임시 파일을 남기지 않는다', (t) => {
  const f = decisions(t);
  flaky(t, 'EPERM', 2);
  f.call(resolve);
  const saved = JSON.parse(readFileSync(f.file, 'utf8')).requests.q;
  assert.equal(saved.revision, 2);
  assert.equal(saved.status, 'resolved');
  assert.deepEqual(readdirSync(f.stateDir), ['decisions.json']);
});

test('decision resolve는 rename이 계속 실패하면 오류를 내고 원본을 보존하며 임시 파일을 지운다', (t) => {
  const f = decisions(t), before = readFileSync(f.file);
  const calls = flaky(t, 'EPERM', Infinity);
  assert.throws(() => f.call(resolve), { code: 'EPERM' });
  assert.equal(calls(), 21);
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(readdirSync(f.stateDir), ['decisions.json']);
});
