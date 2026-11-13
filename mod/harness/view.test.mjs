import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as attention from './attention.js';
import * as logic from './logic.js';

// 호스트 경계만 대역으로 바꾸고 실제 load/render/클릭 함수를 실행한다.
const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export default class Harness', 'class Harness');
function setup(overrides = {}) {
  const files = new Map(), store = new Map(), clicks = new Map(), commands = [], texts = [], reads = [];
  const terminalList = [{ address: 't7', state: 'live', status: 'working', created_ms: 10 }];
  const spaceList = [{ name: 'fixture', active: true, machine: null }], paneList = [], gitRenders = [];
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
    ...attention, ...logic, appHome: () => 'fixture-home', readTextFile: async (p) => {
      reads.push(p);
      const value = files.get(p); if (value instanceof Error) throw value; return value ?? null;
    }, watchFolder: () => new Promise(() => {}), terminals: () => terminalList,
    spaces: () => spaceList, panes: () => paneList, shared: (k) => store.get(k), setShared: (k, v) => store.set(k, v),
    theme: () => new Proxy({}, { get: () => '#808080' }), run: (...args) => commands.push(args), notify: () => {}, playSound: () => {}, props: () => ({}), closeOverlay: () => {},
    GitTree: class {}, nextCommand: () => new Promise(() => {}),
    InputState: { new: () => { let value = ''; return { value: () => value, set_value: (v) => { value = v; }, focus() {}, on() {} }; } },
    Input: { new: () => el() }, exec: async () => ({ code: 1, stdout: '', stderr: '' }), home: () => 'C:/fixture-home', hc: async () => ({ code: 0, stdout: '', stderr: '' }), ...overrides };
  const module = new Function(...Object.keys(api), `${source}; return {Harness, load, normalize};`)(...Object.values(api));
  return { ...module, files, store, clicks, commands, texts, reads, terminalList, spaceList, paneList, gitRenders,
    git: { render(projects) { gitRenders.push(projects); return el(); } }, cx: { notify() {}, stop_propagation() {} } };
}
const project = { name: 'fixture', root: 'D:/fixture' };
const configPath = project.root + '/.agents/harness/config.json';
const ledgerPath = project.root + '/state/ledger.json';
const task = { id: 'a', title: '권한을 결정해 주세요', state: 'BLOCKED', awaiting: 'permission', blocked_reason: '권한 범위를 선택해야 합니다.', runs: [], history: [], updated: new Date().toISOString() };
const install = (s) => {
  s.files.set(configPath, JSON.stringify({ project: { id: 'fixture', state_dir: 'state' } }));
  s.files.set(ledgerPath, JSON.stringify({ version: 1, project: 'fixture', tasks: { a: task }, lead: { terminal: 't7' } }));
};

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

test('일반 저장소는 브리핑 선택 상태에서도 현재 Git Tree만 표시한다', async () => {
  const s = setup(); install(s);
  const v = new s.Harness();
  Object.assign(v, { projects: [await s.load(project)], expanded: new Set(), page: 'brief', git: s.git });
  Object.assign(s.spaceList[0], { name: 'herdr-harness', folder: 'D:/old', tabs: [{ id: 'tab' }] });
  s.paneList.push({ tab: 'unrelated', cwd: 'D:/unrelated' }, { tab: 'tab', cwd: 'D:/repositories/herdr-harness' });
  v.render(s.cx);
  assert.equal(s.clicks.has('harness-tab-brief'), false);
  assert.equal(s.clicks.has('harness-scope'), false);
  assert.equal(s.clicks.has('harness-tab-git'), true);
  assert.equal(s.texts.includes('내 결정·확인'), false);
  assert.deepEqual(s.gitRenders.at(-1).map((p) => p.root), ['D:/repositories/herdr-harness']);
  // 공간 이름이 등록된 프로젝트와 같아도 다른 실제 경로에 브리핑을 노출하지 않는다.
  s.spaceList[0].name = 'fixture'; s.clicks.clear(); v.render(s.cx);
  assert.equal(s.clicks.has('harness-tab-brief'), false);
  // 등록된 저장소로 복귀하면 기존 탭 선택을 복원한다. 경로 구분자·대소문자·하위 폴더도 허용한다.
  s.paneList[1].cwd = 'd:\\FIXTURE\\src'; s.clicks.clear(); v.render(s.cx);
  assert.equal(s.clicks.has('harness-tab-brief'), true);
  assert.equal(s.clicks.has('harness-scope'), false);
  assert.ok(s.texts.includes('내 결정·확인'));
});

test('미등록 공간은 projects.json이 없어도 폴더로 Git Tree를 표시한다', () => {
  const s = setup(), v = new s.Harness();
  Object.assign(v, { projects: [], error: '설정 없음', git: s.git });
  Object.assign(s.spaceList[0], { name: 'other', folder: 'D:/other' });
  v.render(s.cx);
  assert.equal(s.gitRenders.at(-1)[0].root, 'D:/other');
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

test('결정·변화·진행은 한 화면에 있고 읽음·Lead 이동·종료 필터는 독립적이다', async () => {
  const s = setup(); install(s); const p = await s.load(project);
  const v = new s.Harness();
  Object.assign(v, { projects: [p], expanded: new Set(), showEnded: false });
  v.render();
  assert.ok(s.texts.includes('내 결정·확인')); assert.ok(s.texts.includes(task.blocked_reason));
  assert.ok(s.texts.includes('알아둘 변화')); assert.ok(s.texts.includes('진행 중'));
  assert.equal(s.clicks.has('page-progress'), false); assert.equal(s.clicks.has('page-attention'), false);
  assert.equal(s.clicks.has('task-fixture/a'), false); // 결정함과 진행 목록에 중복 표시하지 않는다.
  s.clicks.get('read-fixture')({}, s.cx);
  assert.equal(s.commands.length, 0); assert.equal(attention.decisions(p).length, 1);
  assert.equal(attention.changes(p, s.store.get(attention.seenKey(p))).length, 0);
  s.clicks.get('lead-decision-fixture-a')({}, s.cx);
  assert.deepEqual(s.commands, [['agent.focus', { terminal: 't7' }]]);
  s.clicks.get('harness-ended')({}, s.cx); assert.equal(v.showEnded, true);
  s.clicks.get('harness-transitions')({}, s.cx); assert.equal(v.showTransitions, true);
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
  const s = setup(); install(s); const p = await s.load(project);
  p.tasks[0].state = 'DONE';
  const message = 'ITSM 5건 하네스 등록; 3건 조사 중, 2건 대기, 완료 보고 대기';
  Object.assign(s.terminalList[0], { status: 'done', report: { msg: message } });
  const v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
  const live = new Map([['t7', s.terminalList[0]]]);
  const draw = () => { s.clicks.clear(); s.texts.length = 0; v.render(); };
  draw();
  assert.ok(s.texts.includes(message));
  s.clicks.get('lead-status-fixture')({}, s.cx);
  assert.deepEqual(s.commands, [['agent.focus', { terminal: 't7' }]]);
  for (const status of ['done', 'idle', 'working', 'blocked', 'error']) {
    s.terminalList[0].status = status;
    s.texts.length = 0; s.clicks.clear();
    v.attention([p], live, {});
    assert.ok(s.texts.includes('질문 0 · 막힘 0'));
    assert.equal(s.texts.includes(message), false);
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
  f.texts.length = 0; fv.render(); f.clicks.get('answer-fixture-tools-1')({}, fcx); await Promise.all(fjobs);
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
  for (let i = 0; i < 3; i++) v.attention([p], new Map(), {});
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
