import test from 'node:test';
import assert from 'node:assert/strict';
import { briefingContext, taskActivity } from './context.js';

const space = { id: 's1', name: 'repo', active: true, machine: null, tabs: [{ id: 'tab' }] };
const agent = (address, extra = {}) => ({ address, state: 'live', status: 'working', program: { agent: true, name: 'Codex' }, ...extra });
const get = (extra = {}) => briefingContext({ spaces: [space], panes: [{ tab: 'tab', terminal: 't1', cwd: 'D:/repo', branch: 'main' }], ...extra });

test('현재 공간의 터미널·하위 에이전트만 보이며 같은 cwd의 다른 공간은 섞지 않는다', () => {
  const result = get({ terminals: [agent('t1'), agent('t2', { parent: 't1' }), agent('t3', { parent: 't2', status: 'blocked' }),
    agent('other', { cwd: 'D:/repo', labels: { 'herdr.space': 's2' } }), agent('moved', { parent: 't1', labels: { 'herdr.space': 's2' } }),
    agent('closed', { state: 'finished', parent: 't1' }), { address: 'shell', state: 'live', labels: { 'herdr.space': 's1' }, program: { shell: true } }] });
  assert.equal(result.kind, 'basic');
  assert.deepEqual(result.agents.map((a) => a.address), ['t3', 't1', 't2']);
  assert.equal(result.agents.find((a) => a.address === 't1').attached, true);
  assert.equal(result.agents.find((a) => a.address === 't2').attached, false);
});

test('로컬 이름·경로가 겹쳐도 원격 터미널과 하네스 대장을 혼동하지 않는다', () => {
  const remote = { ...space, id: 'vm/s1', machine: 'vm' };
  const result = get({ spaces: [remote], panes: [], machines: [{ name: 'vm', layout: 'ready' }],
    projects: [{ name: 'repo', root: 'D:/repo' }], terminals: [agent('t1', { labels: { 'herdr.space': 's1' } }), agent('vm/t1', { labels: { 'herdr.space': 's1' } })] });
  assert.equal(result.kind, 'basic'); assert.equal(result.project, null);
  assert.deepEqual(result.agents.map((a) => a.address), ['vm/t1']);
  for (const state of ['loading', 'unavailable']) {
    const r = get({ spaces: [remote], machines: [{ name: 'vm', layout: state }], terminals: [agent('vm/t1', { labels: { 'herdr.space': 's1' } })] });
    assert.equal(r.kind, state); assert.deepEqual(r.agents, []);
  }
});

test('등록 레포는 가장 구체적인 경로로 연결하며 실제 cwd가 다르면 이름으로 대체하지 않는다', () => {
  const projects = [{ name: 'parent', root: 'D:/' }, { name: 'repo', root: 'D:/repo' }];
  assert.equal(get({ projects }).project.name, 'repo');
  assert.equal(get({ projects, panes: [{ tab: 'tab', cwd: 'd:\\REPO\\src' }] }).kind, 'harness');
  assert.equal(get({ projects: projects.slice(1), panes: [{ tab: 'tab', cwd: 'D:/repo-other' }] }).kind, 'basic');
  assert.equal(get({ projects, spaces: [] }).kind, 'none');
  assert.equal(get({ projects, spaces: [{ ...space, id: undefined }], panes: [], terminals: [agent('unknown')] }).agents.length, 0);
});

test('일반 상태·보고는 원문이며 완료 상태를 QA 성공으로 해석하지 않는다', () => {
  const result = get({ terminals: [agent('t1', { status: 'done', report: { msg: '  다음 단계는 검토입니다.  ' } })] });
  assert.equal(result.agents[0].label, '응답 완료');
  assert.equal(result.agents[0].message, '다음 단계는 검토입니다.');
  const idle = get({ terminals: [agent('t1', { status: 'idle' })] });
  assert.equal(idle.agents[0].label, '대기');
  const blocked = get({ terminals: [agent('t1', { status: 'blocked' })] });
  assert.equal(blocked.agents[0].label, '입력 필요');
  const task = { run: { live: true, address: 't1' } }, live = new Map([['t1', agent('t1', { report: { msg: '구현 보고' } })]]);
  assert.equal(taskActivity(task, live, 'repo').text, '구현 보고');
  live.get('t1').labels = { 'harness.project': 'another' };
  assert.equal(taskActivity(task, live, 'repo'), null);
  assert.equal(taskActivity({ run: { live: false, address: 't1' } }, live, 'repo'), null);
});
