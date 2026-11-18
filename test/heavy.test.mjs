import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tryAcquire, release, status } from '../core/heavy-slots.mjs';
import { run } from '../core/process.js';

const heavy = fileURLToPath(new URL('../bin/heavy.mjs', import.meta.url));
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'herdr-heavy-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const info = (pid = process.pid) => ({ pid, cwd: 'x', command: 'test', started: new Date().toISOString() });
const deadPid = () => { const r = spawn(process.execPath, ['-e', '0']); return new Promise((resolve) => r.on('exit', () => resolve(r.pid))); };

test('슬롯 수만큼만 점유하고 해제한 슬롯은 다시 쓴다', (t) => {
  const dir = temp(t);
  const a = tryAcquire(dir, 2, info()), b = tryAcquire(dir, 2, info());
  assert.deepEqual([a.index, b.index], [0, 1]);
  assert.equal(tryAcquire(dir, 2, info()), null);
  release(a);
  assert.equal(tryAcquire(dir, 2, info()).index, 0);
  assert.deepEqual(status(dir, 2).map((s) => s.alive), [true, true]);
});

test('점유 프로세스가 사라진 슬롯은 회수하고 남의 점유는 해제하지 않는다', async (t) => {
  const dir = temp(t);
  const stale = tryAcquire(dir, 1, info(await deadPid()));
  const mine = tryAcquire(dir, 1, info());
  assert.equal(mine.index, 0);
  release(stale);
  assert.equal(status(dir, 1)[0].pid, process.pid);
  assert.deepEqual(readdirSync(dir), ['slot-0.json']);
});

test('CLI는 슬롯이 빌 때까지 기다렸다가 명령을 실행하고 종료 코드를 그대로 돌려준 뒤 슬롯을 비운다', async (t) => {
  const dir = temp(t), metrics = temp(t), env = { ...process.env, HERDR_HEAVY_DIR: dir, HERDR_METRICS_DIR: metrics };
  const held = [tryAcquire(dir, 2, info()), tryAcquire(dir, 2, info())];
  const child = spawn(process.execPath, [heavy, '--', 'node -e "process.exit(3)"'], { env, windowsHide: true });
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(child.exitCode, null, '두 슬롯이 모두 사용 중이면 시작하지 않는다');
  assert.match(stderr, /모두 사용 중/);
  release(held[0]);
  assert.equal(await exited, 3);
  assert.match(stderr, /슬롯 1\/2에서 실행/);
  assert.equal(existsSync(join(dir, 'slot-0.json')), false);
  // 슬롯 대기와 실행 시간을 나눠 기록한다.
  const metric = JSON.parse(readFileSync(join(metrics, 'heavy.jsonl'), 'utf8'));
  assert.deepEqual([metric.slot, metric.exit, metric.label], [0, 3, 'node']);
  assert.equal(readFileSync(join(metrics, 'heavy.jsonl'), 'utf8').includes('process.exit'), false, '명령 원문을 남기지 않는다');
  assert.ok(metric.wait_ms >= 1000, `wait_ms ${metric.wait_ms}`);
  release(held[1]);
  // 등록되지 않은 프로그램의 인자 값은 작업 이름으로 복사하지 않는다.
  assert.equal(run(process.execPath, [heavy, '--', 'echo ReviewCanary'], { env }).code, 0);
  const lines = readFileSync(join(metrics, 'heavy.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.label), ['node', 'echo']);
  assert.equal(readFileSync(join(metrics, 'heavy.jsonl'), 'utf8').includes('ReviewCanary'), false);
  // 공백이 든 따옴표 할당의 값은 셸 종류와 무관하게 이름으로 남지 않는다(Windows 기본 셸에서는 이 명령 자체가 실패해도 기록된다).
  run(process.execPath, [heavy, '--', 'GIT_AUTHOR_NAME="First Middle Last" echo ok'], { env });
  const raw = readFileSync(join(metrics, 'heavy.jsonl'), 'utf8');
  assert.equal(JSON.parse(raw.trim().split('\n').at(-1)).label, 'unknown');
  for (const word of ['First', 'Middle', 'Last', 'GIT_AUTHOR_NAME']) assert.equal(raw.includes(word), false, word);
  // 앞쪽 리디렉션 경로와 줄 바꿈 없는 공백으로 나뉜 할당 값도 이름으로 남지 않는다. 리디렉션 파일은 임시 폴더에만 만든다.
  const work = temp(t); mkdirSync(join(work, 'reports'));
  run(process.execPath, [heavy, '--', `>reports${process.platform === 'win32' ? '\\' : '/'}ReviewOutput.log echo ok`], { env, cwd: work });
  run(process.execPath, [heavy, '--', 'GIT_AUTHOR_NAME=First Middle Last echo ok'], { env, cwd: work });
  // 할당에 붙은 리디렉션도 경로가 이름으로 남지 않는다.
  run(process.execPath, [heavy, '--', 'MODE=ci> reports/build-summary.log echo ok'], { env, cwd: work });
  const after = readFileSync(join(metrics, 'heavy.jsonl'), 'utf8');
  assert.deepEqual(after.trim().split('\n').slice(-3).map((l) => JSON.parse(l).label), ['unknown', 'unknown', 'unknown']);
  for (const word of ['ReviewOutput', 'reports', 'Middle', 'First', 'build-summary', 'MODE']) assert.equal(after.includes(word), false, word);
  assert.equal(run(process.execPath, [heavy], { env }).code, 2);
  assert.deepEqual(JSON.parse(run(process.execPath, [heavy, 'status'], { env }).stdout).slots, [{ index: 0, free: true }, { index: 1, free: true }]);
});
