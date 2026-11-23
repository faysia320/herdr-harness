import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as attention from './attention.js';
import * as logic from './logic.js';
import * as context from './context.js';

// 호스트 경계만 대역으로 바꾸고 실제 load/render/클릭 함수를 실행한다.
const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export default class Harness', 'class Harness');
function setup(overrides = {}) {
  const files = new Map(), store = new Map(), clicks = new Map(), commands = [], texts = [], reads = [];
  const terminalList = [{ address: 't7', state: 'live', status: 'working', created_ms: 10 }];
  const spaceList = [{ name: 'fixture', active: true, machine: null }], paneList = [];
  const el = () => {
    let id;
    const element = new Proxy({}, { get: (_, name) => (...args) => {
      if (name === 'id') id = args[0];
      if (name === 'on_click') clicks.set(id, args[0]);
      if (name === 'when' && args[0]) args[1](element);
      if (name === 'child' && typeof args[0] === 'string') texts.push(args[0]);
      return element;
    } });
    return element;
  };
  const api = { CONTRACT: 1, View: class {}, div: el, svg: el, h_flex: el, v_flex: el,
    ...attention, ...logic, ...context, machines: () => [{ name: null, layout: 'ready' }], appHome: () => 'fixture-home', readTextFile: async (p) => {
      reads.push(p);
      const value = files.get(p); if (value instanceof Error) throw value; return value ?? null;
    }, watchFolder: () => new Promise(() => {}), terminals: () => terminalList,
    spaces: () => spaceList, panes: () => paneList, shared: (k) => store.get(k), setShared: (k, v) => store.set(k, v),
    theme: () => new Proxy({}, { get: () => '#808080' }), run: (...args) => commands.push(args), notify: () => {}, playSound: () => {}, props: () => ({}), closeOverlay: () => {},
    InputState: { new: () => { let value = ''; return { value: () => value, set_value: (v) => { value = v; }, focus() {}, on() {} }; } },
    Input: { new: () => el() }, exec: async () => ({ code: 1, stdout: '', stderr: '' }), home: () => 'C:/fixture-home', hc: async () => ({ code: 0, stdout: '', stderr: '' }), ...overrides };
  const module = new Function(...Object.keys(api), `${source}; return {Harness, load, normalize};`)(...Object.values(api));
  return { ...module, files, store, clicks, commands, texts, reads, terminalList, spaceList, paneList,
    cx: { notify() {}, stop_propagation() {} } };
}
const project = { name: 'fixture', root: 'D:/fixture' };

test('준비·자원 카드는 펼쳤을 때만 읽고, 진행 중인 조회를 겹치지 않으며 상태와 프로젝트별 수치를 렌더한다', async () => {
  const calls = [];
  let finish;
  const s = setup({ exec: (tool, args, options) => {
    calls.push({ tool, args, options });
    return new Promise(resolve => { finish = resolve; });
  } });
  install(s);
  s.files.set('fixture-home/mods/harness/release.json', JSON.stringify({ release: 'C:/fixture-release' }));
  const p = await s.load(project), v = new s.Harness();
  Object.assign(v, { projects: [p], expanded: new Set() });
  const jobs = [];
  const cx = { ...s.cx, spawn(fn) { jobs.push(fn(cx)); } };
  v.render(); v.refreshResources(cx); assert.equal(jobs.length, 0);
  s.clicks.get('harness-resource-toggle')({}, cx);
  v.refreshResources(cx); await Promise.resolve();
  assert.equal(jobs.length, 1);
  assert.deepEqual(calls[0], { tool: 'node', args: ['C:/fixture-release/bin/resource-status.mjs'], options: { timeout: 5000 } });
  const data = { limit: 200, preparation: { state: 'busy', project: 'fixture', pid: 42, started: new Date().toISOString() },
    heavy: [{ state: 'unknown' }, { state: 'free' }], projects: [{ project: 'fixture', preparations: 2, acquired: 1,
      wait: [10, 50], run: [100, 100], missed: 1, nonzero: 0, noExit: 1, installs: 3, installMean: 2500, methods: { hardlink: 1, unknown: 2 },
      successfulInstalls: 1, successfulInstallMean: 0, failedInstalls: 1, timedOutInstalls: 1, errorCodes: { ENAMETOOLONG: 1 } },
    { project: 'VDP', installs: 1, installMean: 75, methods: { unknown: 1 }, successfulInstalls: 0, successfulInstallMean: null,
      failedInstalls: 1, timedOutInstalls: 0, errorCodes: {} }] };
  finish({ code: 0, stdout: JSON.stringify(data) });
  await Promise.all(jobs); v.render();
  assert.ok(s.texts.some(l => l.includes('fixture · PID 42 · 시작 후')));
  for (const part of ['시험·빌드 슬롯 1 · 잠금 정보 확인 필요', '시험·빌드 슬롯 2 · 비어 있음', '10 ms / 50 ms', '100 ms / 100 ms',
    '미획득 1건', '종료 코드 없음 1건', '의존성 설치 3건 · 전체 시도 평균 2500 ms', '성공 1건 · 성공 평균 0 ms', '성공 0건 · 성공 평균 —',
    'hardlink 1건', '설치 실패 1건 · 시간 초과 1건', '오류 코드 · ENAMETOOLONG 1건'])
    assert.ok(s.texts.some(l => l.includes(part)), part);
  v.refreshResources(cx); await Promise.resolve();
  finish({ code: 2, stdout: '' }); await Promise.all(jobs);
  s.texts.length = 0; v.render(); assert.ok(s.texts.includes('활성 릴리스의 자원 조회에 실패했습니다.'));
  assert.equal(s.texts.some(l => l.includes('PID 42')), false);
  s.clicks.get('harness-resource-toggle')({}, cx); v.refreshResources(cx); assert.equal(calls.length, 2);
});
const configPath = project.root + '/.agents/harness/config.json';
test('로컬 기본 화면도 자원 카드를 열어 조회하며 원격 공간에는 이 PC의 카드가 없다', async () => {
  let calls = 0;
  const s = setup({ machines: () => [{ name: 'remote', layout: 'ready' }], exec: async () => {
    calls++;
    return { code: 0, stdout: JSON.stringify({ preparation: { state: 'free' }, heavy: [], projects: [], limit: 200 }) };
  } });
  s.files.set('fixture-home/mods/harness/release.json', JSON.stringify({ release: 'C:/fixture-release' }));
  const v = new s.Harness(), jobs = [];
  Object.assign(v, { projects: [], expanded: new Set() });
  const cx = { ...s.cx, spawn(fn) { jobs.push(fn(cx)); } };
  v.render(); assert.equal(calls, 0);
  s.clicks.get('harness-resource-toggle')({}, cx); await Promise.all(jobs); v.render();
  assert.ok(s.texts.includes('준비 슬롯 · 비어 있음')); assert.equal(calls, 1);
  s.spaceList[0].machine = 'remote'; s.clicks.clear(); v.render(); v.refreshResources(cx);
  assert.equal(s.clicks.has('harness-resource-toggle'), false);
  assert.equal(jobs.length, 1);
});
const ledgerPath = project.root + '/state/ledger.json';
const task = { id: 'a', title: '권한을 결정해 주세요', state: 'BLOCKED', awaiting: 'permission', blocked_reason: '권한 범위를 선택해야 합니다.', runs: [], history: [], updated: new Date().toISOString() };
const install = (s) => {
  s.files.set(configPath, JSON.stringify({ project: { id: 'fixture', state_dir: 'state' } }));
  s.files.set(ledgerPath, JSON.stringify({ version: 1, project: 'fixture', tasks: { a: task }, lead: { terminal: 't7' } }));
};

test('v2 목록과 펼친 카드가 게시·CI·병합을 구분하고 완료 이력에 같은 이름을 쓴다', async () => {
  for (const [phase, state, label] of [
    ['publish', 'QA', '게시 대기'], ['ci', 'QA', 'CI 대기'], ['delivery-blocked', 'BLOCKED', '병합 차단'],
    ['merged', 'DONE', '병합 완료'], ['blocked', 'BLOCKED', '검증 차단'], ['diagnose', 'BLOCKED', '원인 진단 대기'],
    ['repair', 'READY_TO_IMPLEMENT', '재작업 대기'], ['repair', 'QA', '재작업 QA'], ['work', 'QA', 'QA'],
    ['unknown', 'DONE', '종결 상태 확인 필요'],
  ]) {
    const s = setup(); install(s);
    const delivery = ['ci', 'delivery-blocked', 'merged'].includes(phase) ? { pr: 12 } : null;
    if (phase === 'merged') delivery.merge = 'ab'.repeat(20);
    const record = { ...task, state, awaiting: null, blocked_reason: null,
      x_flow: { version: 2, phase, delivery, verification: { verdict: 'PASS' } },
      history: [{ from: 'QA', to: state, at: task.updated }] };
    s.files.set(ledgerPath, JSON.stringify({ version: 1, project: 'fixture', tasks: { a: record } }));
    const p = await s.load(project), v = new s.Harness();
    Object.assign(v, { projects: [p], expanded: new Set(), showEnded: true });
    v.render();
    assert.ok(s.texts.includes(label), phase);
    if (phase === 'publish' || phase === 'ci') {
      assert.equal(p.tasks[0].waits, null);
      assert.ok(!s.texts.includes('막는 조건 없음 · Lead 위임 차례'));
    }
    const key = state === 'BLOCKED' ? 'more-decision-fixture-a' : 'task-fixture/a';
    s.clicks.get(key)({}, s.cx); s.texts.length = 0; v.render();
    const summary = s.texts.find(text => text.startsWith('v2 · '));
    assert.ok(summary?.includes(label), phase);
    assert.equal(summary.includes('PR #12'), Boolean(delivery));
    assert.equal(summary.includes('병합 abababababab'), phase === 'merged');
    if (state === 'DONE') {
      assert.ok(s.texts.includes(phase === 'merged' ? 'QA → 병합 완료' : 'QA → 업무 종결'));
      assert.ok(!s.texts.some(text => text.includes('로컬 QA 통과') || text.includes('병합·배포는 별도 확인')));
      assert.equal(p.attentionRecords[0].kind, phase === 'merged' ? 'merged' : 'ended');
    }
  }
});

test('v2 설계 검토와 게시 정책을 표시하고 과거 위임 모델은 해당 회차에 보존한다', async () => {
  const s = setup(); install(s);
  const b = 'D:/fixture/state/harness-binding.json', release = 'D:/release';
  s.files.set(b, JSON.stringify({ project: 'fixture', adapterConfig: 'D:/adapter.json', release }));
  s.files.set('D:/adapter.json', JSON.stringify({ project: { id: 'fixture' } }));
  s.files.set(release + '/policy/execution.json', JSON.stringify({
    version: 1, limits: { max_parallel: 2 }, profiles: { design: { stages: ['research', 'architect', 'implement', 'qa'] } },
    aliases: { high: 'design' },
  }));
  s.files.set(release + '/policy/workflow.json', JSON.stringify({ version: 2,
    roles: { research: { model: 'research-default' }, architect: { model: 'architect-default' }, qa: { model: 'qa-default' } },
    delivery: { publisher: { model: 'publisher-default' } } }));
  const record = { ...task, state: 'RESEARCHING', profile: 'high', awaiting: null, blocked_reason: null,
    overrides: { qa: { model: 'qa-task-override' } }, x_flow: { version: 2, phase: 'work' },
    runs: [{ stage: 'research', round: 1, model: 'research-previous', status: 'done', outcome: 'ok' },
      { stage: 'architect', round: 1, model: 'architect-default', status: 'running' }], current: { stage: 'architect', run: 1 } };
  s.files.set(ledgerPath, JSON.stringify({ version: 1, project: 'fixture', tasks: { a: record } }));
  const p = await s.load(project), v = new s.Harness();
  const taskView = p.tasks[0];
  assert.deepEqual(taskView.steps, ['research', 'architect', 'implement', 'qa', 'publish', 'ci', 'merged']);
  assert.equal(logic.v2Progress(taskView), 'architect');
  Object.assign(v, { projects: [p], expanded: new Set(), open: 'fixture/a' });
  v.render();
  for (const line of ['설계 검토 중', '현재 위임 정책', '조사 · research-default', 'QA · qa-task-override',
    'PR 게시 · publisher-default', '조사 1회차 · research-previous']) assert.ok(s.texts.includes(line), line);
  assert.deepEqual(logic.v2Stages({ runs: [] }), ['research', 'implement', 'qa', 'publish', 'ci', 'merged']);
  s.files.delete(release + '/policy/workflow.json');
  const older = await s.load(project);
  assert.equal(older.stale, false);
  assert.deepEqual(older.tasks[0].models, []);
});

test('재개한 업무의 이전 완료 행에 나중 병합 상태를 소급하지 않는다', () => {
  const a = { at: 10, from: 'QA', to: 'DONE', why: '' };
  const b = { at: 30, from: 'QA', to: 'DONE', why: '병합 SHA 확인: ' + 'a'.repeat(40) };
  const t = { ...task, id: 'a', state: 'DONE', history: [a, { at: 20, from: 'DONE', to: 'QA' }, b],
    x_flow: { version: 2, phase: 'merged' }, runs: [] };
  const kinds = () => attention.importantRecords({ tasks: [t] }).filter(r => r.to === 'DONE').map(r => r.kind);
  assert.deepEqual(kinds(), ['merged', 'ended']);
  assert.equal(attention.stateLabel('DONE', t, a), '업무 종결');
  t.state = 'QA'; t.x_flow.phase = 'repair';
  assert.deepEqual(kinds(), ['merged', 'ended']);
  assert.equal(attention.stateLabel('DONE', t, b), '병합 완료');
});

function refreshFixture() {
  const s = setup(); install(s);
  const other = { name: 'other', root: 'D:/other' };
  s.files.set(`${other.root}/.agents/harness/config.json`, JSON.stringify({ project: { id: 'other', state_dir: 'state' } }));
  s.files.set(`${other.root}/state/ledger.json`, JSON.stringify({ version: 1, project: 'other', tasks: {} }));
  s.files.set('fixture-home/mods/harness/projects.json', JSON.stringify({ projects: [project, other] }));
  const v = new s.Harness(); Object.assign(v, { projects: [], expanded: new Set() });
  v.watch = () => {};
  const jobs = [], timers = [];
  const cx = { ...s.cx, spawn(fn) { jobs.push(fn(cx)); }, timer: { after(ms, fn) { timers.push({ ms, fn }); } } };
  const drain = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
  const tick = () => { const timer = timers.shift(); assert.equal(timer.ms, 200); timer.fn(cx); };
  return { ...s, v, other, cx, jobs, timers, drain, tick };
}

test('화면의 실행 한도는 main의 과거 설정 대신 연결된 공통 정책과 명시적 예외를 따른다', async () => {
  const s = setup(); install(s);
  s.files.set(configPath, JSON.stringify({ project: { id: 'fixture', state_dir: 'state' }, limits: { max_parallel: 4 } }));
  const active = (id) => ({ ...task, id, state: 'IMPLEMENTING', current: { stage: 'implement', run: 0 }, runs: [{ status: 'running' }] });
  s.files.set(ledgerPath, JSON.stringify({ version: 1, project: 'fixture', tasks: { a: active('a'), b: active('b'), c: { ...task, id: 'c', state: 'QUEUED' } } }));
  s.files.set('D:/fixture/state/harness-binding.json', JSON.stringify({ project: 'fixture', release: 'D:/release', adapterConfig: 'D:/adapter/config.json' }));
  s.files.set('D:/release/policy/execution.json', JSON.stringify({ version: 1, limits: { max_parallel: 2 } }));
  const adapter = { project: { id: 'fixture' }, execution_overrides: {} };
  s.files.set('D:/adapter/config.json', JSON.stringify(adapter));
  assert.match((await s.load(project)).tasks.find((t) => t.id === 'c').waits[0].text, /2\/2/);
  adapter.execution_overrides = { reason: '명시적 예외', limits: { max_parallel: 3 } };
  s.files.set('D:/adapter/config.json', JSON.stringify(adapter));
  assert.deepEqual((await s.load(project)).tasks.find((t) => t.id === 'c').waits, []);
  s.files.set('D:/release/policy/execution.json', '{');
  assert.equal((await s.load(project)).stale, true);
  s.files.set('D:/fixture/state/harness-binding.json', new Error('binding read failed'));
  assert.equal((await s.load(project)).stale, true);
});

test('대장 용량은 한글·이모지 UTF-8 바이트 기준 75%·90%에서 경고한다', async () => {
  const limit = 1 << 20;
  assert.equal(logic.ledgerCapacityNote('a'.repeat(limit * 0.75 - 1)), null);
  assert.match(logic.ledgerCapacityNote('a'.repeat(limit * 0.75)), /768 KiB.*75%.*용량 주의/);
  assert.match(logic.ledgerCapacityNote('a'.repeat(Math.ceil(limit * 0.9))), /90%.*읽기 한도 임박/);
  for (const text of ['가'.repeat(270000), '😀'.repeat(200000), '\ud800'.repeat(270000)]) {
    const bytes = Buffer.byteLength(text);
    assert.ok(logic.ledgerCapacityNote(text).includes(`${Math.ceil(bytes / 1024)} KiB`));
  }
  const s = refreshFixture();
  const raw = JSON.stringify({ version: 1, project: 'fixture', tasks: { a: { ...task, detail: '가'.repeat(270000) } } });
  s.files.set(ledgerPath, raw); s.v.refresh(s.cx); await s.drain(); s.v.render();
  assert.ok(s.texts.some((text) => text.includes('대장 용량') && text.includes('용량 주의')));
  assert.equal(s.files.get(ledgerPath), raw);
  const note = s.v.projects[0].capacityNote;
  s.files.set(ledgerPath, new Error('1 MiB limit')); s.v.refresh(s.cx, [project.root]); await s.drain();
  assert.equal(s.v.projects[0].capacityNote, note); assert.equal(s.v.projects[0].stale, true);
  install(s); s.v.refresh(s.cx, [project.root]); await s.drain();
  assert.equal(s.v.projects[0].capacityNote, null); assert.equal(s.v.projects[0].stale, false);
});

test('연속 변경을 묶어 대상만 다시 읽고 다른 프로젝트의 오류·자료를 그대로 유지한다', async () => {
  const s = refreshFixture(); s.v.refresh(s.cx); await s.drain();
  const other = s.v.projects[1]; other.stale = true; other.note = '마지막 정상 자료 표시';
  s.reads.length = 0;
  for (let i = 0; i < 10; i++) s.v.scheduleRefresh(s.cx, [project.root]);
  assert.equal(s.timers.length, 1); assert.equal(s.reads.length, 0);
  s.tick(); await s.drain();
  assert.equal(s.reads.length, 5);
  assert.ok(s.reads.every((p) => p.startsWith(project.root)));
  assert.equal(s.v.projects[1], other); assert.equal(other.note, '마지막 정상 자료 표시');
  s.reads.length = 0;
  s.v.scheduleRefresh(s.cx, [project.root]); s.v.scheduleRefresh(s.cx, [s.other.root]);
  s.tick(); await s.drain(); assert.equal(s.reads.length, 10);
});

test('조회 도중 변경은 후속 조회에 남고 전체 조회 요청은 대상 조회보다 우선한다', async () => {
  const s = refreshFixture(); s.v.refresh(s.cx); await s.drain(); s.reads.length = 0;
  const raw = s.files.get(ledgerPath); let release;
  s.files.set(ledgerPath, new Promise((resolve) => { release = resolve; }));
  s.v.refresh(s.cx, [project.root]);
  await Promise.resolve(); await Promise.resolve();
  s.v.scheduleRefresh(s.cx, [project.root]); s.tick();
  assert.equal(s.v.loading, true);
  s.files.set(ledgerPath, raw); release(raw); await s.drain();
  assert.equal(s.timers.length, 1); s.tick(); await s.drain();
  assert.equal(s.reads.filter((p) => p === ledgerPath).length, 2);
  s.reads.length = 0;
  s.v.scheduleRefresh(s.cx, [project.root]); s.v.scheduleRefresh(s.cx);
  s.files.set('fixture-home/mods/harness/projects.json', JSON.stringify({ projects: [s.other] }));
  s.tick(); await s.drain();
  assert.deepEqual(s.v.projects.map((p) => p.name), ['other']);
  assert.equal(s.reads.includes(ledgerPath), false);
  assert.equal(s.reads[0], 'fixture-home/mods/harness/projects.json');
});

test('목록 읽기 오류는 부분 갱신으로 지우지 않고 전체 재조회에서 복구한다', async () => {
  const s = refreshFixture(); s.v.refresh(s.cx); await s.drain();
  const path = 'fixture-home/mods/harness/projects.json', raw = s.files.get(path);
  s.files.set(path, '{'); s.v.refresh(s.cx); await s.drain(); assert.ok(s.v.error);
  s.v.refresh(s.cx, [project.root]); await s.drain(); assert.ok(s.v.error);
  s.files.set(path, raw); s.v.refresh(s.cx); await s.drain(); assert.equal(s.v.error, null);
});

test('시각 타이머는 파일을 읽지 않고 60초 재조회는 누락된 변경을 복구한다', async () => {
  const s = refreshFixture(), intervals = new Map();
  s.cx.timer.every = (ms, fn) => intervals.set(ms, fn);
  const errors = [];
  s.cx.spawn = (fn) => { fn(s.cx).catch((e) => errors.push(e)); };
  const settle = async () => {
    for (let i = 0; i < 100 && s.v.loading; i++) await Promise.resolve();
    assert.equal(s.v.loading, false); assert.deepEqual(errors, []);
  };
  s.v.init({}, s.cx); await settle(); s.reads.length = 0;
  intervals.get(15000)(s.cx); assert.equal(s.reads.length, 0);
  intervals.get(60000)(s.cx); await settle(); assert.equal(s.reads.length, 11);
});

test('끝나지 않는 읽기가 있어도 30초 뒤 주기 조회가 새로 읽고 늦게 끝난 이전 조회는 버린다', async () => {
  const s = refreshFixture(); s.v.refresh(s.cx); await s.drain();
  const raw = s.files.get(ledgerPath); let release;
  s.files.set(ledgerPath, new Promise((resolve) => { release = resolve; }));
  s.v.refresh(s.cx); const hung = s.jobs.splice(0);
  await Promise.resolve(); await Promise.resolve();
  s.v.refresh(s.cx); assert.equal(s.jobs.length, 0, '30초 전에는 진행 중 조회를 기다린다');
  s.v.loadingSince -= 30000;
  const fresh = JSON.stringify({ version: 1, project: 'fixture', tasks: { a: { ...task, state: 'DONE' } } });
  s.files.set(ledgerPath, fresh);
  s.v.refresh(s.cx); assert.match(s.v.error, /30초/);
  await s.drain();
  assert.equal(s.v.loading, false); assert.equal(s.v.error, null);
  assert.equal(s.v.projects[0].tasks[0].state, 'DONE');
  release(raw); await Promise.all(hung);
  assert.equal(s.v.projects[0].tasks[0].state, 'DONE', '늦게 끝난 이전 조회가 새 자료를 덮어쓰지 않는다');
  assert.equal(s.v.loading, false);
});

test('상태·설정 감시는 프로젝트를 좁히고 제거된 경로와 실패한 감시는 정리한다', async () => {
  const waiting = new Map();
  const s = setup({ watchFolder: (dir) => new Promise((resolve, reject) => waiting.set(dir, { resolve, reject })) });
  install(s); const v = new s.Harness(); v.projects = [await s.load(project)];
  const calls = [], jobs = [], cx = { spawn(fn) { jobs.push(fn(cx)); } };
  v.scheduleRefresh = (_cx, roots) => calls.push(roots ?? null);
  const state = `${project.root}/state`, config = `${project.root}/.agents/harness`, list = 'fixture-home/mods/harness';
  for (const dir of [state, config, list]) v.watch(dir, cx);
  for (const dir of [state, config, list]) { waiting.get(dir).resolve(); await Promise.resolve(); }
  assert.deepEqual(calls, [[project.root], [project.root], null]);
  v.projects = [];
  waiting.get(state).resolve(); waiting.get(config).reject(new Error('watch failed'));
  await Promise.all(jobs.slice(0, 2));
  assert.equal(v.watched.has(state), false); assert.equal(v.watched.has(config), false);
  v.projects = [await s.load(project)]; v.watch(config, cx);
  assert.equal(v.watched.has(config), true);
});

test('일반 저장소는 기본 브리핑을 제공하고 하네스 대장·Git 화면을 만들지 않는다', async () => {
  const s = setup(); install(s);
  const v = new s.Harness();
  Object.assign(v, { projects: [await s.load(project)], expanded: new Set() });
  Object.assign(s.spaceList[0], { name: 'herdr-harness', folder: 'D:/old', tabs: [{ id: 'tab' }] });
  s.paneList.push({ tab: 'unrelated', cwd: 'D:/unrelated' }, { tab: 'tab', cwd: 'D:/repositories/herdr-harness' });
  v.render(s.cx);
  assert.equal(s.clicks.has('harness-tab-brief'), false);
  assert.equal(s.clicks.has('harness-scope'), false);
  assert.equal(s.clicks.has('harness-tab-git'), false);
  assert.equal(s.texts.includes('내 결정·확인'), false);
  assert.ok(s.texts.includes('기본 브리핑'));
  assert.ok(s.texts.includes('아직 실행 중인 에이전트가 없습니다.'));
  assert.deepEqual(v.shown(), []);
  // 공간 이름이 등록된 프로젝트와 같아도 다른 실제 경로에 브리핑을 노출하지 않는다.
  s.spaceList[0].name = 'fixture'; s.clicks.clear(); v.render(s.cx);
  assert.equal(s.clicks.has('harness-tab-brief'), false);
  // 등록된 저장소로 복귀하면 브리핑을 표시한다. 경로 구분자·대소문자·하위 폴더도 허용한다.
  s.paneList[1].cwd = 'd:\\FIXTURE\\src'; s.clicks.clear(); v.render(s.cx);
  assert.equal(s.clicks.has('harness-tab-brief'), false);
  assert.equal(s.clicks.has('harness-scope'), false);
  assert.ok(s.texts.includes('업무 진행'));
});

test('미등록 공간은 projects.json이 없어도 Git 화면을 만들지 않는다', () => {
  const s = setup(), v = new s.Harness();
  Object.assign(v, { projects: [] });
  Object.assign(s.spaceList[0], { name: 'other', folder: 'D:/other' });
  v.render(s.cx);
  assert.deepEqual(v.shown(), []);
  assert.equal(s.texts.includes('설정 없음'), false);
  assert.equal(s.clicks.has('harness-tab-brief'), false);
});

test('대장 읽기 실패·다른 project·계약 불일치를 정상 빈 대장으로 표시하지 않는다', async () => {
  const s = setup(); install(s);
  for (const value of [null, '{broken', new Error('too large'), JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, project: 'other' })]) {
    s.files.set(ledgerPath, value);
    const p = await s.load(project);
    assert.equal(p.stale, true); assert.ok(p.note);
  }
});

test('사건 파일 실패는 업무 이력으로 보완하고 경고한다', async () => {
  const s = setup(); install(s);
  s.files.set(project.root + '/state/events.jsonl', new Error('1 MiB limit'));
  const p = await s.load(project);
  assert.equal(p.stale, false); assert.match(p.historyNote, /이력/); assert.equal(p.tasks.length, 1);
});

test('결정·변화·진행은 한 화면에 있고 읽음·근거 보기·종료 필터는 독립적이다', async () => {
  const s = setup(); install(s); const p = await s.load(project);
  const v = new s.Harness();
  Object.assign(v, { projects: [p], expanded: new Set(), showEnded: false });
  v.render();
  assert.ok(!s.texts.includes('내 결정·확인')); assert.ok(s.texts.includes(task.blocked_reason));
  assert.ok(s.texts.indexOf('업무 진행') < s.texts.indexOf(task.title));
  assert.equal(s.texts.filter(text => text === task.title).length, 1);
  assert.equal(s.clicks.has('page-progress'), false); assert.equal(s.clicks.has('page-attention'), false);
  assert.equal(s.clicks.has('task-fixture/a'), false); // 결정함과 진행 목록에 중복 표시하지 않는다.
  s.clicks.get('read-fixture')({}, s.cx);
  assert.equal(s.commands.length, 0); assert.equal(attention.decisions(p).length, 1);
  assert.equal(attention.changes(p, s.store.get(attention.seenKey(p))).length, 0);
  assert.equal(s.clicks.has('lead-decision-fixture-a'), false);
  s.clicks.get('more-decision-fixture-a')({}, s.cx);
  assert.ok(v.expanded.has('decision-fixture-a')); assert.equal(s.commands.length, 0);
  s.clicks.get('harness-ended')({}, s.cx); assert.equal(v.showEnded, true);
  assert.equal(s.clicks.has('harness-transitions'), false);
  s.clicks.get('harness-change-toggle')({}, s.cx); assert.equal(v.changesCollapsed, true);
  assert.equal(s.clicks.has('harness-scope'), false);
});

test('읽기 실패 시 마지막 정상 자료는 남고 읽음·Lead 조작은 비활성화한다', async () => {
  const s = setup(); install(s); const p = await s.load(project);
  const v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
  s.files.set('fixture-home/mods/harness/projects.json', JSON.stringify({ projects: [project] }));
  s.files.set(ledgerPath, '{broken');
  const promises = [], cx = { ...s.cx, spawn(fn) { promises.push(fn(cx)); } };
  v.watch = () => {}; v.refresh(cx); await Promise.all(promises);
  assert.equal(v.projects[0].tasks[0].id, 'a'); assert.equal(v.projects[0].stale, true);
  v.render(); assert.equal(s.clicks.has('read-fixture'), false); assert.equal(s.clicks.has('lead-decision-fixture-a'), false);
});

test('Lead 병합 메모는 업무 진행에 한 번만 표시하고 답변 건수와 상세 근거를 분리한다', async () => {
  const s = setup(); install(s);
  const tasks = {};
  for (const [id, pr, linked] of [['SW-0122',1131,true], ['SW-0123',1137,false], ['SW-0134',1165,true], ['SW-0135',1163,true]]) {
    const reason = id === 'SW-0122' ? '중단: 사용자 결정 v2-revalidate-loop(권장안): DEV-14 기준 Lead 병합 — QA r5 PASS 후보, 필수 CI 확인' :
      `중단: PR #${pr} Lead 병합 0419dfdf(DEV-14) — 대장 DONE은 proofOnly 반영 뒤 정리`;
    tasks[id] = { ...task, id, title: id + ' 작업', awaiting: null, blocked_reason: reason, resume_state: 'QA',
      runs: [{stage:'qa',round:5,outcome:'PASS',status:'done'}],
      x_flow: { version:2, phase:linked?'ci':'publish', verification:{verdict:'PASS'}, delivery:linked?{pr}:null } };
  }
  tasks.old = { ...task, id:'old', state:'FAILED', depends:['SW-0123'] };
  s.files.set(ledgerPath, JSON.stringify({version:1,project:'fixture',tasks}));
  const path = project.root + '/state/decisions.json';
  const inbox = {version:1,project:'fixture',requests:{}};
  s.files.set(path, JSON.stringify(inbox));
  const v = new s.Harness(); Object.assign(v,{expanded:new Set(),projects:[await s.load(project)]});
  const draw = () => { s.texts.length = 0; s.clicks.clear(); v.render(); };
  draw();
  assert.ok(s.texts.some(x=>x.startsWith('내 답변 필요 없음')));
  for (const id of Object.keys(tasks).filter(id=>id!=='old')) {
    assert.equal(s.texts.filter(x=>x===tasks[id].title).length,1);
    assert.ok(!s.texts.includes(tasks[id].blocked_reason));
  }
  assert.equal(s.texts.filter(x=>x==='대장 종결 보류').length,4);
  assert.ok(s.texts.includes('fixture · SW-0123 · PR 게시 기록 · QA 5차 PASS'));
  assert.ok(s.texts.includes('대장에 최초 게시 PR 연결 기록이 없어 Lead 확인이 필요합니다.'));
  s.clicks.get('more-decision-fixture-SW-0123')({},s.cx); draw();
  assert.ok(s.texts.includes(tasks['SW-0123'].blocked_reason));
  assert.ok(!s.texts.some(x=>x.startsWith('이 업무를 기다리는 후속')));

  inbox.requests.q = { id:'q',task:'SW-0123',question:'후속 기록 방식을 선택해 주세요.',source:'Lead',revision:1,status:'open',options:[] };
  s.files.set(path,JSON.stringify(inbox)); v.projects=[await s.load(project)]; draw();
  assert.ok(s.texts.some(x=>x.startsWith('내 답변 필요 1건')));
  assert.ok(s.texts.includes('Lead 병합 기록 · PR #1137'));
  assert.equal(s.texts.filter(x=>x===inbox.requests.q.question).length,1);
  assert.ok(s.texts.indexOf(tasks['SW-0123'].title)<s.texts.indexOf(inbox.requests.q.question));
  assert.ok(s.texts.indexOf(inbox.requests.q.question)<s.texts.indexOf(tasks['SW-0122'].title));
});

test('변화가 많아도 진행 업무가 함께 보이고 펼침·전체 읽음 범위가 명확하다', async () => {
  const s = setup(); install(s);
  const stamp = new Date().toISOString(), events = [];
  const ledger = JSON.parse(s.files.get(ledgerPath));
  ledger.tasks.running = { ...task, id: 'running', title: '현재 진행 업무', state: 'IMPLEMENTING', awaiting: null, blocked_reason: null };
  for (let i = 0; i < 4; i++) {
    ledger.tasks[`done-${i}`] = { ...task, id: `done-${i}`, state: 'DONE', awaiting: null, blocked_reason: null };
    events.push({ project: 'fixture', event: 'state', task: `done-${i}`, at: stamp, from: 'QA', to: 'DONE', why: `결과 ${i}` });
  }
  s.files.set(ledgerPath, JSON.stringify(ledger));
  s.files.set(project.root + '/state/events.jsonl', events.map((e) => JSON.stringify(e)).join('\n'));
  const p = await s.load(project);
  const v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
  const draw = () => { s.clicks.clear(); s.texts.length = 0; v.render(); };
  const changeCount = () => [...s.clicks.keys()].filter((k) => k?.startsWith('more-change-')).length;
  draw(); assert.equal(changeCount(), 3);
  assert.ok(s.texts.indexOf('업무 진행') < s.texts.indexOf('알아둘 변화'));
  s.clicks.get('harness-change-toggle')({}, s.cx); draw(); assert.equal(changeCount(), 0);
  assert.equal(attention.decisions(p).length, 1);
  s.clicks.get('harness-change-toggle')({}, s.cx); draw(); assert.equal(changeCount(), 3);
  assert.ok(s.texts.includes('현재 진행 업무')); assert.ok(s.texts.includes('나머지 1건 보기'));
  assert.ok(s.texts.includes('변화 4건 모두 읽음'));
  const card = [...s.clicks.keys()].find((k) => k?.startsWith('more-change-'));
  s.clicks.get(card)({}, s.cx); draw(); assert.ok(s.texts.includes('커밋·PR·병합·배포는 별도 확인'));
  s.clicks.get('harness-more-changes')({}, s.cx); draw(); assert.equal(changeCount(), 4);
  s.clicks.get('harness-more-changes')({}, s.cx); draw(); assert.equal(changeCount(), 3);
  s.clicks.get('read-fixture')({}, s.cx); draw(); assert.equal(changeCount(), 0);
  assert.ok(s.texts.includes(task.blocked_reason)); assert.ok(s.texts.includes('현재 진행 업무'));
  assert.equal(s.commands.length, 0);
  s.clicks.get('harness-ended')({}, s.cx); draw(); assert.ok(s.clicks.has('task-fixture/done-0'));
});

test('실제 로더가 다른 project 사건을 섞지 않고 원문·승인·의존성을 보존한다', async () => {
  const s = setup(); install(s);
  s.files.set(ledgerPath, JSON.stringify({ version: 1, project: 'fixture', tasks: { a: { ...task, depends: ['b'], approval: { by: 'user', quote: '허용' }, x_pending_decision: '질문 원문' } } }));
  s.files.set(project.root + '/state/events.jsonl', JSON.stringify({ project: 'other', event: 'state', task: 'a', to: 'DONE' }));
  const p = await s.load(project);
  assert.equal(p.events.length, 0); assert.deepEqual(p.tasks[0].depends, ['b']); assert.equal(p.tasks[0].approval.quote, '허용');
  assert.equal(attention.decisions(p)[0].question, '질문 원문');
});

test('Lead 진행 보고는 프로젝트 상태에만 표시하고 결정함에 세거나 이전 응답을 유지하지 않는다', async () => {
  const s = setup(); install(s);
  s.files.set(project.root + '/state/decisions.json', JSON.stringify({ version: 1, project: 'fixture', requests: {} }));
  const p = await s.load(project);
  p.tasks[0].state = 'DONE';
  const message = 'ITSM 5건 하네스 등록; 3건 조사 중, 2건 대기, 완료 보고 대기';
  Object.assign(s.terminalList[0], { status: 'done', report: { msg: message } });
  const v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
  const draw = () => { s.clicks.clear(); s.texts.length = 0; v.render(); };
  draw();
  assert.ok(s.texts.includes(message));
  s.clicks.get('lead-status-fixture')({}, s.cx);
  assert.deepEqual(s.commands, [['agent.focus', { terminal: 't7' }]]);
  for (const status of ['done', 'idle', 'working', 'blocked', 'error']) {
    s.terminalList[0].status = status;
    s.texts.length = 0; s.clicks.clear();
    v.render();
    assert.ok(s.texts.some(text => text.startsWith('내 답변 필요 없음')));
    assert.equal(s.texts.filter(text => text === message).length, 1);
    assert.equal(s.texts.includes('Lead 응답 확인'), false);
    assert.equal(s.clicks.has('lead-report-fixture'), false);
  }
  s.terminalList[0].status = 'working';
  s.terminalList[0].report = { msg: 'Waiting for child agent report' }; draw();
  assert.ok(s.texts.includes('Waiting for child agent report'));
  assert.equal(s.texts.includes(message), false);
  s.terminalList[0].report = {}; draw();
  assert.equal(s.clicks.has('lead-status-fixture'), false);
  s.terminalList[0].state = 'exited'; draw();
  assert.equal(s.texts.some((text) => text.includes('별도 질문 여부를 확인할 수 없습니다')), false);
});

test('질문 파일→실제 로더→화면: 무관한 완료 보고와 읽음은 콜아웃 질문을 제거하지 못한다', async () => {
  const s = setup(); install(s);
  const request = { id: 'callout', question: '콜아웃 업무 등록 여부와 좁게/넓게 범위를 결정해 주세요.', task: null, status: 'open', revision: 1,
    source: 'fixture 사용자에게 보낸 질문', created: new Date().toISOString(), options: [{ label: '좁게', impact: '지정 화면' }, { label: '넓게', impact: '공통 영역' }] };
  const path = project.root + '/state/decisions.json';
  const write = () => s.files.set(path, JSON.stringify({ version: 1, project: 'fixture', requests: { callout: request } }));
  write(); const p = await s.load(project); p.tasks[0].state = 'DONE';
  const v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
  const draw = () => { s.texts.length = 0; s.clicks.clear(); v.render(); };
  draw(); assert.ok(s.texts.includes(request.question));
  s.clicks.get('read-fixture')({}, s.cx);
  Object.assign(s.terminalList[0], { status: 'done', report: { msg: 'SW-0045 정리 완료, main 동기화; SW-0046 QA 진행 중' } });
  draw(); assert.ok(s.texts.includes(request.question));
  s.terminalList[0].address = 'new-lead'; p.lead = 'new-lead'; draw(); assert.ok(s.texts.includes(request.question));
  request.status = 'resolved'; request.revision = 2; request.resolution = { quote: '좁게 등록해', source: 'fixture 실제 답' }; write();
  v.projects = [await s.load(project)]; draw(); assert.equal(s.texts.includes(request.question), false);
  assert.equal(s.commands.length, 0);
});

test('질문 카드의 선택지는 Lead 터미널에 답을 전하고 결정함은 직접 고치지 않는다', async () => {
  const sends = [];
  const s = setup({ hc: async (args) => { sends.push(args); return { code: 0, stdout: '', stderr: '' }; } }); install(s);
  const request = { id: 'tools', question: '검사 명령을 사전 승인 목록에 추가할까요?', task: 'a', status: 'open', revision: 3,
    source: 'fixture 질문', created: new Date().toISOString(), options: [{ label: '추가', impact: '사전 승인 목록 확장' }, { label: '추가 안 함', impact: '실행 때마다 확인' }] };
  const path = project.root + '/state/decisions.json', body = JSON.stringify({ version: 1, project: 'fixture', requests: { tools: request } });
  s.files.set(path, body);
  const p = await s.load(project), v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set(), answers: new Map() });
  const jobs = [], cx = { ...s.cx, spawn(fn) { jobs.push(fn(cx)); } };
  const draw = () => { s.texts.length = 0; s.clicks.clear(); v.render(); };
  draw(); s.clicks.get('answer-fixture-tools-0')({}, cx);
  assert.equal(sends.length, 0); // 선택만으로 보내지 않는다.
  draw(); s.clicks.get('answer-fixture-tools-send')({}, cx);
  // 전송 중에는 다른 선택지를 다시 보내지 않는다.
  draw(); assert.equal(s.clicks.has('answer-fixture-tools-1'), false);
  await Promise.all(jobs);
  assert.deepEqual(sends.map((a) => a.slice(0, 2)), [['send', 't7']]);
  assert.match(sends[0][2], /질문 tools\(revision 3\)의 답: "추가"/);
  assert.match(sends[0][2], /decision resolve tools --revision 3/);
  draw(); assert.ok(s.texts.some((x) => x.startsWith('전달됨 · Lead 기록 대기 — 추가')));
  assert.equal(s.files.get(path), body);
  // revision이 바뀌면 이전 전달 표시를 쓰지 않고 다시 답할 수 있다.
  request.revision = 4; s.files.set(path, JSON.stringify({ version: 1, project: 'fixture', requests: { tools: request } }));
  v.projects = [await s.load(project)]; draw(); assert.ok(s.clicks.has('answer-fixture-tools-0'));
  // 직접 입력은 init에서 만든 입력 하나를 그 카드에서만 연다(렌더 중 입력 상태 생성 금지).
  v.answerInput = { value: () => '한글 직접 답', set_value() {}, focus() {} };
  draw(); s.clicks.get('answer-fixture-tools-type')({}, cx); draw(); s.clicks.get('answer-fixture-tools-text')({}, cx); await Promise.all(jobs);
  assert.match(sends.at(-1)[2], /질문 tools\(revision 4\)의 답: "한글 직접 답"/);
  // 전달 실패는 실패로 보이고 다시 시도할 수 있다.
  const f = setup({ hc: async () => ({ code: 1, stdout: '', stderr: 'no such terminal' }) }); install(f); f.files.set(path, body);
  const fv = new f.Harness(); Object.assign(fv, { projects: [await f.load(project)], expanded: new Set(), answers: new Map() });
  const fjobs = [], fcx = { ...f.cx, spawn(fn) { fjobs.push(fn(fcx)); } };
  f.texts.length = 0; fv.render(); f.clicks.get('answer-fixture-tools-1')({}, fcx); fv.render(); f.clicks.get('answer-fixture-tools-send')({}, fcx); await Promise.all(fjobs);
  f.texts.length = 0; f.clicks.clear(); fv.render();
  assert.ok(f.texts.some((x) => x.includes('전달 실패: no such terminal')));
  assert.ok(f.clicks.has('answer-fixture-tools-0'));
});

test('결정함 읽기 실패는 직전 질문을 보존하고 최신 상태로 꾸미지 않는다', async () => {
  const s = setup(); install(s);
  const request = { id: 'q', question: '계속 남아야 할 질문', task: null, source: 'fixture 질문', status: 'open', revision: 1, options: [] };
  s.files.set(project.root + '/state/decisions.json', JSON.stringify({ version: 1, project: 'fixture', requests: { q: request } }));
  const p = await s.load(project), v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
  s.files.set('fixture-home/mods/harness/projects.json', JSON.stringify({ projects: [project] }));
  s.files.set(project.root + '/state/decisions.json', '{partial');
  const pending = [], cx = { ...s.cx, spawn(fn) { pending.push(fn(cx)); } };
  v.watch = () => {}; v.refresh(cx); await Promise.all(pending); v.render();
  assert.ok(s.texts.includes(request.question)); assert.equal(v.projects[0].decisionStatus, 'error');
  assert.ok(s.texts.includes('마지막 정상 기록 · 현재 해소 여부 확인 필요'));
});

test('같은 폴더라도 프로젝트가 바뀌면 이전 질문과 작업을 재사용하지 않는다', async () => {
  for (const missingLedger of [false, true]) {
    const s = setup(); install(s);
    const request = { id: 'q', question: '이전 프로젝트 질문', task: null, source: 'fixture 질문', status: 'open', revision: 1, options: [] };
    s.files.set(project.root + '/state/decisions.json', JSON.stringify({ version: 1, project: 'fixture', requests: { q: request } }));
    const p = await s.load(project), v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
    s.files.set('fixture-home/mods/harness/projects.json', JSON.stringify({ projects: [project] }));
    s.files.set(configPath, JSON.stringify({ project: { id: 'new-project', state_dir: 'new-state' } }));
    if (!missingLedger) s.files.set(project.root + '/new-state/ledger.json', JSON.stringify({ version: 1, project: 'new-project', tasks: {} }));
    const pending = [], cx = { ...s.cx, spawn(fn) { pending.push(fn(cx)); } };
    v.watch = () => {}; v.refresh(cx); await Promise.all(pending); v.render();
    assert.equal(v.projects[0].projectId, 'new-project');
    assert.equal(v.projects[0].requests?.length ?? 0, 0);
    assert.equal(v.projects[0].tasks.length, 0);
    assert.equal(s.texts.includes(request.question), false);
  }
});

test('설정 자체를 못 읽으면 표시명과 ID가 달라도 마지막 질문을 stale로 보존한다', async () => {
  const s = setup(); install(s);
  const displayProject = { ...project, name: '다른 표시명' };
  const request = { id: 'q', question: '읽기 실패에도 남는 질문', task: null, source: 'fixture 질문', status: 'open', revision: 1, options: [] };
  s.files.set(project.root + '/state/decisions.json', JSON.stringify({ version: 1, project: 'fixture', requests: { q: request } }));
  const p = await s.load(displayProject), v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
  s.files.set('fixture-home/mods/harness/projects.json', JSON.stringify({ projects: [displayProject] }));
  s.files.delete(configPath);
  const pending = [], cx = { ...s.cx, spawn(fn) { pending.push(fn(cx)); } };
  v.watch = () => {}; v.refresh(cx); await Promise.all(pending);
  assert.equal(v.projects[0].projectId, 'fixture');
  assert.equal(v.projects[0].requests[0].question, request.question);
  assert.equal(v.projects[0].stale, true);
  assert.match(v.projects[0].note, /마지막 정상 자료/);
});


test('전체 이력은 로드 때 계산하고 반복 렌더·읽음은 재순회하지 않으며 갱신 시 새 사건을 반영한다', async () => {
  const s = setup(); install(s);
  const past = '2020-01-01T00:00:00Z';
  const history = Array.from({ length: 2000 }, (_, i) => ({ at: past, from: 'QA', to: 'DONE', why: `과거 결과 ${i}` }));
  const raw = { version: 1, project: 'fixture', tasks: { a: { ...task, state: 'DONE', history } } };
  s.files.set(ledgerPath, JSON.stringify(raw));
  const p = await s.load(project);
  assert.equal(p.attentionRecords.length, 2000);
  Object.defineProperty(p.tasks[0], 'history', { get() { throw new Error('렌더에서 전체 이력을 다시 읽음'); } });
  const v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
  for (let i = 0; i < 3; i++) v.render();
  s.clicks.get('read-fixture')({}, s.cx);
  assert.equal(s.store.get(attention.seenKey(p)).ids.length, 2000);
  raw.tasks.a.history.push({ at: new Date().toISOString(), from: 'QA', to: 'DONE', why: '새 QA 결과' });
  s.files.set(ledgerPath, JSON.stringify(raw));
  const updated = await s.load(project);
  assert.equal(updated.attentionRecords.length, 2001);
  assert.deepEqual(attention.changes(updated, s.store.get(attention.seenKey(p))).map((r) => r.body), ['새 QA 결과']);
});


test('등록된 저장소 사이를 전환해도 현재 저장소의 업무와 질문만 표시한다', async () => {
  const s = refreshFixture(); s.v.refresh(s.cx); await s.drain();
  s.v.allProjects = true; // 이전 인스턴스의 값이 남아도 전체 보기를 복원하지 않는다.
  s.v.render(s.cx);
  assert.deepEqual(s.v.shown().map((p) => p.name), ['fixture']);
  assert.ok(s.texts.includes(task.blocked_reason));
  assert.equal(s.clicks.has('harness-scope'), false);
  s.spaceList[0].name = 'other'; s.texts.length = 0; s.clicks.clear();
  s.v.render(s.cx);
  assert.deepEqual(s.v.shown().map((p) => p.name), ['other']);
  assert.equal(s.texts.includes(task.blocked_reason), false);
  assert.equal(s.clicks.has('harness-scope'), false);
});

test('일반 레포의 입력 필요·활동·터미널 이동은 현재 공간에 한정되고 결정함을 만들지 않는다', () => {
  const s = setup(), v = new s.Harness(); Object.assign(v, { projects: [], expanded: new Set() });
  Object.assign(s.spaceList[0], { id: 's1', name: 'ordinary', tabs: [{ id: 'tab' }] });
  s.paneList.push({ tab: 'tab', terminal: 't7', cwd: 'D:/ordinary', title: 'Codex' });
  Object.assign(s.terminalList[0], { status: 'blocked', report: { msg: '범위를 확인해 주세요.' } });
  s.terminalList.push({ address: 'elsewhere', state: 'live', status: 'blocked', report: { msg: '다른 공간의 비공개 질문' } });
  v.render();
  assert.ok(s.texts.includes('터미널 확인')); assert.ok(s.texts.includes('범위를 확인해 주세요.'));
  assert.equal(s.texts.includes('다른 공간의 비공개 질문'), false); assert.equal(s.texts.includes('내 결정·확인'), false);
  s.clicks.get('terminal-t7')({}, s.cx); assert.deepEqual(s.commands, [['pane.focus', { terminal: 't7' }]]);
  assert.equal(s.clicks.has('harness-capabilities'), false);
  assert.equal(s.clicks.has('harness-transitions'), false);
  s.spaceList[0].id = 's2'; s.spaceList[0].tabs = [];
  s.clicks.get('terminal-t7')({}, s.cx); assert.equal(s.commands.length, 1);
});

test('연결을 확인할 수 없는 원격 공간은 빈 에이전트 목록이나 로컬 하네스로 표시하지 않는다', async () => {
  const s = setup({ machines: () => [{ name: 'remote', layout: 'unavailable' }] }); install(s);
  Object.assign(s.spaceList[0], { id: 'remote/s1', machine: 'remote' });
  const v = new s.Harness(); Object.assign(v, { projects: [await s.load(project)], expanded: new Set() });
  v.render(); assert.deepEqual(v.shown(), []);
  assert.ok(s.texts.includes('현재 공간이 응답하지 않습니다.'));
  assert.equal(s.texts.includes('아직 실행 중인 에이전트가 없습니다.'), false);
  assert.equal(s.texts.includes('에이전트 0 · 터미널 확인 0'), false);
});

test('선택 후 질문 revision이나 공간이 바뀌면 오래된 카드의 답을 보내지 않는다', async () => {
  const sends = [], s = setup({ hc: async (args) => { sends.push(args); return { code: 0 }; } }); install(s);
  const request = { id: 'q', question: '범위를 선택하세요', task: null, source: 'fixture', status: 'open', revision: 1, options: [{ label: '좁게', impact: '현재 변경만' }] };
  const file = project.root + '/state/decisions.json'; s.files.set(file, JSON.stringify({ version: 1, project: 'fixture', requests: { q: request } }));
  const p = await s.load(project), v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
  v.render(); s.clicks.get('answer-fixture-q-0')({}, s.cx); v.render();
  const send = s.clicks.get('answer-fixture-q-send');
  v.projects = [{ ...p, requests: [{ ...p.requests[0], revision: 2 }] }]; send({}, s.cx); assert.equal(sends.length, 0);
  v.projects = [p]; s.spaceList[0].name = 'other'; send({}, s.cx); assert.equal(sends.length, 0);
});

test('업무 목록에서 직접 답할 항목을 구분하고 나머지 막힘에는 근거에서 선택적 지시를 연다', async () => {
  const s = setup(); install(s);
  const ledger = JSON.parse(s.files.get(ledgerPath));
  ledger.tasks.paused = { ...task, id: 'paused', title: '중단한 업무', awaiting: null, blocked_reason: '중단: 사용자 요청' };
  ledger.tasks.environment = { ...task, id: 'environment', awaiting: null, blocked_reason: '중단: 환경 오류 — 사용자 결정 대기' };
  s.files.set(ledgerPath, JSON.stringify(ledger));
  const p = await s.load(project), v = new s.Harness();
  Object.assign(v, { projects: [p], expanded: new Set(), answerInput: { value: () => '', set_value() {}, focus() {} } });
  v.render();
  assert.ok(s.texts.includes('미종결 3건'));
  assert.ok(s.texts.includes('paused · 사용자 요청으로 중단'));
  assert.ok(s.clicks.has('instruction-fixture-a-edit'));
  assert.equal(s.clicks.has('instruction-fixture-environment-edit'), false);
  s.clicks.get('more-decision-fixture-environment')({}, s.cx); v.render();
  assert.ok(s.clicks.has('instruction-fixture-environment-edit'));
  assert.ok(s.clicks.has('instruction-fixture-paused-edit'));
  assert.equal(s.clicks.has('lead-paused-fixture-paused'), false);
  assert.equal(s.texts.includes('작업 브리핑'), false);
  assert.equal(s.clicks.has('more-decision-fixture-paused'), false);
  assert.ok(s.clicks.has('more-paused-fixture-paused'));
});

test('막힘·사용자 중단의 지시는 명시적 전송만 Lead에게 전달하고 업무 상태를 유지한다', async () => {
  for (const paused of [false, true]) {
  const sends = [], s = setup({ hc: async (args) => { sends.push(args); return { code: 0 }; } }); install(s);
  if (paused) {
    const ledger = JSON.parse(s.files.get(ledgerPath));
    Object.assign(ledger.tasks.a, { awaiting: null, blocked_reason: '중단: 사용자 요청' });
    s.files.set(ledgerPath, JSON.stringify(ledger));
  }
  const p = await s.load(project), original = JSON.stringify(p), v = new s.Harness(); let input = '';
  Object.assign(v, { projects: [p], expanded: new Set(), answerInput: { value: () => input, set_value(value) { input = value; }, focus() {} } });
  const jobs = [], cx = { ...s.cx, spawn(fn) { jobs.push(fn(cx)); } };
  const draw = () => { s.texts.length = 0; s.clicks.clear(); v.render(); };
  draw(); s.clicks.get('instruction-fixture-a-edit')({}, cx); input = '범위를 다시 확인해 줘'; draw();
  assert.equal(sends.length, 0);
  s.clicks.get('instruction-fixture-a-cancel')({}, cx); draw(); assert.equal(sends.length, 0);
  s.clicks.get('instruction-fixture-a-edit')({}, cx); input = '  "좁은 범위"로 검토해 줘  '; draw();
  s.clicks.get('instruction-fixture-a-send')({}, cx); draw();
  assert.ok(s.texts.includes('Lead에게 지시 전달 중…'));
  assert.equal(s.clicks.has('instruction-fixture-a-edit'), false);
  await Promise.all(jobs); draw();
  assert.equal(sends.length, 1); assert.deepEqual(sends[0].slice(0, 2), ['send', 't7']);
  assert.match(sends[0][2], /업무 a/); assert.ok(sends[0][2].includes(JSON.stringify('"좁은 범위"로 검토해 줘')));
  assert.equal(sends[0][2].includes('decision resolve'), false);
  assert.ok(s.texts.some((text) => text.startsWith('전달됨 · Lead 처리 대기')));
  assert.equal(JSON.stringify(p), original); assert.equal(attention.decisions(p).length, paused ? 0 : 1);
  assert.equal(attention.pausedTasks(p).length, paused ? 1 : 0);
  }
});

test('지시 입력 뒤 상태·사유·공간·Lead가 바뀌거나 자료가 오래되면 전송하지 않는다', async () => {
  for (const paused of [false, true]) {
  for (const change of ['state', 'reason', 'scope', 'lead', 'restarted', 'stale', 'archived']) {
    const sends = [], s = setup({ hc: async (args) => { sends.push(args); return { code: 0 }; } }); install(s);
    if (paused) {
      const ledger = JSON.parse(s.files.get(ledgerPath));
      Object.assign(ledger.tasks.a, { awaiting: null, blocked_reason: '중단: 사용자 요청' });
      s.files.set(ledgerPath, JSON.stringify(ledger));
    }
    const p = await s.load(project), v = new s.Harness(); let input = '';
    Object.assign(v, { projects: [p], expanded: new Set(), answerInput: { value: () => input, set_value(value) { input = value; }, focus() {} } });
    v.render(); s.clicks.get('instruction-fixture-a-edit')({}, s.cx); input = '다시 검토해';
    const next = { ...p, tasks: p.tasks.map((t) => ({ ...t })) }; v.projects = [next];
    if (change === 'state') next.tasks[0].state = 'DONE';
    if (change === 'reason') next.tasks[0].reason = '다른 결정을 요청';
    if (change === 'scope') s.spaceList[0].name = 'other';
    if (change === 'lead') { next.lead = 't8'; s.terminalList.push({ ...s.terminalList[0], address: 't8' }); }
    if (change === 'restarted') s.terminalList[0] = { ...s.terminalList[0], created_ms: 11 };
    if (change === 'stale') next.stale = true;
    if (change === 'archived') next.tasks[0].archived = true;
    v.render(); v.submitTyped(s.cx);
    assert.equal(sends.length, 0, change);
  }
  }
});

test('활성 release가 있으면 지시·답을 보정 전송 도구로 보내고 실패를 그대로 표시한다', async () => {
  const calls = [], sends = [];
  let code = 0;
  const s = setup({ hc: async (args) => { sends.push(args); return { code: 0 }; },
    exec: async (tool, args, options) => { calls.push({ tool, args, options }); return code ? { code, stdout: '', stderr: 'Enter 3회 뒤에도 t7 입력창에 원문이 남아 있다.' } : { code: 0, stdout: '{}', stderr: '' }; } });
  install(s);
  s.files.set('fixture-home/mods/harness/release.json', JSON.stringify({ release: 'C:/fixture-release' }));
  const p = await s.load(project), v = new s.Harness(); let input = '';
  Object.assign(v, { projects: [p], expanded: new Set(), answerInput: { value: () => input, set_value(value) { input = value; }, focus() {} } });
  const jobs = [], cx = { ...s.cx, spawn(fn) { jobs.push(fn(cx)); } };
  v.render(); s.clicks.get('instruction-fixture-a-edit')({}, cx); input = '다시 검토해'; v.render();
  v.submitTyped(cx); await Promise.all(jobs);
  assert.equal(sends.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'node');
  assert.deepEqual(calls[0].args.slice(0, 2), ['C:/fixture-release/bin/send.mjs', 't7']);
  assert.match(calls[0].args[2], /업무 a/); assert.equal(calls[0].args.length, 3);
  s.texts.length = 0; v.render(); assert.ok(s.texts.some((text) => text.startsWith('전달됨 · Lead 처리 대기')));
  // 도구가 미제출로 실패하면 실패로 보여 다시 보낼 수 있다.
  code = 1; v.instructions = new Map();
  s.clicks.get('instruction-fixture-a-edit')({}, cx); input = '다시 검토해'; v.render(); v.submitTyped(cx); await Promise.all(jobs);
  s.texts.length = 0; v.render(); assert.ok(s.texts.some((text) => text.includes('전달 실패: Enter 3회 뒤에도 t7 입력창에 원문이 남아 있다.')));
});

test('지시 전달 실패는 재입력할 원문을 보존한다', async () => {
  const s = setup({ hc: async () => ({ code: 1, stderr: '연결 끊김' }) }); install(s);
  const p = await s.load(project), v = new s.Harness(); let input = '';
  Object.assign(v, { projects: [p], expanded: new Set(), answerInput: { value: () => input, set_value(value) { input = value; }, focus() {} } });
  const jobs = [], cx = { ...s.cx, spawn(fn) { jobs.push(fn(cx)); } };
  v.render(); s.clicks.get('instruction-fixture-a-edit')({}, cx); input = '원문을 보존해'; v.render();
  v.submitTyped(cx); await Promise.all(jobs); s.texts.length = 0; v.render();
  assert.ok(s.texts.includes('전달 실패: 연결 끊김'));
  s.clicks.get('instruction-fixture-a-edit')({}, cx); assert.equal(input, '원문을 보존해');
  assert.equal(p.tasks[0].state, 'BLOCKED');
});
