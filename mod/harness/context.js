// 현재 공간의 기본 브리핑. 파일·네트워크·화면 파싱 없이 Herdr의 보고만 사용한다.
const path = (value) => String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
const localPath = (value) => { const p = path(value); return /^[a-z]:(\/|$)/i.test(p) || p.startsWith('//') ? p.toLowerCase() : p; };
const bare = (value) => String(value ?? '').split('/').at(-1);
const machineOf = (terminal) => terminal.address?.includes('/') ? terminal.address.slice(0, terminal.address.lastIndexOf('/')) : null;
const STATES = { working: '작업 중', blocked: '입력 필요', error: '오류', done: '응답 완료', idle: '대기' };
export const activityLabel = (status) => STATES[status] ?? '상태 미확인';
export const reportedMessage = (terminal) => typeof terminal?.report?.msg === 'string' ? terminal.report.msg.trim() : '';
export const needsTerminal = (terminal) => ['blocked', 'error'].includes(terminal.status);
const isAgent = (terminal) => terminal.program?.agent === true || Boolean(terminal.app || terminal.report?.app) || Boolean(STATES[terminal.status]);

export function briefingContext({ spaces = [], panes = [], terminals = [], machines = [], projects = [] }) {
  const space = spaces.find((s) => s.active);
  if (!space) return { kind: 'none', name: '현재 공간 없음', project: null, agents: [], terminal: null };
  const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
  const ownPanes = panes.filter((p) => tabs.has(p.tab));
  const first = ownPanes.find((p) => p.cwd);
  const cwd = first?.cwd ?? null;
  const machine = space.machine || null;
  const project = machine ? null : [...projects].sort((a, b) => b.root.length - a.root.length).find((p) => cwd
    ? localPath(cwd) === localPath(p.root) || localPath(cwd).startsWith(`${localPath(p.root)}/`)
    : p.name === space.name) ?? null;
  const connection = machines.find((m) => (m.name || null) === machine)?.layout;
  // 로컬 문서에서 공간 자체를 읽었다면 연결은 유효하다. 원격 연결이 없거나 실패했으면 빈 목록으로 꾸미지 않는다.
  const unavailable = connection === 'unavailable' || (machine && !connection);
  const loading = connection === 'loading';
  const owned = new Set(ownPanes.map((p) => p.terminal).filter(Boolean));
  const attached = new Set(owned);
  const live = terminals.filter((terminal) => terminal.state === 'live' && machineOf(terminal) === machine);
  for (const terminal of live) {
    const labels = terminal.labels ?? {};
    if (labels['herdr.space'] && (labels['herdr.space'] === space.id || labels['herdr.space'] === bare(space.id))) owned.add(terminal.address);
  }
  // 공간의 터미널에서 파생된 pane 없는 하위 에이전트도 포함하되 다른 공간으로 편입된 자식은 제외한다.
  for (let changed = true; changed;) {
    changed = false;
    for (const terminal of live) {
      const assigned = terminal.labels?.['herdr.space'];
      if (assigned && assigned !== space.id && assigned !== bare(space.id)) continue;
      if (!owned.has(terminal.address) && owned.has(terminal.parent)) { owned.add(terminal.address); changed = true; }
    }
  }
  const agents = unavailable || loading ? [] : live.filter((terminal) => owned.has(terminal.address) && isAgent(terminal)).map((terminal) => {
    const pane = ownPanes.find((p) => p.terminal === terminal.address);
    return { ...terminal, title: terminal.name || pane?.title || terminal.program?.name || terminal.app || terminal.address,
      attached: attached.has(terminal.address), message: reportedMessage(terminal), label: activityLabel(terminal.status) };
  }).sort((a, b) => Number(needsTerminal(b)) - Number(needsTerminal(a)) || Number(b.status === 'working') - Number(a.status === 'working'));
  return { kind: unavailable ? 'unavailable' : loading ? 'loading' : project ? 'harness' : 'basic',
    space, machine, cwd, name: project?.name ?? space.name ?? path(cwd).split('/').at(-1) ?? '현재 공간',
    branch: first?.branch ?? space.branch ?? null, project, agents,
    terminal: ownPanes.find((p) => p.terminal)?.terminal ?? null };
}

// 대장의 실행과 정확히 연결된 터미널의 보고만 업무 활동으로 표시한다.
export function taskActivity(task, live, projectId) {
  if (!task.run?.live || !task.run.address) return null;
  const terminal = live.get(task.run.address);
  if (!terminal || terminal.state !== 'live') return null;
  const owner = terminal.labels?.['harness.project'];
  if (owner && owner !== projectId) return null;
  return { text: reportedMessage(terminal), label: activityLabel(terminal.status) };
}
