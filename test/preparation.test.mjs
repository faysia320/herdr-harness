import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from '../scripts/build.mjs';
import { killTree, run, runTree } from '../core/process.js';
import { needsPreparation, withPreparation, preparationStatus } from '../core/preparation.mjs';

const until = async (ok) => { for (let n = 0; n < 200; n++) { if (ok()) return; await delay(25); } assert.fail('fixture 준비 시간 초과'); };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-preparation-'));
  t.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'herdr-preparation-'))); rmSync(dir, { recursive: true, force: true }); });
  const slots = join(dir, 'slots'), log = join(dir, 'events'), adapter = join(dir, 'adapter.mjs');
  mkdirSync(slots);
  writeFileSync(adapter, `import { appendFileSync } from 'node:fs';
const [command, id, ms] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({event:'start',id,at:Date.now()})+'\\n');
await new Promise(r => setTimeout(r, Number(ms) || 0));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({event:'end',id,at:Date.now()})+'\\n');
console.log(JSON.stringify({id,ok:true}));`);
  const built = build(), launcher = join(built.release, 'bin/harness.mjs');
  const binding = (project, timeout) => {
    const file = join(dir, project + '.json');
    writeFileSync(file, JSON.stringify({ ...built, version: 1, project, command: [process.execPath, adapter], cwd: dir, timeout }));
    return file;
  };
  const start = (file, args) => {
    const child = spawn(process.execPath, [launcher, '--binding', file, ...args], { windowsHide: true, env: { ...process.env, HERDR_PREPARATION_DIR: slots, HERDR_METRICS_DIR: join(dir, 'metrics') } });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
    t.after(() => { if (child.exitCode === null) killTree(child.pid); });
    return { child, done };
  };
  return { dir, slots, log, adapter, binding, start, events: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('준비를 만드는 명령만 직렬화 대상으로 고른다', () => {
  for (const args of [['prepare', 'X'], ['dispatch', 'X', 'research'], ['next', '--go']]) assert.equal(needsPreparation(args), true);
  for (const args of [['next'], ['whoami'], ['show', 'X'], ['decision', 'list'], ['flow-deliver', 'X', '--apply']]) assert.equal(needsPreparation(args), false);
});

test('서로 다른 binding의 준비를 겹치지 않고 대기 시간은 실행 한도에서 뺀다', { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const first = f.start(f.binding('one', 6000), ['dispatch', 'one', '1600']);
  await until(() => f.events().some(e => e.id === 'one' && e.event === 'start'));
  const second = f.start(f.binding('two', 1200), ['prepare', 'two', '50']);
  const [a, b] = await Promise.all([first.done, second.done]);
  assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
  assert.deepEqual(f.events().map(e => `${e.event}:${e.id}`), ['start:one', 'end:one', 'start:two', 'end:two']);
  assert.match(b.stderr, /순서 대기/); assert.equal(preparationStatus(f.slots).free, true);
  // 순서 대기와 슬롯 점유를 나눠 기록한다. 뒤에 온 준비의 대기에는 앞 준비의 실행 시간이 들어간다.
  const metrics = readFileSync(join(f.dir, 'metrics', 'preparation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const byProject = Object.fromEntries(metrics.map(m => [m.project, m]));
  assert.deepEqual(Object.keys(byProject).sort(), ['one', 'two']);
  assert.deepEqual([byProject.one.command, byProject.one.acquired, byProject.one.exit, byProject.two.command, byProject.two.acquired, byProject.two.exit], ['dispatch', true, 0, 'prepare', true, 0]);
  assert.ok(byProject.one.run_ms >= 1500, `one run_ms ${byProject.one.run_ms}`);
  assert.ok(byProject.two.wait_ms >= 1000, `two wait_ms ${byProject.two.wait_ms}`);
});

test('준비 대기 중에도 조회는 실행되며 대기 중 binding 변경은 실행하지 않는다', { timeout: 15000 }, async (t) => {
  const f = fixture(t), lock = join(f.slots, 'active.json');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'held', project: 'fixture', started: '2000-01-01' }));
  const file = f.binding('waiting', 2000), pending = f.start(file, ['dispatch', 'must-not-run', '0']);
  await delay(200);
  const query = await f.start(file, ['whoami', 'query', '0']).done;
  assert.equal(query.code, 0, query.stderr); assert.equal(preparationStatus(f.slots).holder.token, 'held');
  const updated = JSON.parse(readFileSync(file, 'utf8')); updated.timeout = 3000;
  writeFileSync(file, JSON.stringify(updated)); unlinkSync(lock);
  const result = await pending.done;
  assert.equal(result.code, 2); assert.match(result.stderr, /연결 설정이 바뀌었다/);
  assert.deepEqual(f.events().map(e => e.id), ['query', 'query']);
});

test('대기 취소는 남의 잠금을 보존하며 죽은 소유자도 자동으로 제거하지 않는다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-preparation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'active.json'), original = JSON.stringify({ pid: process.pid, token: 'live', started: '2000-01-01' });
  writeFileSync(file, original);
  const controller = new AbortController();
  const pending = withPreparation({ project: 'waiting' }, () => assert.fail('슬롯을 훔쳤다'), { dir, signal: controller.signal, poll: 10, report: () => {} });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(readFileSync(file, 'utf8'), original);
  writeFileSync(file, JSON.stringify({ pid: 2147483647, token: 'dead' }));
  await assert.rejects(withPreparation({}, () => assert.fail('죽은 잠금을 빼앗았다'), { dir }), /하위 Git/);
  assert.equal(preparationStatus(dir).holder.token, 'dead');
});

test('슬롯을 얻기 전에 취소·실패한 호출도 실행 0으로 한 번 기록하고 남의 잠금은 보존한다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-preparation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'active.json'), original = JSON.stringify({ pid: process.pid, token: 'live', started: '2000-01-01' });
  writeFileSync(file, original);
  const timings = [], controller = new AbortController();
  const pending = withPreparation({ project: 'waiting' }, () => assert.fail('슬롯을 훔쳤다'), { dir, signal: controller.signal, poll: 10, report: () => {}, onTiming: (x) => timings.push(x) });
  await delay(80); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(timings.length, 1);
  assert.deepEqual([timings[0].acquired, timings[0].run_ms], [false, 0]); assert.ok(timings[0].wait_ms >= 50, `wait_ms ${timings[0].wait_ms}`);
  assert.equal(readFileSync(file, 'utf8'), original);
  writeFileSync(file, JSON.stringify({ pid: 2147483647, token: 'dead' }));
  await assert.rejects(withPreparation({}, () => assert.fail('죽은 잠금을 빼앗았다'), { dir, onTiming: (x) => timings.push(x) }), /하위 Git/);
  assert.deepEqual([timings.length, timings[1].acquired, timings[1].run_ms], [2, false, 0]);
  assert.equal(preparationStatus(dir).holder.token, 'dead');
});

test('준비 폴더를 만들지 못해도 실행 없이 한 번 기록하고 원래 오류를 그대로 낸다', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-preparation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blocker = join(dir, 'not-a-dir'); writeFileSync(blocker, 'file');
  const timings = [];
  await assert.rejects(withPreparation({ project: 'p' }, () => assert.fail('실행했다'), { dir: blocker, report: () => {}, onTiming: (x) => timings.push(x) }), (e) => e.code === 'EEXIST' || e.code === 'ENOTDIR');
  assert.deepEqual([timings.length, timings[0].acquired, timings[0].run_ms], [1, false, 0]);
  assert.equal(readFileSync(blocker, 'utf8'), 'file');
});

test('런처는 준비 폴더 생성 실패에도 exit null로 한 번 기록한다', { timeout: 15000 }, async (t) => {
  const f = fixture(t), blocker = join(f.dir, 'prep-file'); writeFileSync(blocker, 'file');
  const r = run(process.execPath, [join(build().release, 'bin/harness.mjs'), '--binding', f.binding('nodir', 2000), 'dispatch', 'must-not-run', '0'],
    { env: { ...process.env, HERDR_PREPARATION_DIR: blocker, HERDR_METRICS_DIR: join(f.dir, 'metrics') } });
  assert.equal(r.code, 2, r.stderr); assert.deepEqual(f.events(), []);
  const lines = readFileSync(join(f.dir, 'metrics', 'preparation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => [l.project, l.acquired, l.run_ms, l.exit]), [['nodir', false, 0, null]]);
});

test('런처는 죽은 잠금 앞에서 실행하지 않은 준비도 exit null로 한 번 기록한다', { timeout: 15000 }, async (t) => {
  const f = fixture(t), lock = join(f.slots, 'active.json'), dead = JSON.stringify({ pid: 2147483647, token: 'dead' });
  writeFileSync(lock, dead);
  const r = await f.start(f.binding('blocked', 2000), ['dispatch', 'must-not-run', '0']).done;
  assert.equal(r.code, 2); assert.match(r.stderr, /하위 Git/);
  assert.equal(readFileSync(lock, 'utf8'), dead); assert.deepEqual(f.events(), []);
  const lines = readFileSync(join(f.dir, 'metrics', 'preparation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].project, lines[0].command, lines[0].acquired, lines[0].run_ms, lines[0].exit], ['blocked', 'dispatch', false, 0, null]);
});

test('실행 중 취소는 하위 프로세스 종료 뒤 준비 슬롯을 반환한다', { timeout: 15000 }, async (t) => {
  const f = fixture(t), controller = new AbortController();
  const result = withPreparation({ project: 'cancel', command: 'dispatch' }, () => runTree(process.execPath, [f.adapter, 'dispatch', 'cancel', '10000'], { signal: controller.signal, timeout: 12000 }), { dir: f.slots, report: () => {} });
  await until(() => f.events().some(e => e.event === 'start'));
  assert.equal(preparationStatus(f.slots).free, false); controller.abort();
  assert.equal((await result).code, 130); assert.equal(preparationStatus(f.slots).free, true);
  assert.deepEqual(f.events().map(e => e.event), ['start']);
});
