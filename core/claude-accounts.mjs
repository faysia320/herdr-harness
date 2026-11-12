// Claude 로그인 계정 전환. 계정마다 설정 폴더(CLAUDE_CONFIG_DIR)를 두고, 사용자 환경변수로 새 실행의 계정을 고른다.
// herdr-core는 실행할 때마다 사용자 환경을 새로 읽으므로 Lead·에이전트의 실행 명령은 바꾸지 않는다.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const BASE = join(homedir(), '.claude');
export const STORE = join(homedir(), '.config', 'herdr-harness', 'claude-accounts.json');
// 계정과 무관하게 같이 써야 하는 폴더. 대화 기록(projects)을 공유해야 다른 계정에서 --resume으로 이어 갈 수 있다.
export const SHARED_DIRS = ['projects', 'skills', 'plugins', 'hooks', 'file-history', 'transcripts', 'tasks', 'teams', 'dev-mods', 'plans', 'todos'];
// 계정 정보·계정별 캐시는 새 계정 폴더로 옮기지 않는다.
const ACCOUNT_KEYS = /^(oauthAccount|userID)$|[Cc]ache|^cached/;
// 한도 도달 화면 문구. 실제 문구가 바뀌면 여기만 고친다.
export const LIMIT_PATTERN = /usage limit (?:reached|hit)|you['’]ve (?:hit|reached) your (?:\w+ )?limit|(?:weekly|5-hour|session) limit (?:reached|hit)|limit will reset|resets? (?:at )?\d{1,2}(?::\d\d)?\s*(?:am|pm)/i;

const fail = (m) => { throw new Error(m); };
const json = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const atomic = (file, text) => { writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); };
const norm = (p) => (p ? resolve(p).replaceAll('\\', '/').toLowerCase() : null);

export function loadStore() {
  const s = json(STORE, null) ?? { version: 1, accounts: { a: { label: '기본', dir: null } } };
  if (s.version !== 1 || !s.accounts?.a) fail(`계정 설정 형식이 올바르지 않다: ${STORE}`);
  return s;
}
const saveStore = (s) => { mkdirSync(join(STORE, '..'), { recursive: true }); atomic(STORE, `${JSON.stringify(s, null, 2)}\n`); };
const dirOf = (a) => a.dir ?? BASE;

// 사용자 환경변수(HKCU\Environment)를 읽고 쓴다. 이 프로세스의 env는 실행 당시 값이라 쓰지 않는다.
function userEnv(value) {
  const set = value === undefined ? '' : `[Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', ${value === null ? '$null' : `'${value.replaceAll("'", "''")}'`}, 'User');`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${set}[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR','User')`], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) fail(`사용자 환경변수를 다루지 못했다: ${r.stderr.trim()}`);
  return r.stdout.trim() || null;
}

export function status() {
  const s = loadStore(), current = norm(userEnv());
  const accounts = Object.entries(s.accounts).map(([key, a]) => {
    const dir = dirOf(a), info = json(join(a.dir ? dir : homedir(), '.claude.json'), {}).oauthAccount ?? {};
    return { key, label: a.label, dir, active: norm(a.dir) === current, loggedIn: existsSync(join(dir, '.credentials.json')), email: info.emailAddress ?? null, plan: info.planDisplayName ?? null };
  });
  if (!accounts.some((a) => a.active)) accounts.find((a) => a.key === 'a').active = current === null;
  return { store: STORE, unknownDir: accounts.some((a) => a.active) ? null : current, accounts };
}

// 새 계정 폴더: 공유 폴더는 junction, 설정은 복사, .claude.json은 계정 정보를 뺀 사본. 로그인 파일은 만들지 않는다.
export function setup(key, dir, label) {
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(key ?? '') || key === 'a') fail('계정 키는 소문자 영문으로 시작하는 짧은 이름이어야 하고 a는 기본 계정이다.');
  dir = resolve(dir ?? join(homedir(), `.claude-${key}`));
  if (norm(dir) === norm(BASE)) fail('기본 설정 폴더를 다른 계정으로 쓸 수 없다.');
  mkdirSync(dir, { recursive: true });
  const linked = [];
  for (const name of SHARED_DIRS) {
    const from = join(BASE, name), to = join(dir, name);
    if (!existsSync(from) || existsSync(to)) continue;
    const r = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', to, from], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) fail(`${name} 공유 연결 실패: ${(r.stdout + r.stderr).trim()}`);
    linked.push(name);
  }
  syncSettings(dir);
  const target = join(dir, '.claude.json');
  if (!existsSync(target)) {
    const base = json(join(homedir(), '.claude.json'), {});
    atomic(target, `${JSON.stringify(Object.fromEntries(Object.entries(base).filter(([k]) => !ACCOUNT_KEYS.test(k))), null, 2)}\n`);
  }
  const s = loadStore();
  s.accounts[key] = { label: label ?? key.toUpperCase(), dir };
  saveStore(s);
  return { key, dir, linked, loggedIn: existsSync(join(dir, '.credentials.json')) };
}

// 기본 계정의 settings.json을 다른 계정 폴더에 맞춘다(한 방향). 계정마다 설정이 갈라지지 않게 한다.
export function syncSettings(dir) {
  const from = join(BASE, 'settings.json'), to = join(dir, 'settings.json');
  if (existsSync(from) && (!existsSync(to) || !readFileSync(to).equals(readFileSync(from)))) copyFileSync(from, to);
}

export function use(key) {
  const s = loadStore(), a = s.accounts[key] ?? fail(`등록되지 않은 계정이다: ${key}`);
  if (a.dir) {
    if (!existsSync(join(a.dir, '.credentials.json'))) fail(`${key} 계정은 아직 로그인하지 않았다. 먼저 그 계정 폴더로 claude를 띄워 /login 한다.`);
    syncSettings(a.dir);
  }
  userEnv(a.dir ?? null);
  return status();
}

// 호출한 쪽이 hc 터미널이면 hc send가 글을 <hc from=…> 메시지로 감싼다. 셸 명령·슬래시 명령은 그대로 입력돼야 하므로 터미널 맥락을 지운다.
const HC_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^HC_(TERMINAL_ID|TERMINAL_SOCKET|SCOPE)$/.test(k)));
const hc = (args) => {
  const r = spawnSync('hc', args, { encoding: 'utf8', windowsHide: true, env: HC_ENV });
  if (r.status !== 0) fail(`hc ${args[0]} 실패: ${(r.stderr || r.stdout).trim()}`);
  try { return JSON.parse(r.stdout); } catch { return r.stdout; }
};

// 한도로 멈춘 Claude 터미널을 같은 이름·위치·라벨로 다시 띄워 같은 대화를 현재 계정으로 이어 간다.
export function resumeTerminal(address, note) {
  const t = hc(['get', address]);
  if (t.state !== 'live') fail(`${address}는 살아 있는 터미널이 아니다.`);
  if (!t.name) fail(`${address}에 이름이 없어 같은 대화를 찾을 수 없다.`);
  if (!/claude/i.test(`${t.argv?.[0] ?? ''} ${t.title ?? ''} ${t.status?.app ?? ''}`)) fail(`${address}는 Claude 터미널이 아니다.`);
  const keep = [];
  for (let i = 1; i < (t.argv ?? []).length; i++) {
    const a = t.argv[i];
    if (a === '--') break;
    if (['--model', '--effort', '--permission-mode', '--settings', '--add-dir'].includes(a)) { keep.push(a, t.argv[++i]); }
  }
  hc(['kill', address]); hc(['rm', address]);
  const labels = Object.entries(t.labels ?? {}).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  const parent = t.parent ? ['--parent', t.parent] : ['--no-parent'];
  const prompt = note ?? '계정 사용 한도로 멈춘 작업을 다른 계정에서 이어 간다. 멈추기 전에 하던 일을 그대로 이어서 끝내고, 원래 지시서대로 산출물과 receipt를 남겨라.';
  return hc(['run', '--bg', '--json', '--name', t.name, '--cwd', t.cwd, ...labels, ...parent, ...(t.die_with_parent ? [] : ['--outlive-parent']),
    'claude', ...keep, '--resume', t.name, '-n', t.name, '--', prompt]);
}

// ---- Lead 세션 교체 ----
// Lead는 Herdr 셸(pwsh) 안에서 뜬 Claude다. 셸은 그대로 두고 Claude만 끝낸 뒤, 같은 셸에서 계정을 바꿔
// `claude --resume <세션>`으로 다시 띄운다. 터미널 주소가 그대로라 하네스 대장의 Lead 기록도 바뀌지 않는다.
const HARNESS_PROJECTS = join(homedir(), '.config', 'herdr-app', 'mods', 'harness', 'projects.json');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function childClaude(pid) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)} AND Name='claude.exe'" | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8', windowsHide: true });
  return r.stdout.split(/\s+/).map(Number).find((n) => n > 0) ?? null;
}

// 실행 중인 Claude의 세션 ID와 계정: 각 계정 폴더의 sessions/<pid>.json 중 있는 쪽.
function sessionOf(claudePid) {
  for (const [key, a] of Object.entries(loadStore().accounts)) {
    const s = json(join(dirOf(a), 'sessions', `${claudePid}.json`), null);
    if (s?.sessionId) return { account: key, sessionId: s.sessionId, cwd: s.cwd };
  }
  return null;
}

const activeKey = () => {
  const current = norm(userEnv());
  return Object.entries(loadStore().accounts).find(([, a]) => norm(a.dir) === current)?.[0] ?? (current === null ? 'a' : null);
};

// 하네스에 연결된 레포마다 대장에 기록된 Lead 터미널과 그 Lead가 쓰는 계정.
export function leads() {
  const active = activeKey(), out = [];
  for (const p of json(HARNESS_PROJECTS, { projects: [] }).projects ?? []) {
    const config = json(join(p.root, '.agents', 'harness', 'config.json'), null);
    const ledger = config?.project?.state_dir && json(join(p.root, config.project.state_dir, 'ledger.json'), null);
    const address = ledger?.lead?.terminal;
    if (!address) continue;
    let t;
    try { t = hc(['get', address]); } catch { continue; }
    if (t.state !== 'live') continue;
    const pid = childClaude(t.pid), session = pid && sessionOf(pid);
    out.push({ project: p.name, address, where: t.labels?.where ?? null, status: t.status?.state ?? null,
      account: session?.account ?? null, sessionId: session?.sessionId ?? null, active, switchable: Boolean(session) && session.account !== active });
  }
  return out;
}

export function switchLead(address, { force = false } = {}) {
  const key = activeKey() ?? fail('현재 계정을 알 수 없다. 등록된 계정으로 먼저 전환한다.');
  const a = loadStore().accounts[key];
  const t = hc(['get', address]);
  if (t.state !== 'live') fail(`${address}는 살아 있는 터미널이 아니다.`);
  if (!/pwsh|powershell/i.test(`${t.argv?.[0] ?? ''} ${t.foreground?.name ?? ''}`)) fail(`${address}는 셸 안에서 뜬 Claude가 아니라 교체하지 않는다.`);
  if (t.status?.state === 'working' && !force) fail(`${address} Lead가 작업 중이다. 이번 턴이 끝난 뒤 교체한다.`);
  const pid = childClaude(t.pid) ?? fail(`${address}에서 실행 중인 Claude를 찾지 못했다.`);
  const session = sessionOf(pid) ?? fail(`${address} Claude의 세션 기록을 찾지 못했다.`);
  if (session.account === key) fail(`${address} Lead는 이미 현재 계정(${a.label})을 쓴다.`);
  hc(['send', address, '/exit']);
  for (let i = 0; i < 60 && childClaude(t.pid); i++) sleep(500);
  if (childClaude(t.pid)) fail(`${address} Claude가 30초 안에 끝나지 않았다. 화면을 확인한다.`);
  const env = a.dir ? `$env:CLAUDE_CONFIG_DIR='${a.dir.replaceAll("'", "''")}'` : 'Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue';
  const prompt = `계정 전환으로 이 Lead 세션을 ${a.label} 계정에서 이어 간다. 하던 Lead 역할과 진행 중인 업무를 그대로 계속하라.`;
  hc(['send', address, `${env}; claude --resume ${session.sessionId} '${prompt}'`]);
  let next = null;
  for (let i = 0; i < 60 && !next; i++) { sleep(500); next = childClaude(t.pid); }
  if (!next) fail(`${address}에서 새 Claude가 뜨지 않았다. 화면을 확인한다.`);
  return { address, from: session.account, to: key, sessionId: session.sessionId, pid: next };
}

// 살아 있는 Claude 터미널 중 작업 중이 아닌 것의 화면을 읽어 한도로 멈춘 것을 고른다.
export function scan() {
  const list = hc(['ls', '--json']).terminals ?? [];
  return list.filter((t) => t.state === 'live' && /claude/i.test(t.agent ?? '') && t.status !== 'working')
    .map((t) => { const r = spawnSync('hc', ['read', t.address], { encoding: 'utf8', windowsHide: true }); return { t, screen: r.status === 0 ? r.stdout : '' }; })
    .filter(({ t, screen }) => limitStopped(screen, t.status))
    .map(({ t }) => ({ address: t.address, name: t.name ?? null, where: t.where ?? null, status: t.status ?? null }));
}

// 화면 마지막 부분에 한도 문구가 있고 작업 중이 아니면 한도로 멈춘 것으로 본다.
export function limitStopped(screen, status) {
  if (status === 'working') return false;
  const tail = String(screen ?? '').split('\n').slice(-15).join('\n');
  return LIMIT_PATTERN.test(tail);
}
