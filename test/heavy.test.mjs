import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
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
  const dir = temp(t), env = { ...process.env, HERDR_HEAVY_DIR: dir };
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
  release(held[1]);
  assert.equal(run(process.execPath, [heavy], { env }).code, 2);
  assert.deepEqual(JSON.parse(run(process.execPath, [heavy, 'status'], { env }).stdout).slots, [{ index: 0, free: true }, { index: 1, free: true }]);
});
