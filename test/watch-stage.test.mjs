import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../scripts/build.mjs';
import { watch } from '../bin/watch-stage.mjs';

const ok = v => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
const err = (code, stderr, stdout = '') => ({ code, stdout, stderr });
// 순서대로 [기대 인자, 응답]을 소비하는 가짜 CLI. 예상 밖 호출은 실패로 드러난다.
// clock.t는 가짜 시계다. 응답에 tick이 있으면 그 호출 중 시계를 그만큼 옮기고, sleep도 대기 시간만큼 옮긴다.
function run(steps, { hh = false, deadline = Infinity, start = 0, slots = [] } = {}) {
  const calls = [], sleeps = [], clock = { t: start };
  const cli = args => { calls.push(args); const [want, res, tick = 0] = steps.shift() ?? [[], err(99, '예상 밖 호출')]; assert.deepEqual(args, want); clock.t += tick; return res; };
  return watch({ id: 'T-1', hh, cli, now: () => clock.t, deadline, slotFree: () => slots.shift() ?? true,
    sleep: async ms => { sleeps.push(ms); clock.t += ms; }, log: () => {} })
    .then(r => ({ ...r, calls, sleeps, left: steps.length }));
}
const task = (over = {}) => ({ id: 'T-1', state: 'IMPLEMENTING', pending: null, current: null, awaiting: null, ...over });
const show = ['show', 'T-1'], collect = ['collect', 'T-1'], decisions = ['decision', 'list'];

test('산출물 대기는 30초 뒤 다시 수집하고 hc 판단 불가의 exit 0도 같은 회차면 기다린다', async () => {
  const busy = task({ current: { run: 0 } });
  const r = await run([
    [show, ok(busy)],
    [collect, err(2, '아직 실행 중이다. 산출물이 도착하면 다시 수집한다.\n')],
    [show, ok(busy)], [show, ok(busy)],
    [collect, ok({ id: 'T-1', note: 'hc로 터미널을 확인하지 못해 수집하지 않았다.' })],
    [show, ok(busy)], [show, ok(busy)],
    [collect, ok({})],
    [show, ok(task({ state: 'DONE' }))],
  ]);
  assert.deepEqual([r.code, r.result.state, r.result.reason, r.sleeps, r.left], [1, 'DONE', '상태 DONE', [30000, 30000], 0]);
});

test('대장 잠금 충돌은 수집·위임 모두 다음 주기에 다시 시도한다', async () => {
  const busy = task({ current: { run: 0 } }), lock = err(2, '대장 잠금이 사용 중이다. 종료된 실행이면 소유 PID를 확인한다.');
  const next = task({ state: 'QA', pending: 'qa' });
  const r = await run([
    [show, ok(busy)], [collect, lock], [show, ok(busy)], [show, ok(busy)],
    [collect, ok({})], [show, ok(next)],
    [decisions, ok([])], [['dispatch', 'T-1', 'qa'], lock], [show, ok(next)],
    [decisions, ok([])], [['dispatch', 'T-1', 'qa'], ok({})], [show, ok(task({ state: 'DONE' }))],
  ]);
  assert.deepEqual([r.code, r.result.state, r.sleeps, r.left], [1, 'DONE', [30000, 30000], 0]);
});

test('v2 HH repair는 단계 없이 위임하고 QA PASS 뒤 publish에서 멈춘다', async () => {
  const r = await run([
    [show, ok(task({ state: 'QA', pending: 'implement', x_flow: { phase: 'repair' } }))],
    [decisions, ok([{ id: 'other', task: 'T-2', status: 'open' }])],
    [['dispatch', 'T-1'], ok({})],
    [show, ok(task({ pending: 'implement', current: { run: 3 }, x_flow: { phase: 'repair' } }))],
    [collect, ok({})],
    [show, ok(task({ state: 'QA', pending: 'qa', x_flow: { phase: 'repair' } }))],
    [decisions, ok([])],
    [['dispatch', 'T-1'], ok({})],
    [show, ok(task({ state: 'QA', pending: 'qa', current: { run: 4 }, x_flow: { phase: 'repair' } }))],
    [collect, ok({})],
    [show, ok(task({ state: 'QA', x_flow: { phase: 'publish' } }))],
  ], { hh: true });
  assert.deepEqual([r.code, r.result.phase, r.result.dispatched, r.left], [1, 'publish', ['implement', 'qa'], 0]);
});

test('사람·Lead 판단 상태는 수집·위임 없이 멈춘다', async () => {
  for (const t of [task({ state: 'BLOCKED', awaiting: 'ac-approval', pending: 'implement' }), task({ state: 'FAILED' }),
    task({ state: 'QA', awaiting: 'flow-diagnose', pending: 'implement', x_flow: { phase: 'diagnose' } }), task({ state: 'QA' })]) {
    const r = await run([[show, ok(t)]]);
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 1);
  }
  // VP 사람 확인(exit 9)과 SW·VDP status=blocked
  for (const res of [err(9, '', 't 이 사람 확인을 기다립니다(blocked).'), ok({ id: 'T-1', status: 'blocked', note: '에이전트가 아직 작업 중이다.' })]) {
    const r = await run([[show, ok(task({ current: { run: 0 } }))], [collect, res]]);
    assert.match(r.result.reason, /사람 확인/);
    assert.equal(r.code, 1);
  }
});

test('이 업무·업무 미지정의 열린 결정은 위임을 막는다', async () => {
  for (const d of [{ id: 'q1', task: 't-1', status: 'open' }, { id: 'q2', status: 'open' }]) {
    const r = await run([[show, ok(task({ state: 'QA', pending: 'qa' }))], [decisions, ok([d])]]);
    assert.deepEqual([r.code, r.result.reason, r.result.dispatched], [1, `열린 결정: ${d.id}`, []]);
  }
});

test('상한에 도달하면 새 위임을 하지 않고 대기도 멈춘다', async () => {
  let r = await run([[show, ok(task({ state: 'QA', pending: 'qa' }))]], { deadline: 0 });
  assert.deepEqual([r.code, r.result.dispatched, r.calls.length], [1, [], 1]);
  assert.match(r.result.reason, /상한/);
  r = await run([[show, ok(task({ current: { run: 0 } }))], [collect, err(2, '', '{"note":"아직 작업 중(산출물·receipt 없음)"}')], [show, ok(task({ current: { run: 0 } }))]], { deadline: 0 });
  assert.deepEqual([r.code, r.sleeps], [1, []]);
  assert.match(r.result.reason, /상한/);
});

test('마감이 결정 조회·폴링 대기·슬롯 대기 중에 지나면 위임·재수집 없이 멈춘다', async () => {
  // 결정 조회 진입 59999ms, 반환 60001ms, 마감 60000ms
  let r = await run([[show, ok(task({ state: 'QA', pending: 'qa' }))], [decisions, ok([]), 2]], { start: 59999, deadline: 60000 });
  assert.deepEqual([r.code, r.result.dispatched, r.calls.length, r.left], [1, [], 2, 0]);
  assert.match(r.result.reason, /상한.*qa 위임을 시작하지 않았다/);
  // 산출물 대기에서 돌아온 시각이 마감 뒤면 다시 수집하지 않는다.
  const busy = task({ current: { run: 0 } });
  r = await run([[show, ok(busy)], [collect, err(2, '아직 실행 중이다.')], [show, ok(busy)]], { start: 40000, deadline: 60000 });
  assert.deepEqual([r.code, r.sleeps, r.left], [1, [30000], 0]);
  assert.match(r.result.reason, /상한/);
  // 준비 슬롯이 사용 중이면 launcher 대기에 들어가지 않고, 기다리는 사이 마감이 지나면 위임하지 않는다.
  r = await run([[show, ok(task({ state: 'QA', pending: 'qa' }))], [decisions, ok([])]], { start: 40000, deadline: 60000, slots: [false] });
  assert.deepEqual([r.code, r.result.dispatched, r.sleeps, r.left], [1, [], [30000], 0]);
  assert.match(r.result.reason, /상한/);
});

test('준비 슬롯이 비면 다시 확인한 뒤 위임한다', async () => {
  const pending = task({ state: 'QA', pending: 'qa' });
  const r = await run([[show, ok(pending)], [decisions, ok([])], [show, ok(pending)], [decisions, ok([])],
    [['dispatch', 'T-1', 'qa'], ok({})], [show, ok(task({ state: 'DONE' }))]], { slots: [false, true] });
  assert.deepEqual([r.code, r.result.dispatched, r.sleeps, r.left], [1, ['qa'], [30000], 0]);
});

test('CLI 오류는 exit 2로 끝난다', async () => {
  let r = await run([[show, ok(task({ current: { run: 0 } }))], [collect, err(2, '현재 실행의 Herdr 터미널과 다르다.')]]);
  assert.equal(r.code, 2);
  assert.match(r.result.reason, /collect 실패\(exit 2\): 현재 실행/);
  r = await run([[show, err(2, 'Lead가 아니다')]]);
  assert.equal(r.code, 2);
  r = await run([[show, ok(task({ state: 'QA', pending: 'qa' }))], [decisions, ok({})]]);
  assert.equal(r.code, 2);
  r = await run([[show, ok(task({ state: 'QA', pending: 'qa' }))], [decisions, ok([])], [['dispatch', 'T-1', 'qa'], err(2, '선행 업무가 완료되지 않았다.')]]);
  assert.deepEqual([r.code, r.result.dispatched], [2, []]);
});

for (const [project, id, other] of [['smart-workspace', 'SW-0169', 'SW-0170'], ['v-project', 'VP-TASK-028', 'VP-TASK-029']])
test(`release의 watch-stage가 launcher로 ${id} 구현 수집 → 같은 업무 QA 위임 → DONE을 진행한다`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-watch-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const built = build(), stub = join(dir, 'adapter.mjs'), file = join(dir, 'harness-binding.json'), state = join(dir, 'state.json'), log = join(dir, 'calls.jsonl');
  // 가짜 v1 대장: 대상은 구현 회차 실행 중, 다른 위임 가능 업무가 함께 있다.
  writeFileSync(state, JSON.stringify({
    [id]: { id, state: 'IMPLEMENTING', pending: null, current: { run: 0 }, awaiting: null },
    [other]: { id: other, state: 'READY_TO_IMPLEMENT', pending: 'implement', current: null, awaiting: null },
  }));
  writeFileSync(log, '');
  writeFileSync(stub, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [cmd, id, stage] = process.argv.slice(2), file = ${JSON.stringify(state)};
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const db = JSON.parse(readFileSync(file, 'utf8')), t = db[id], save = () => writeFileSync(file, JSON.stringify(db));
if (cmd === 'show') console.log(JSON.stringify(t));
else if (cmd === 'decision') console.log(JSON.stringify([{ id: 'q', task: ${JSON.stringify(other)}, status: 'open' }]));
else if (cmd === 'dispatch') { Object.assign(t, { current: { run: 1 }, pending: null }); save(); console.log(JSON.stringify({ id, stage })); }
else if (cmd === 'collect') { Object.assign(t, t.current.run === 0 ? { state: 'QA', pending: 'qa', current: null } : { state: 'DONE', current: null }); save(); console.log(JSON.stringify(t)); }
else process.exitCode = 2;
`);
  writeFileSync(file, JSON.stringify({ version: 1, project, release: built.release, manifestHash: built.manifestHash, cwd: dir, command: [process.execPath, stub] }));
  const r = spawnSync(process.execPath, [join(built.release, 'bin/watch-stage.mjs'), file, id, '1'], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, HERDR_PREPARATION_DIR: join(dir, 'prepare'), HERDR_METRICS_DIR: join(dir, 'metrics') } });
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { id, state: 'DONE', pending: null, phase: null, awaiting: null, dispatched: ['qa'], reason: '상태 DONE' });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(calls, [['show', id], ['collect', id], ['show', id], ['decision', 'list'], ['dispatch', id, 'qa'],
    ['show', id], ['collect', id], ['show', id]]);
  assert.equal(JSON.parse(readFileSync(state, 'utf8'))[other].current, null);
});

test('잘못된 입력은 exit 2와 JSON 한 줄로 끝난다', () => {
  const r = spawnSync(process.execPath, ['bin/watch-stage.mjs', 'x.json', 'bad'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).reason, /사용법/);
});
