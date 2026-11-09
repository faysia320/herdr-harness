import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as attention from './attention.js';
import * as logic from './logic.js';

// 호스트 경계만 대역으로 바꾸고 실제 load/render/클릭 함수를 실행한다.
const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export default class Harness', 'class Harness');
function setup() {
  const files = new Map(), store = new Map(), clicks = new Map(), commands = [], texts = [];
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
      const value = files.get(p); if (value instanceof Error) throw value; return value ?? null;
    }, watchFolder: () => new Promise(() => {}), terminals: () => terminalList,
    spaces: () => spaceList, panes: () => paneList, shared: (k) => store.get(k), setShared: (k, v) => store.set(k, v),
    theme: () => new Proxy({}, { get: () => '#808080' }), run: (...args) => commands.push(args), notify: () => {}, playSound: () => {}, props: () => ({}), closeOverlay: () => {} };
  const module = new Function(...Object.keys(api), `${source}; return {Harness, load, normalize};`)(...Object.values(api));
  return { ...module, files, store, clicks, commands, texts, terminalList, spaceList, paneList, gitRenders,
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

test('일반 저장소는 전체 보기·브리핑 선택 상태에서도 현재 Git Tree만 표시한다', async () => {
  const s = setup(); install(s);
  const v = new s.Harness();
  Object.assign(v, { projects: [await s.load(project)], expanded: new Set(), page: 'brief', allProjects: true, git: s.git });
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
  assert.equal(s.clicks.has('harness-scope'), true);
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
  Object.assign(v, { projects: [p], expanded: new Set(), showEnded: false, allProjects: false });
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
  s.clicks.get('harness-scope')({}, s.cx); assert.equal(v.allProjects, true);
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
  const s = setup(); install(s); const p = await s.load(project);
  const stamp = new Date().toISOString();
  p.tasks.push(s.normalize({ ...task, id: 'running', title: '현재 진행 업무', state: 'IMPLEMENTING', awaiting: null, blocked_reason: null }));
  for (let i = 0; i < 4; i++) {
    p.tasks.push(s.normalize({ ...task, id: `done-${i}`, state: 'DONE', awaiting: null, blocked_reason: null }));
    p.events.push({ task: `done-${i}`, at: stamp, from: 'QA', to: 'DONE', why: `결과 ${i}` });
  }
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

test('실제 Lead 원문은 대장 결정 0건·변화 읽음·done에서 idle 이후에도 보인다', async () => {
  const s = setup(); install(s); const p = await s.load(project);
  p.tasks[0].state = 'DONE';
  const message = 'PR #793 준비됨; 병합 여부와 콜아웃 업무 답 대기';
  Object.assign(s.terminalList[0], { status: 'done', report: { app: 'claude-code', msg: message } });
  const v = new s.Harness(); Object.assign(v, { projects: [p], expanded: new Set() });
  const draw = () => { s.clicks.clear(); s.texts.length = 0; v.render(); };
  draw(); assert.ok(s.texts.includes(message)); assert.ok(s.texts.includes('질문 0 · 막힘 0 · 보고 1'));
  assert.equal(s.texts.includes('지금 결정할 일이 없습니다.'), false);
  s.clicks.get('read-fixture')({}, s.cx); s.terminalList[0].status = 'idle'; draw();
  assert.ok(s.texts.includes(message)); assert.equal(s.commands.length, 0);
  s.clicks.get('lead-report-fixture')({}, s.cx);
  assert.deepEqual(s.commands, [['agent.focus', { terminal: 't7' }]]);
  s.terminalList[0].status = 'working'; s.terminalList[0].report = {}; draw();
  assert.ok(s.texts.includes(message)); assert.ok(s.texts.includes('fixture · t7 · 마지막 수신 응답'));
  s.terminalList[0].status = 'done'; s.terminalList[0].report = { msg: '콜아웃 범위 좁게/넓게 답 대기' }; draw();
  assert.ok(s.texts.includes('콜아웃 범위 좁게/넓게 답 대기')); assert.equal(s.texts.includes(message), false);
  const reports = [...s.clicks.keys()].filter((k) => k?.startsWith('lead-report-'));
  assert.equal(reports.length, 1);
  s.terminalList[0].state = 'exited'; draw();
  assert.equal(s.clicks.has('lead-report-fixture'), false);
  assert.ok(s.texts.some((text) => text.includes('별도 질문 여부를 확인할 수 없습니다')));
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
