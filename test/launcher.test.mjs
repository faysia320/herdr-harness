import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../scripts/build.mjs';
import { run, runTree } from '../core/process.js';
import { install } from '../scripts/install.mjs';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ok, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (ok()) return true; return ok(); };

// git worktree add 아래 reset --hard처럼 자식이 띄운 오래 걸리는 손자 프로세스를 흉내 낸다.
// Windows에서 Node 손자는 자식의 job object와 함께 끝나므로 git처럼 job을 벗어나게(detached) 띄운다.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-launcher-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'grandchild.pid'), script = join(dir, 'adapter.mjs');
  writeFileSync(script, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'quick') { process.stdout.write('{"ok":true}'); process.exit(0); }
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform === 'win32' });
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1000);`);
  return { dir, pidFile, script };
}

test('시간 한도를 넘기면 자식이 띄운 손자 프로세스까지 끝내고 124로 알린다', async (t) => {
  const f = fixture(t);
  const r = await runTree(process.execPath, [f.script], { timeout: 1500 });
  assert.equal(r.code, 124); assert.match(r.stderr, /하위 프로세스까지 종료/);
  const pid = Number(readFileSync(f.pidFile, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 종료됨 */ } });
  assert.ok(await until(() => !alive(pid)), `손자 프로세스 ${pid}가 남았다`);
  const ok = await runTree(process.execPath, [f.script, 'quick'], { timeout: 10000 });
  assert.deepEqual([ok.code, ok.stdout], [0, '{"ok":true}']);
  assert.equal((await runTree(join(f.dir, 'missing.exe'), [], { timeout: 1000 })).code, 127);
  assert.equal((await runTree(process.execPath, [f.script, 'quick'], { timeout: 2147483648 })).code, 127);
});

test('설치 계획의 연결 timeout을 binding에 쓰고 런처가 그 한도로 실행한다', async (t) => {
  const f = fixture(t), state = join(f.dir, 'state'), file = join(state, 'harness-binding.json');
  const plan = { store: join(f.dir, 'store'), modPath: join(f.dir, 'mods', 'harness'),
    bindings: [{ project: 'fixture', file, cwd: f.dir, command: [process.execPath, f.script], timeout: 1500 }] };
  for (const timeout of [-1, 0, 1.5, 2147483648]) assert.throws(() => install({ ...plan, bindings: [{ ...plan.bindings[0], timeout }] }, { check: () => {} }), /timeout/);
  assert.equal(existsSync(file), false);
  const done = install(plan, { check: () => {} });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).timeout, 1500);
  const started = Date.now();
  const r = run(process.execPath, [join(done.release, 'bin/harness.mjs'), '--binding', file, 'dispatch'], { timeout: 60000, env: { ...process.env, HERDR_PREPARATION_DIR: join(f.dir, 'prepare') } });
  assert.equal(r.code, 124, r.stderr); assert.ok(Date.now() - started < 30000);
  const pid = Number(readFileSync(f.pidFile, 'utf8'));
  assert.ok(await until(() => !alive(pid)), `손자 프로세스 ${pid}가 남았다`);
  assert.equal(run(process.execPath, [join(done.release, 'bin/harness.mjs'), '--binding', file, 'quick']).stdout, '{"ok":true}');
});
