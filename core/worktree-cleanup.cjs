// 끝난 업무의 worktree와 로컬 업무 브랜치 정리 공통 규칙. 저장소의 경로·브랜치 규칙, 실행 조회, 대장 쓰기는 호출자가 맡는다.
// 순서: 실행·경로·Git 상태 사전검사 → 과정 문서·지정 파일 재보관 → (예외 종결) 후보 patch 보존 → 의도 기록 → 후보 경로 되돌리기
// → 비강제 worktree remove → (병합 증명) 로컬 업무 브랜치 삭제. 맞지 않는 조건이 있으면 그 단계 전에 멈추고 이유를 돌려준다.
// 강제 worktree 제거·재귀 삭제·update-ref·원격 ref 변경은 하지 않는다. 준비 시간 초과로 남은 부분 worktree는 대상이 아니다.
// status가 숨길 수 있는 변경(index 플래그·fsmonitor·untracked cache·환경변수로 바꾼 index)과 submodule은 사전검사에서 막는다.
// stat 캐시가 숨기는 변경은 사전검사와 worktree remove 직전에 추적 파일 전체의 내용 해시를 index blob과 비교해 막는다.
// 같은 두 시점에 worktree 폴더를 직접 순회해 Git이 보여 주지 않는 항목(.git 이름 항목·링크·junction·대소문자만 다른 이름)과 worktree 전용 ref·진행 중 작업을 막는다.
// Git이 경로를 지우거나 덮어쓰는 단계(후보 되돌리기·worktree remove) 직전에는 대상과 상위 구성요소가 링크·junction이 아닌지 다시 본다.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const artifacts = require('./artifact-policy.cjs');
const { candidateTree } = require('./verification-receipt.cjs');

const VERSION = 1;
const CONTENT_MS = 60000;
const oid = /^[0-9a-f]{40}$/;
const safe = /^[A-Za-z0-9._-]+$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (parent, child) => { const r = path.relative(parent, child); return Boolean(r) && !r.startsWith('..') && !path.isAbsolute(r); };
const covered = (p, list) => list.some((d) => (d.endsWith('/') ? p.startsWith(d) : p === d));

// Git 호출마다 시간·출력 한도를 둔다. 한도 초과·시간 초과도 실패다(깨끗한 상태로 보지 않는다).
// status가 변경을 숨기지 않도록 fsmonitor·untracked cache를 쓰지 않고, 조회가 index를 고쳐 쓰지 않게 한다.
// 상위 프로세스가 넘긴 저장소·index 위치 환경변수는 지운다(다른 index와 비교하면 변경이 보이지 않는다).
const GLOBAL = ['--no-optional-locks', '-c', 'core.longpaths=true', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
const REDIRECT = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'];
const baseEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !REDIRECT.includes(k.toUpperCase()))), ...extra });
function run(cwd, args, { env = baseEnv(), out, input, timeout = 30000 } = {}) {
  const r = spawnSync('git', [...GLOBAL, ...args], {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 << 20, input, stdio: [input == null ? 'ignore' : 'pipe', out ?? 'pipe', 'pipe'],
  });
  return { code: r.error ? null : r.status, out: r.stdout ?? '', err: String(r.error?.message ?? r.stderr ?? '').trim(), timedOut: r.error?.code === 'ETIMEDOUT' };
}
function git(cwd, args, options) {
  const r = run(cwd, args, options);
  if (r.code !== 0) fail(`Git 실행 실패(git ${args[0]}): ${r.err || `종료 ${r.code}`}`);
  return r.out;
}
const literal = (extra = {}) => baseEnv({ GIT_LITERAL_PATHSPECS: '1', ...extra });
function revParse(cwd, ref) {
  const r = run(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  if (r.code === 1 && !r.out.trim()) return null;
  if (r.code !== 0 || !oid.test(r.out.trim())) fail(`Git ref 조회 실패: ${ref}`);
  return r.out.trim();
}

function lexists(p) {
  try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; }
}
// 실제 경로로 비교한다(8.3 단축명·대소문자·구분자). 없는 경로는 부모의 실제 경로와 이름으로 비교한다.
function real(p) {
  try { return norm(fs.realpathSync.native(p)); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return norm(path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)));
  }
}

function worktrees(root) {
  return git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map((block) => {
    const entry = {};
    for (const line of block.split('\0').filter(Boolean)) {
      const at = line.indexOf(' '), key = at < 0 ? line : line.slice(0, at), value = at < 0 ? '' : line.slice(at + 1);
      if (key === 'worktree') entry.path = value;
      else if (key === 'HEAD') entry.head = value;
      else if (key === 'branch') entry.branch = value;
      else entry[key] = value || true;
    }
    if (!entry.path) fail('Git worktree 목록을 해석할 수 없다.');
    entry.real = real(entry.path);
    return entry;
  });
}

// 이름 바꾸기를 나누지 않고, 무시 패턴에 맞는 폴더는 한 항목으로 받는다(node_modules 같은 폴더를 펼치지 않는다).
function status(cwd) {
  return git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames'])
    .split('\0').filter(Boolean).map((s) => ({ x: s[0], y: s[1], path: s.slice(3) }));
}

// status가 보여 주지 않는 index 상태를 거부한다. assume-unchanged(소문자 표시)·skip-worktree(S) 경로는 작업 사본 변경이
// status에 나오지 않고 비강제 remove도 그대로 지운다. submodule(.gitmodules·gitlink·modules 폴더)은 Git이 비강제 제거를 거부한다.
function hiddenIndex(cwd) {
  const entries = git(cwd, ['ls-files', '-v', '-s', '-z']).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t'), [tag, mode, blob] = line.slice(0, tab).split(' ');
    return { tag, mode, blob, path: line.slice(tab + 1) };
  });
  const modules = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'modules']).trim());
  const sub = [...(lexists(path.join(cwd, '.gitmodules')) ? ['.gitmodules'] : []),
    ...entries.filter((e) => e.mode === '160000').map((e) => `gitlink ${e.path}`), ...(lexists(modules) ? [`${modules}`] : [])];
  if (sub.length) fail(`submodule이 있는 worktree는 Git이 비강제 제거를 거부하므로 정리하지 않는다: ${sub.slice(0, 20).join(', ')}. submodule 내용을 확인해 옮긴 뒤 Lead가 직접 처리한다.`);
  const flagged = entries.filter((e) => e.tag !== e.tag.toUpperCase() || e.tag === 'S');
  if (!flagged.length) return;
  const shown = flagged.slice(0, 20), names = shown.map((e) => e.path);
  const staged = new Set(git(cwd, ['diff-index', '--cached', '-z', '--name-only', '--no-renames', 'HEAD', '--', ...names], { env: literal() }).split('\0').filter(Boolean));
  const detail = shown.map((e) => {
    const flags = [...(e.tag !== e.tag.toUpperCase() ? ['assume-unchanged'] : []), ...(e.tag.toUpperCase() === 'S' ? ['skip-worktree'] : [])];
    const abs = path.join(cwd, ...e.path.split('/'));
    let copy;
    if (!lexists(abs)) copy = '작업 사본 없음';
    else if (!fs.lstatSync(abs).isFile()) copy = '작업 사본이 일반 파일이 아님';
    else copy = git(cwd, ['hash-object', '--', e.path], { env: literal() }).trim() === e.blob ? '작업 사본=index' : '작업 사본≠index';
    return `${e.path}(${flags.join('·')}; ${copy}${staged.has(e.path) ? '; index≠HEAD' : ''})`;
  });
  fail(`status가 변경을 숨기는 index 플래그 경로가 있다: ${detail.join(', ')}${flagged.length > 20 ? ` 외 ${flagged.length - 20}건` : ''}. `
    + 'git update-index --no-assume-unchanged --no-skip-worktree -- <경로>로 플래그를 풀고 변경을 확인한 뒤 재시도한다.');
}

// worktree 전용 ref와 진행 중인 병합·cherry-pick·revert·rebase·bisect 상태는 worktree의 Git 폴더에 있어 remove와 함께 사라진다.
// 이 ref만 가리키는 커밋은 이름을 잃고 prune 대상이 되며, 진행 상태(충돌 해결 중 메시지·todo 목록)는 되살릴 수 없다.
const OWN_REFS = ['refs/worktree', 'refs/bisect', 'refs/rewritten'];
const PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG', 'sequencer'];
function ownState(cwd) {
  const refs = git(cwd, ['for-each-ref', '--format=%(refname)', ...OWN_REFS]).split('\n').filter(Boolean);
  if (refs.length) fail(`worktree 전용 ref가 있다(worktree와 함께 사라진다): ${refs.slice(0, 20).join(', ')}${refs.length > 20 ? ` 외 ${refs.length - 20}건` : ''}. `
    + '보존할 커밋은 공용 ref로 옮기고(git branch <이름> <ref>) 필요 없는 ref는 지운 뒤 재시도한다.');
  const at = git(cwd, ['rev-parse', ...PROGRESS.flatMap((p) => ['--git-path', p])]).split(/\r?\n/).filter(Boolean);
  if (at.length !== PROGRESS.length) fail('worktree Git 폴더 위치를 해석할 수 없다.');
  const busy = PROGRESS.filter((_, i) => lexists(path.resolve(cwd, at[i])));
  if (busy.length) fail(`진행 중인 Git 작업 상태가 있다: ${busy.join(', ')}. 작업을 마치거나(--continue) 취소한(--abort) 뒤 재시도한다.`);
}

// 원래 바이트의 blob ID. index blob 길이로 SHA-1·SHA-256 저장소를 구분한다.
const blobId = (bytes, like) => createHash(like.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
// hash-object --stdin-paths는 큰따옴표로 시작하는 줄을 C 문자열로 풀어 읽는다. 줄바꿈·제어 문자가 든 경로도 그대로 넘긴다.
const quote = (p) => `"${p.replace(/[\\"]/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}"`;

// 추적 파일의 실제 내용을 index blob과 비교한다. status는 크기·mtime 같은 stat 정보가 index 기록과 같으면 파일을 읽지 않으므로
// 같은 길이로 고친 뒤 mtime을 되돌린 변경을 보지 못한다. status가 작업 사본=index라고 본 경로를 모두 hash-object(필터 적용)로
// 다시 계산하고, 다르면 원래 바이트의 blob도 계산해 둘 다 index blob과 다를 때 거부한다. 시간 한도 안에 끝내지 못해도 거부한다.
// 디스크에서 링크로 있고 대상 문자열이 index blob과 같은 추적 링크 경로를 돌려준다(폴더 순회가 이 링크만 설명된 것으로 본다).
function sameContent(s, entries) {
  const shown = new Set(entries.filter((e) => e.y !== ' ').map((e) => e.path));
  const differ = [], files = [], links = new Set();
  for (const line of git(s.worktree, ['ls-files', '-s', '-z']).split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t'), [mode, blob] = line.slice(0, tab).split(' '), p = line.slice(tab + 1);
    if (shown.has(p)) continue;
    const abs = path.join(s.worktree, ...p.split('/'));
    let st = null;
    try { st = fs.lstatSync(abs); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    if (st?.isFile()) files.push({ path: p, blob, abs });
    else if (st?.isSymbolicLink() && mode === '120000') {
      // Git for Windows는 링크 대상을 \로 만들고 /로 읽는다.
      const text = fs.readlinkSync(abs);
      if ([text, text.replaceAll('\\', '/')].some((t) => blobId(Buffer.from(t), blob) === blob)) links.add(p);
      else differ.push(`${p}(링크 대상≠index)`);
    } else differ.push(`${p}(${st ? '종류가 index와 다름' : '작업 사본 없음'})`);
  }
  if (files.length) {
    const left = s.deadline - Date.now();
    if (left <= 0) fail(overdue(s));
    const r = run(s.worktree, ['hash-object', '--stdin-paths'], { input: `${files.map((f) => quote(f.path)).join('\n')}\n`, timeout: left });
    if (r.timedOut) fail(overdue(s));
    if (r.code !== 0) fail(`Git 실행 실패(git hash-object): ${r.err || `종료 ${r.code}`}`);
    const ids = r.out.split('\n').filter(Boolean);
    if (ids.length !== files.length) fail('hash-object 결과 수가 추적 파일 수와 다르다.');
    files.forEach((f, i) => { if (ids[i] !== f.blob && blobId(fs.readFileSync(f.abs), f.blob) !== f.blob) differ.push(f.path); });
  }
  if (differ.length) fail(`status에 나오지 않은 작업 사본 변경이 있다(내용 해시≠index blob): ${differ.slice(0, 20).join(', ')}`
    + `${differ.length > 20 ? ` 외 ${differ.length - 20}건` : ''}. 변경을 확인해 커밋하거나 옮긴 뒤 재시도한다.`);
  return links;
}
const overdue = (s) => `추적 파일 내용 확인·폴더 순회가 시간 한도(${s.limit}ms) 안에 끝나지 않았다. 변경 여부를 확인하지 못해 지우지 않는다. 한도가 더 긴 재시도 명령으로 다시 정리한다.`;

// worktree 폴더를 링크를 따라가지 않고 직접 순회해, 지워질 항목이 모두 추적 파일(내용 확인 통과)이나 status가 보고하고 분류한
// 항목(keep·discard·과정 문서·후보)인지 대조한다. Git은 깊이와 무관하게 .git 이름 항목(중첩 저장소·같은 이름 폴더)을 건너뛰고
// 무시된 폴더 안을 보지 않으며, Git for Windows의 비강제 remove는 junction을 폴더로 따라가 worktree 밖 대상까지 지운다.
// 그래서 설명되지 않는 파일, 추적 링크가 아닌 링크·junction, 최상위 .git 파일 외의 .git 이름 항목은 하나라도 있으면 거부한다.
// 디스크의 링크·junction은 index mode가 120000이고 status가 그 경로를 보고하지 않으며 내용 확인(sameContent)이 링크 대상=index blob을
// 확인한 경우에만 추적 링크로 본다. index mode만으로 면제하면 추적 링크 경로를 밖 폴더 junction으로 바꾼 후보가 통과한다(후보 경로여도 거부).
// discard 폴더 안도 순회한다(내용은 지워도 되지만 링크·중첩 저장소는 거부). 폴더 자체는 내용이 아니므로 빈 폴더는 설명된 것으로 본다.
function accounted(s, entries, links) {
  const caseless = run(s.worktree, ['config', '--bool', 'core.ignorecase']).out.trim() === 'true';
  const key = (p) => (caseless ? p.toLowerCase() : p);
  const modes = new Map(git(s.worktree, ['ls-files', '-s', '-z']).split('\0').filter(Boolean)
    .map((line) => [key(line.slice(line.indexOf('\t') + 1)), line.slice(0, line.indexOf(' '))]));
  const verified = new Set([...links].map(key));
  const listed = new Set(), dirs = [];
  // 대소문자를 구분하는 폴더에서는 core.ignorecase=true여도 이름이 대소문자만 다른 항목이 따로 있을 수 있다. Git은 둘을 같은 index 경로로 보아
  // 미추적 쪽을 보고하지 않으므로, 같은 키에 두 번째 항목이 오면 설명되지 않은 것으로 본다.
  const seen = new Map();
  for (const e of entries) if (e.path.endsWith('/')) dirs.push(key(e.path)); else listed.add(key(e.path));
  const odd = [];
  const walk = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (Date.now() > s.deadline) fail(overdue(s));
      const p = `${rel}${d.name}`, k = key(p);
      if (caseless) { const first = seen.get(k); if (first !== undefined && first !== p) odd.push(`대소문자만 다른 이름 ${p}(${first}와 같은 index 경로)`); else seen.set(k, p); }
      // 종류를 알려 주지 않는 파일 시스템은 lstat으로 다시 본다(링크를 따라가지 않는다).
      const t = d.isFile() || d.isDirectory() || d.isSymbolicLink() ? d : fs.lstatSync(path.join(abs, d.name));
      if (d.name.toLowerCase() === '.git') { if (p !== '.git' || !t.isFile()) odd.push(`.git 이름 항목 ${p}`); }
      else if (t.isSymbolicLink()) {
        if (modes.get(k) !== '120000') odd.push(`링크·junction ${p}`);
        else if (listed.has(k) || !verified.has(k)) odd.push(`링크·junction ${p}(index의 추적 링크와 다름)`);
      }
      else if (t.isDirectory()) walk(path.join(abs, d.name), `${p}/`);
      else if (!t.isFile()) odd.push(`일반 파일이 아닌 항목 ${p}`);
      else if (!modes.has(k) && !listed.has(k) && !dirs.some((dir) => k.startsWith(dir))) odd.push(`설명되지 않는 파일 ${p}`);
    }
  };
  walk(s.worktree, '');
  if (odd.length) fail(`status에 나오지 않거나 지우면 worktree 밖까지 닿는 항목이 있다: ${odd.slice(0, 20).join(', ')}`
    + `${odd.length > 20 ? ` 외 ${odd.length - 20}건` : ''}. 내용을 확인해 옮기거나 링크를 푼 뒤 재시도한다.`);
}

// Git(checkout)이나 정리가 경로를 지우거나 덮어쓰기 직전에, 그 경로와 worktree 안 상위 구성요소를 링크를 따라가지 않고(lstat) 확인한다.
// Git for Windows는 junction을 폴더로 따라가 안을 지운 뒤 경로를 쓰므로, 삭제를 Git에 맡기는 경로에 링크·junction을 남기지 않는다.
// 대상이 폴더면 안이 모두 지워도 되는(removable) 일반 파일일 때만, 상위 구성요소가 파일이면 그 파일이 지워도 되는 것일 때만 허용한다.
function plain(s, paths, removable) {
  const odd = [];
  const inner = (abs, rel) => {
    for (const name of fs.readdirSync(abs)) {
      const p = `${rel}/${name}`, st = fs.lstatSync(path.join(abs, name));
      if (st.isSymbolicLink()) odd.push(`링크·junction ${p}`);
      else if (st.isDirectory()) inner(path.join(abs, name), p);
      else if (!st.isFile() || !removable.has(p)) odd.push(`예상 밖 항목 ${p}`);
    }
  };
  for (const p of paths) {
    const parts = p.split('/');
    let abs = s.worktree;
    for (let i = 0; i < parts.length; i++) {
      const rel = parts.slice(0, i + 1).join('/'), last = i === parts.length - 1;
      abs = path.join(abs, parts[i]);
      let st;
      try { st = fs.lstatSync(abs); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
      if (st.isSymbolicLink()) { odd.push(`링크·junction ${rel}`); break; }
      if (st.isDirectory()) { if (last) inner(abs, rel); continue; }
      if (!st.isFile() || (!last && !removable.has(rel))) odd.push(`예상 밖 항목 ${rel}`);
      break;
    }
  }
  const shown = [...new Set(odd)];
  if (shown.length) fail(`Git이 지우거나 덮어쓸 경로에 링크·junction이나 예상 밖 항목이 있다: ${shown.slice(0, 20).join(', ')}`
    + `${shown.length > 20 ? ` 외 ${shown.length - 20}건` : ''}. 내용을 확인해 옮기거나 링크를 푼 뒤 재시도한다.`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; fail(`정리 기록을 읽지 못했다(${file}): ${e.message}`); }
}
function writeAtomic(file, bytes) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
// 상태 폴더의 업무 폴더. 경로 중간의 링크·junction을 따라가지 않는다.
function taskDir(stateDir, id) {
  let at = fs.realpathSync.native(stateDir);
  for (const part of ['tasks', id]) {
    at = path.join(at, part);
    try { if (!fs.lstatSync(at).isDirectory()) fail(`상태 폴더 경로가 일반 폴더가 아니다(링크 포함): ${at}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; fs.mkdirSync(at); }
  }
  return at;
}

function relative(p, label) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || /[\\\0]/.test(p)
    || p.replace(/\/$/, '').split('/').some((s) => !s || s === '.' || s === '..')) fail(`${label}는 저장소 상대 경로여야 한다: ${p}`);
  return p;
}

function validate(input) {
  if (!input || typeof input !== 'object') fail('정리 입력이 없다.');
  if (!safe.test(input.id ?? '') || /^\.+$/.test(input.id)) fail('업무 ID가 올바르지 않다.');
  if (input.state !== 'DONE') fail('DONE 업무만 정리한다.');
  for (const key of ['root', 'worktreeDir', 'worktree', 'stateDir']) if (!path.isAbsolute(input[key] ?? '')) fail(`${key}는 절대 경로여야 한다.`);
  const { kind, branch } = input;
  if (typeof branch !== 'string' || !branch || branch === 'main' || run(input.root, ['check-ref-format', '--branch', branch]).code !== 0)
    fail('업무 브랜치 이름이 올바르지 않다.');
  let tips = [];
  if (kind === 'merged') {
    const p = input.proof ?? {};
    if (!oid.test(p.head ?? '') || (p.original != null && !oid.test(p.original))) fail('병합 증명의 PR head가 올바르지 않다.');
    if (typeof p.branch !== 'string' || !p.branch) fail('병합 증명에 PR 브랜치 이름이 없다. 브랜치 이름을 기록하는 release로 병합을 다시 증명한다.');
    tips = [...new Set([p.head, p.original].filter(Boolean))];
  } else if (kind === 'closed') {
    const c = input.candidate ?? {};
    if (!oid.test(c.head ?? '') || !oid.test(c.tree ?? '') || !Array.isArray(c.paths)) fail('예외 종결 업무의 QA 후보가 올바르지 않다.');
  } else fail('병합 증명(merged)이나 정책 예외 종결(closed) 업무만 정리한다.');
  const name = path.basename(input.worktree);
  if (!safe.test(name) || /^\.+$/.test(name)) fail('worktree 폴더 이름이 올바르지 않다.');
  const dir = real(input.worktreeDir);
  if (real(path.dirname(input.worktree)) !== dir) fail(`worktree가 등록된 worktree_dir 바로 아래가 아니다: ${input.worktree}`);
  const ignored = input.ignored ?? {};
  const keep = (ignored.keep ?? []).map((p) => relative(p, 'ignored.keep')), discard = (ignored.discard ?? []).map((p) => relative(p, 'ignored.discard'));
  // 정리 시작부터 추적 파일 내용 확인(사전검사·제거 직전)을 끝내야 하는 시간. 기본값은 watch-delivery 한 회(180초) 안에 들어간다.
  const limit = input.limits?.contentMs ?? CONTENT_MS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3600000) fail('limits.contentMs는 1~3600000 사이의 정수 ms여야 한다.');
  return { ...input, tips, keep, discard, limit, real: path.join(dir, norm(name)), dir: taskDir(input.stateDir, input.id) };
}

// 회차가 실행 중이거나 그 회차의 위임 터미널이 살아 있으면 정리하지 않는다. 조회 실패·정체성 불명도 거부다.
function idle(activity) {
  if (!activity || typeof activity !== 'object' || !Array.isArray(activity.runs)) fail('실행·위임 터미널 조회 결과가 없다.');
  if (activity.current) fail('실행 중인 회차가 있다.');
  for (const r of activity.runs) {
    if (r.status === 'running') fail(`실행 중인 회차가 있다: ${r.token}`);
    if (!['live', 'finished', 'absent'].includes(r.state)) fail(`위임 터미널 상태를 확인하지 못했다: ${r.address} (${r.error ?? r.state})`);
    if (r.state === 'live' && (r.run === r.token || r.run == null)) fail(`살아 있는 위임 터미널이 있다: ${r.address}. 종료를 확인한 뒤 재시도한다.`);
  }
}

// Windows에서 다른 프로세스가 cwd 등으로 쓰는 폴더는 같은 이름으로 바꾸기가 EPERM이다. 다른 OS는 아무것도 바꾸지 않고 성공한다.
function unused(dir) {
  try { fs.renameSync(dir, dir); } catch (e) { fail(`다른 프로세스가 worktree를 사용 중이다(${e.code}). 해당 터미널·편집기를 닫고 재시도한다.`); }
}

// 무시된 보존 대상의 일반 파일. 링크·특수 파일이 있으면 거부한다.
function keptFiles(worktree, entry) {
  const found = [];
  const walk = (rel) => {
    const abs = path.join(worktree, ...rel.replace(/\/$/, '').split('/'));
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) for (const name of fs.readdirSync(abs).sort()) walk(`${rel.replace(/\/$/, '')}/${name}`);
    else if (st.isFile()) found.push(rel);
    else fail(`보존 대상에 일반 파일이 아닌 항목이 있다: ${rel}`);
  };
  walk(entry);
  return found;
}

// 현재 worktree 항목을 보존 대상별로 나눈다. 대상 밖의 변경·미추적·무시 파일이 하나라도 있으면 거부한다.
function classify(s, entries, folders, allowed) {
  const keep = [], artifact = [], changed = [], unexpected = [];
  for (const e of entries) {
    if (e.x === '!') {
      if (covered(e.path, s.keep)) keep.push(e.path);
      else if (!covered(e.path, s.discard)) unexpected.push(`무시됨 ${e.path}`);
    } else if (/U/.test(e.x + e.y) || (e.x === 'A' && e.y === 'A') || (e.x === 'D' && e.y === 'D')) unexpected.push(`충돌 ${e.path}`);
    else if (e.x === '?' && covered(e.path, folders)) artifact.push(e.path);
    else if (allowed.has(e.path)) {
      if (e.x !== '?' && e.x !== ' ' && e.y !== ' ') unexpected.push(`patch에 담을 수 없는 staged 중간 내용 ${e.path}`);
      else changed.push(e.path);
    } else unexpected.push(`${e.x === '?' ? '미추적' : '변경'} ${e.path}`);
  }
  if (unexpected.length) fail(`보존 대상 밖의 항목이 있다: ${unexpected.slice(0, 20).join(', ')}${unexpected.length > 20 ? ` 외 ${unexpected.length - 20}건` : ''}`);
  return { keep, artifact, changed };
}

// 후보 경로만 담은 tree. 실제 index는 건드리지 않는다.
function stagedTree(worktree, head, paths, index) {
  const env = literal({ GIT_INDEX_FILE: index });
  git(worktree, ['read-tree', head], { env });
  if (paths.length) git(worktree, ['add', '-A', '--', ...paths], { env });
  return git(worktree, ['write-tree'], { env }).trim();
}
const changedPaths = (cwd, a, b) => git(cwd, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', a, b]).split('\0').filter(Boolean);

// HEAD에서 후보 tree까지의 binary patch. 별도 index에 적용한 tree가 같아야 보존으로 인정한다.
function makePatch(s, head, paths) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cleanup-'));
  try {
    const tree = stagedTree(s.worktree, head, paths, path.join(scratch, 'candidate'));
    const file = path.join(scratch, 'candidate.patch');
    const fd = fs.openSync(file, 'wx');
    try { git(s.worktree, ['diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', head, tree], { out: fd }); }
    finally { fs.closeSync(fd); }
    const bytes = fs.readFileSync(file);
    const env = literal({ GIT_INDEX_FILE: path.join(scratch, 'restore') });
    git(s.worktree, ['read-tree', head], { env });
    git(s.worktree, ['apply', '--cached', '--binary', file], { env });
    if (git(s.worktree, ['write-tree'], { env }).trim() !== tree) fail('patch를 기준 HEAD에 적용한 tree가 후보와 다르다.');
    const listed = changedPaths(s.worktree, head, tree);
    if (listed.length !== paths.length || listed.some((p) => !paths.includes(p))) fail('patch 경로가 보존할 후보 경로와 다르다.');
    return { head, tree, bytes, paths: listed };
  } finally { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

// 같은 이름의 patch는 덮어쓰지 않는다. 내용이 같으면 재사용하고 다르면 거부한다.
function storePatch(s, made) {
  const sha256 = digest(made.bytes), name = `worktree-${made.tree.slice(0, 12)}.patch`, file = path.join(s.dir, name);
  if (lexists(file)) {
    if (!fs.lstatSync(file).isFile() || digest(fs.readFileSync(file)) !== sha256) fail(`같은 이름의 다른 patch가 있다: ${file}`);
  } else writeAtomic(file, made.bytes);
  return { file: `tasks/${s.id}/${name}`, sha256, head: made.head, tree: made.tree, paths: made.paths };
}
function loadPatch(s, recorded) {
  const file = path.join(s.stateDir, ...recorded.file.split('/'));
  if (!lexists(file) || !fs.lstatSync(file).isFile() || digest(fs.readFileSync(file)) !== recorded.sha256) fail(`보존한 patch가 없거나 지문이 다르다: ${recorded.file}`);
  if (run(s.worktree, ['cat-file', '-e', `${recorded.tree}^{tree}`]).code !== 0) fail('보존한 후보 tree 객체를 찾을 수 없다.');
  return recorded;
}

// 현재 변경이 모두 patch 안의 같은 내용인지 확인한다. 이전 실행이 일부를 되돌렸어도 남은 변경은 patch와 같아야 한다.
function samePatch(s, head, patch, paths) {
  if (head !== patch.head) fail('worktree HEAD가 patch 기준과 다르다.');
  const outside = paths.filter((p) => !patch.paths.includes(p));
  if (outside.length) fail(`patch에 없는 변경이 있다: ${outside.join(', ')}`);
  if (!paths.length) return;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cleanup-'));
  try {
    const now = stagedTree(s.worktree, head, paths, path.join(scratch, 'now'));
    const differ = git(s.worktree, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', now, patch.tree, '--', ...paths], { env: literal() }).split('\0').filter(Boolean);
    if (differ.length) fail(`patch와 다른 변경이 있다: ${differ.join(', ')}`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

// 보존을 확인한 후보 경로만 HEAD 상태로 되돌린다. 새 파일은 patch tree의 blob과 같을 때만 지운다.
function revert(s, patch) {
  const env = literal();
  const tracked = new Set(git(s.worktree, ['ls-tree', '-r', '-z', '--name-only', patch.head, '--', ...patch.paths], { env }).split('\0').filter(Boolean));
  const old = patch.paths.filter((p) => tracked.has(p)), added = patch.paths.filter((p) => !tracked.has(p));
  plain(s, patch.paths, new Set(patch.paths));
  if (old.length) git(s.worktree, ['checkout', patch.head, '--', ...old], { env });
  if (!added.length) return;
  // pathspec은 폴더 아래 경로도 고르므로, index에 그 이름 그대로 있는 새 파일만 index에서 뺀다(추적 폴더를 파일로 바꾼 후보).
  const indexed = new Set(git(s.worktree, ['ls-files', '-z', '--', ...added], { env }).split('\0').filter(Boolean));
  const staged = added.filter((p) => indexed.has(p));
  if (staged.length) git(s.worktree, ['rm', '--cached', '-q', '--', ...staged], { env });
  const blobs = new Map(git(s.worktree, ['ls-tree', '-r', '-z', patch.tree, '--', ...added], { env }).split('\0').filter(Boolean)
    .map((line) => { const tab = line.indexOf('\t'); return [line.slice(tab + 1), line.slice(0, tab).split(' ')[2]]; }));
  for (const p of added) {
    const abs = path.join(s.worktree, ...p.split('/'));
    if (!lexists(abs)) continue;
    // checkout이 HEAD의 폴더를 되살린 경로는 새 파일이 이미 그 단계에서 지워졌다.
    if (fs.lstatSync(abs).isDirectory() && old.some((o) => o.startsWith(`${p}/`))) continue;
    if (!inside(s.real, real(abs)) || !fs.lstatSync(abs).isFile()) fail(`후보 새 파일이 worktree 안의 일반 파일이 아니다: ${p}`);
    if (git(s.worktree, ['hash-object', '--', p], { env }).trim() !== blobs.get(p)) fail(`후보 새 파일이 보존한 내용과 다르다: ${p}`);
    fs.unlinkSync(abs);
  }
}

// 보관본·manifest와 같은 지문을 확인한 과정 문서 파일만 지운다.
function proven(s, preserved, names) {
  for (const name of names) {
    const recorded = preserved.files[name];
    const abs = path.join(s.worktree, ...name.split('/')), kept = path.join(preserved.dir, ...name.split('/'));
    if (!recorded || !fs.lstatSync(abs).isFile() || !inside(s.real, real(abs)) || digest(fs.readFileSync(abs)) !== recorded
      || !fs.lstatSync(kept).isFile() || digest(fs.readFileSync(kept)) !== recorded) fail(`보존 확인 실패: ${name}`);
  }
}

// 등록 해제 뒤 남은 빈 폴더 골격. 파일·링크가 하나라도 있으면 지우지 않고 목록을 돌려준다.
function skeleton(dir) {
  const dirs = [], files = [];
  const walk = (d) => {
    dirs.push(d);
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p); else files.push(p);
    }
  };
  if (!fs.lstatSync(dir).isDirectory()) fail(`worktree 경로가 폴더가 아니다(링크 포함): ${dir}`);
  walk(dir);
  if (files.length) fail(`등록이 해제된 worktree 폴더에 파일이 남았다: ${files.slice(0, 20).join(', ')}. 내용을 확인한 뒤 정리한다.`);
  for (const d of dirs.reverse()) fs.rmdirSync(d);
}

function removeWorktree(s) {
  const r = run(s.root, ['worktree', 'remove', s.worktree]);
  const registered = worktrees(s.root).some((e) => e.real === s.real), left = lexists(s.worktree);
  if (registered || left) fail(`worktree 제거를 확인하지 못했다(git 종료 ${r.code}${r.err ? `: ${r.err}` : ''}; 등록 ${registered ? '남음' : '없음'}, 폴더 ${left ? '남음' : '없음'}). 강제 삭제는 하지 않는다.`);
}

// 병합 증명된 업무 브랜치만 지운다. 먼저 -d를 시도하고, 거부되면 tip·이름·사용처·worktree 제거를 다시 확인한 뒤에만 -D를 쓴다.
function removeBranch(s, journal) {
  const ref = `refs/heads/${s.branch}`;
  const tip = revParse(s.root, ref);
  if (!tip) return journal.branch?.state === 'deleted' ? journal.branch : { name: s.branch, state: 'absent' };
  if (journal.branch?.state === 'deleted') fail(`삭제한 업무 브랜치가 다시 생겼다: ${s.branch}`);
  const blocker = () => {
    const now = revParse(s.root, ref), list = worktrees(s.root);
    if (now !== tip || !s.tips.includes(now)) return `업무 브랜치 tip ${now}이 병합 증명의 head와 다르다.`;
    if (s.proof.branch !== s.branch) return `업무 브랜치 이름이 병합 증명의 PR 브랜치(${s.proof.branch})와 다르다.`;
    const user = list.find((e) => e.branch === ref);
    if (user) return `업무 브랜치를 다른 checkout이 사용 중이다: ${user.path}`;
    if (list.some((e) => e.real === s.real) || lexists(s.worktree)) return 'worktree 제거가 끝나지 않았다.';
    return null;
  };
  const before = blocker();
  if (before) fail(before);
  const soft = run(s.root, ['branch', '-d', '--', s.branch]);
  let method = '-d';
  if (soft.code !== 0) {
    const again = blocker();
    if (again) fail(`git branch -d 거부(${soft.err}) 뒤 -D 조건 미충족: ${again}`);
    git(s.root, ['branch', '-D', '--', s.branch]);
    method = '-D';
  }
  if (revParse(s.root, ref)) fail(`업무 브랜치 삭제를 확인하지 못했다: ${s.branch}`);
  return { name: s.branch, state: 'deleted', tip, method, ...(method === '-D' ? { refused: soft.err } : {}), at: s.at };
}

function cleanup(input) {
  const started = Date.now(), at = input?.at ?? new Date().toISOString();
  const report = { version: VERSION, id: input?.id ?? null, kind: input?.kind ?? null, status: 'refused',
    worktree: { path: input?.worktree ?? null, removed: false }, branch: { name: input?.branch ?? null, state: 'kept' },
    preserved: null, patch: null, reasons: [], remaining: [], retry: input?.retry ?? null, journal: null };
  let journal = null, acted = false, s;
  try {
    s = { ...validate(input), at };
    s.deadline = started + s.limit;
    const journalFile = path.join(s.dir, 'cleanup.json');
    report.journal = `tasks/${s.id}/cleanup.json`;
    journal = readJson(journalFile);
    if (journal && (journal.version !== VERSION || journal.worktree !== s.real || journal.branch !== s.branch || journal.kind !== s.kind))
      fail(`같은 업무의 다른 정리 기록이 있다: ${report.journal}`);
    const save = (next) => { journal = next; writeAtomic(journalFile, `${JSON.stringify(journal, null, 2)}\n`); };
    if (inside(s.real, real(process.cwd())) || real(process.cwd()) === s.real) fail('정리할 worktree 안에서 실행했다. 원본 checkout에서 실행한다.');
    idle(input.activity);
    const list = worktrees(s.root), entry = list.find((e) => e.real === s.real), present = lexists(s.worktree);
    if (list[0].real === s.real || inside(s.real, list[0].real)) fail('원본 checkout은 정리하지 않는다.');
    if (entry && present) {
      if (journal?.removed) fail('정리한 경로에 새 worktree가 등록돼 있다. 다른 업무의 checkout인지 확인한다.');
      if (!fs.lstatSync(s.worktree).isDirectory()) fail('worktree 경로가 일반 폴더가 아니다(링크 포함).');
      if (entry.locked) fail(`잠긴 worktree다: ${entry.locked === true ? '' : entry.locked}`.trim());
      if (entry.prunable || entry.bare || entry.detached) fail('업무 브랜치를 checkout한 정상 worktree가 아니다.');
      const ref = `refs/heads/${s.branch}`;
      if (entry.branch !== ref) fail(`worktree의 브랜치(${entry.branch})가 업무 브랜치가 아니다.`);
      const nested = list.find((e) => e !== entry && inside(s.real, e.real));
      if (nested) fail(`worktree 안에 다른 등록 worktree가 있다: ${nested.path}`);
      const other = list.find((e) => e !== entry && e.branch === ref);
      if (other) fail(`업무 브랜치를 다른 checkout이 사용 중이다: ${other.path}`);
      if (real(git(s.worktree, ['rev-parse', '--show-toplevel']).trim()) !== s.real
        || real(git(s.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) !== real(git(s.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()))
        fail('worktree가 같은 저장소의 등록 checkout이 아니다.');
      if (git(s.worktree, ['ls-files', '--unmerged'])) fail('충돌이 남은 worktree다.');
      hiddenIndex(s.worktree);
      ownState(s.worktree);
      const head = git(s.worktree, ['rev-parse', 'HEAD']).trim();
      if (s.kind === 'merged') {
        if (s.proof.branch !== s.branch) fail(`업무 브랜치 이름이 병합 증명의 PR 브랜치(${s.proof.branch})와 다르다.`);
        if (!s.tips.includes(head)) fail(`업무 브랜치 tip ${head}이 병합 증명의 head와 다르다.`);
      }
      unused(s.worktree);
      const folders = artifacts.configure(input.artifacts?.config ?? {}).declared ? artifacts.resolve(input.artifacts.config, { ...input.artifacts.vars, id: s.id }) : [];
      const entries = status(s.worktree);
      const allowed = new Set(s.kind === 'closed' ? (journal?.patch?.paths ?? s.candidate.paths.map((p) => p.path)) : []);
      const parts = classify(s, entries, folders, allowed);
      accounted(s, entries, sameContent(s, entries));
      const keepFiles = parts.keep.flatMap((p) => keptFiles(s.worktree, p));
      const kept = artifacts.preserve(input.artifacts?.config ?? {}, { id: s.id, worktree: s.worktree, stateDir: s.stateDir, vars: input.artifacts?.vars, files: keepFiles, at });
      proven(s, kept, [...keepFiles, ...parts.artifact]);
      const preserved = { declared: kept.declared, ...(kept.declared ? {} : { skipped: '과정 문서 선언 없음' }),
        dir: path.relative(s.stateDir, kept.dir).split(path.sep).join('/'), files: kept.files };
      let patch = null;
      if (s.kind === 'closed') {
        if (journal?.patch !== undefined) {
          patch = journal.patch && loadPatch(s, journal.patch);
          if (patch) samePatch(s, head, patch, parts.changed);
          else if (parts.changed.length) fail('기록된 정리에는 보존한 patch가 없는데 변경이 있다.');
        } else {
          if (head !== s.candidate.head || candidateTree(s.worktree) !== s.candidate.tree) fail('worktree가 QA 후보와 다르다.');
          patch = parts.changed.length ? storePatch(s, makePatch(s, head, parts.changed)) : null;
        }
      }
      // 재시도는 이전 기록의 지문 위에 이번에 다시 보관한 파일의 지문을 덮는다. 첫 실행에서 지운 과정 문서의 지문은 남고,
      // 그 사이 바뀐 보존 파일은 보관본·manifest와 같은 새 지문이 된다.
      const record = journal?.preserved ? { ...preserved, files: Object.fromEntries(Object.entries({ ...journal.preserved.files, ...preserved.files })
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) } : preserved;
      // 되돌릴 후보 경로와 지울 과정 문서에 링크·junction이 있으면 의도 기록 전에 멈춘다(되돌리기 직전에 다시 본다).
      if (patch) plain(s, patch.paths, new Set(patch.paths));
      plain(s, parts.artifact, new Set(parts.artifact));
      // 첫 되돌리기·삭제 전에 경로·브랜치·예상 tip·보관·patch를 디스크에 남긴다.
      save({ version: VERSION, id: s.id, kind: s.kind, worktree: s.real, branch: s.branch, tips: s.tips,
        preserved: record, patch, intent: journal?.intent ?? at, removed: null, branchResult: null });
      acted = true;
      if (patch) revert(s, patch);
      for (const name of parts.artifact) fs.unlinkSync(path.join(s.worktree, ...name.split('/')));
      hiddenIndex(s.worktree);
      ownState(s.worktree);
      const last = status(s.worktree);
      classify(s, last, [], new Set());
      accounted(s, last, sameContent(s, last));
      // Git이 지울 worktree 폴더 자체가 링크·junction이 아니고 처음 확인한 실제 경로 그대로인지 본다(안은 바로 위 순회가 확인했다).
      if (!fs.lstatSync(s.worktree).isDirectory() || real(s.worktree) !== s.real) fail('worktree 경로가 일반 폴더가 아니거나 실제 경로가 바뀌었다(링크 포함).');
      unused(s.worktree);
      removeWorktree(s);
    } else if (entry) {
      if (!journal?.intent) fail('등록된 worktree의 폴더가 없다. 정리 의도 기록이 없어 등록을 해제하지 않는다.');
      acted = true;
      removeWorktree(s);
    } else if (present) {
      if (!journal?.intent) fail('등록되지 않은 폴더가 업무 worktree 경로에 있다. 정리 의도 기록이 없어 지우지 않는다.');
      acted = true;
      skeleton(s.worktree);
    }
    // 이미 없던 worktree도 기록해 두면 브랜치 삭제 뒤 재실행이 같은 결과를 돌려준다.
    if (!journal) save({ version: VERSION, id: s.id, kind: s.kind, worktree: s.real, branch: s.branch, tips: s.tips,
      preserved: null, patch: null, intent: at, removed: at, branchResult: null });
    else if (!journal.removed) save({ ...journal, removed: at });
    report.worktree.removed = true;
    if (s.kind === 'closed') report.branch = { name: s.branch, state: 'kept', reason: '정책 예외 종결 업무의 브랜치는 보존한다.' };
    else {
      acted = true;
      const result = removeBranch(s, { branch: journal.branchResult });
      report.branch = result;
      if (JSON.stringify(journal.branchResult) !== JSON.stringify(result)) save({ ...journal, branchResult: result });
    }
    report.status = 'done';
  } catch (e) {
    report.reasons.push(e.message);
    report.status = acted ? 'partial' : 'refused';
  }
  if (journal) {
    report.preserved = journal.preserved ?? null;
    report.patch = journal.patch ?? null;
  }
  if (report.status === 'done') report.retry = null;
  else try {
    // 입력 검사에서 멈춰도 호출자가 넘긴 경로·브랜치가 남아 있는지 알린다.
    const { worktree, root, branch, kind } = s ?? input ?? {};
    if (path.isAbsolute(worktree ?? '') && lexists(worktree)) report.remaining.push(worktree);
    if (kind === 'merged' && path.isAbsolute(root ?? '') && typeof branch === 'string' && branch && revParse(root, `refs/heads/${branch}`))
      report.remaining.push(`refs/heads/${branch}`);
  } catch (e) { report.reasons.push(`남은 자원 조회 실패: ${e.message}`); }
  return report;
}

module.exports = { cleanup, version: VERSION };
