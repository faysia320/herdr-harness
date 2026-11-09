// 상태 조회가 index나 fsmonitor를 갱신하지 않게 한다. 원격 동기화는 별도 명시적 동작이다.
export const READ = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false'];
export function parseLog(text) {
  return text.split('\x1e').map((s) => s.replace(/^\s+/, '')).filter(Boolean).map((s) => {
    const [hash, parents, author, date, refs, message] = s.trimEnd().split('\x1f');
    if (!/^[a-f0-9]{40,64}$/.test(hash) || message === undefined) throw new Error('커밋 기록 형식을 읽지 못했습니다.');
    return { hash, parents: parents ? parents.split(' ') : [], author, date, refs: refs ? refs.split(', ') : [], message, subject: message.split('\n')[0] || '(메시지 없음)' };
  });
}
export function parseStatus(text) {
  const rows = text.split('\n');
  const value = (key) => rows.find((s) => s.startsWith(`# ${key} `))?.slice(key.length + 3);
  const ab = /^\+(\d+) -(\d+)$/.exec(value('branch.ab') ?? '');
  return { branch: value('branch.head') ?? 'HEAD', head: value('branch.oid'), upstream: value('branch.upstream'), ahead: +(ab?.[1] ?? 0), behind: +(ab?.[2] ?? 0), dirty: rows.filter((s) => /^[12u?] /.test(s)).length };
}

// topo-order에서 아직 만나지 않은 부모를 레인에 유지한다. 합류는 기존 부모 레인으로 연결한다.
export function graphRows(commits) {
  let lanes = [], serial = 0, width = 1;
  const colors = new Map();
  const colorFor = (hash, inherit) => {
    if (!colors.has(hash)) colors.set(hash, inherit ?? serial++);
    return colors.get(hash);
  };
  const allocate = (hash, preferred = -1) => {
    let slot = lanes.indexOf(hash);
    if (slot < 0) {
      slot = preferred >= 0 && !lanes[preferred] ? preferred : lanes.indexOf(null);
      if (slot < 0) slot = lanes.length;
      lanes[slot] = hash;
    }
    return slot;
  };
  const rows = commits.map((commit) => {
    const incoming = lanes.includes(commit.hash), lane = allocate(commit.hash), color = colorFor(commit.hash);
    const before = [...lanes]; lanes[lane] = null;
    const parents = commit.parents.map((hash, i) => ({ lane: allocate(hash, i === 0 ? lane : -1), color: colorFor(hash, i === 0 ? color : undefined), hash }));
    const rails = before.flatMap((hash, i) => hash && hash !== commit.hash ? [{ lane: i, color: colorFor(hash) }] : []);
    width = Math.max(width, before.length, lanes.length);
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { ...commit, lane, color, incoming, parents, rails };
  });
  return { rows, width };
}

export async function loadGit(exec, root, all = true) {
  const call = async (args) => {
    const r = await exec('git', [...READ, ...args], { cwd: root, timeout: 15000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Git 정보를 읽지 못했습니다.');
    return r.stdout;
  };
  const status = parseStatus(await call(['status', '--porcelain=v2', '--branch', '--untracked-files=normal']));
  if (status.head === '(initial)') return { ...status, commits: [], rows: [], width: 1, updated: Date.now() };
  const log = await call(['log', ...(all ? ['--all', 'HEAD'] : ['HEAD']), '--topo-order', '-80', '--decorate=short', '--format=%x1e%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%B', '--']);
  const commits = parseLog(log);
  return { ...status, commits, ...graphRows(commits), updated: Date.now() };
}

// 버튼을 누른 저장소에서만 실행한다. Pull은 브랜치를 재확인하며 자동 병합·rebase·stash를 하지 않는다.
export async function syncGit(exec, root, action, expectedBranch) {
  if (!['fetch', 'pull'].includes(action)) throw new Error('지원하지 않는 Git 동작입니다.');
  if (action === 'pull') {
    const r = await exec('git', [...READ, 'status', '--porcelain=v2', '--branch', '--untracked-files=no'], { cwd: root, timeout: 15000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || '현재 브랜치를 확인하지 못했습니다.');
    const status = parseStatus(r.stdout);
    if (!expectedBranch || status.branch !== expectedBranch || status.branch === '(detached)') throw new Error('현재 브랜치가 바뀌었습니다. 새로고침 후 Pull을 다시 눌러 주세요.');
    if (!status.upstream) throw new Error('이 브랜치에 연결된 upstream이 없습니다.');
  }
  const args = action === 'fetch'
    ? ['fetch', '--all', '--no-prune', '--no-recurse-submodules']
    : ['pull', '--ff-only', '--no-rebase', '--no-autostash', '--no-recurse-submodules'];
  const r = await exec('git', ['-c', 'credential.interactive=false', ...args], { cwd: root, timeout: 120000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `${action === 'fetch' ? 'Fetch' : 'Pull'} 실패`);
  return [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
}
