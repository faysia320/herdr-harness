// 공통 Claude 설정을 유지하고 실행할 때 선택한 장기 토큰만 주입한다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tokenStore, tokenStatus, tokenUse, readToken, tokenRecord, TOKEN_LAUNCHER } from './claude-tokens.mjs';
import { migrateConversation } from './claude-conversations.mjs';
export const status = tokenStatus;
export const use = tokenUse;
const fail = (m) => { throw new Error(m); };
const json = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
export const LIMIT_PATTERN = /usage limit (?:reached|hit)|you['’]ve (?:hit|reached) your (?:\w+ )?limit|(?:weekly|5-hour|session) limit (?:reached|hit)|limit will reset|resets? (?:at )?\d{1,2}(?::\d\d)?\s*(?:am|pm)/i;

// 호출한 쪽이 hc 터미널이면 hc send가 글을 <hc from=…> 메시지로 감싼다. 셸 명령·슬래시 명령은 그대로 입력돼야 하므로 터미널 맥락을 지운다.
const HC_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^HC_(TERMINAL_ID|TERMINAL_SOCKET|SCOPE)$/.test(k)));
const hc = (args) => {
  const r = spawnSync('hc', args, { encoding: 'utf8', windowsHide: true, env: HC_ENV });
  if (r.status !== 0) fail(`hc ${args[0]} 실패: ${(r.stderr || r.stdout).trim()}`);
  let value;
  try { value = JSON.parse(r.stdout); } catch { return r.stdout; }
  if (value?.error) fail(`hc ${args[0]} 실패: ${value.error.message ?? JSON.stringify(value.error)}`);
  return value;
};

// 한도로 멈춘 Claude 터미널을 같은 이름·위치·라벨로 다시 띄워 같은 대화를 현재 계정으로 이어 간다.
export function resumeTerminal(address, note) {
  const t = hc(['get', address]);
  if (t.state !== 'live') fail(`${address}는 살아 있는 터미널이 아니다.`);
  if (!/claude/i.test(`${t.argv?.join(' ') ?? ''} ${t.title ?? ''} ${t.status?.app ?? ''}`)) fail(`${address}는 Claude 터미널이 아니다.`);
  // Herdr 탭은 이름 없는 PowerShell인 경우가 많다. 셸과 주소를 보존하고 실제 세션 ID로 재개한다.
  if (shellTerminal(t)) return switchLead(address, { note, allowSame: true });
  if (t.status?.state === 'working') fail(`${address}는 작업 중이다. 이번 턴이 끝난 뒤 다시 시도한다.`);
  if (t.status?.state === 'blocked' && t.status.kind !== 'auth') fail('인증 오류 이외의 대기 화면은 자동으로 종료하지 않습니다.');
  if (!t.name) fail(`${address}에 이름이 없어 같은 대화를 찾을 수 없다.`);
  const key = activeKey() ?? fail('현재 계정을 알 수 없다. 등록된 계정으로 먼저 전환한다.');
  readToken(key); // Validate before stopping the existing process.
  const child = childClaude(t.pid);
  const session = sessionOf(child ?? t.pid);
  if (!session) fail('기존 대화 ID를 찾지 못해 종료하지 않습니다.');
  const keep = launchOptions(child ? processArgv(child) : t.argv);
  hc(['kill', address]);
  migrateConversation(session, tokenStore().configDir);
  hc(['rm', address]);
  const labels = Object.entries(t.labels ?? {}).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  const parent = t.parent ? ['--parent', t.parent] : ['--no-parent'];
  const prompt = note ?? null;
  return hc(['run', '--bg', '--json', '--name', t.name, '--cwd', t.cwd, ...labels, ...parent, ...(t.die_with_parent ? [] : ['--outlive-parent']),
    process.execPath, TOKEN_LAUNCHER, '--account', key, '--', ...keep, '--resume', session.sessionId, '-n', t.name, ...(prompt ? ['--', prompt] : [])]);
}

// ---- Lead 세션 교체 ----
// Lead는 Herdr 셸(pwsh) 안에서 뜬 Claude다. 셸은 그대로 두고 Claude만 끝낸 뒤, 같은 셸에서 계정을 바꿔
// `claude --resume <세션>`으로 다시 띄운다. 터미널 주소가 그대로라 하네스 대장의 Lead 기록도 바뀌지 않는다.
const HARNESS_PROJECTS = join(homedir(), '.config', 'herdr-app', 'mods', 'harness', 'projects.json');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const shellTerminal = (t) => /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(t.argv?.[0] ?? '');

// Windows CRT quoting: backslashes are special only immediately before a quote.
export function splitCommandLine(line) {
  const args = [];
  let value = '', quoted = false, started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (/\s/.test(c) && !quoted) {
      if (started) args.push(value);
      value = ''; started = false; continue;
    }
    started = true;
    if (c === '\\') {
      let count = 1;
      while (line[i + 1] === '\\') { count++; i++; }
      if (line[i + 1] === '"') {
        value += '\\'.repeat(Math.floor(count / 2)); i++;
        if (count % 2) value += '"';
        else if (quoted && line[i + 1] === '"') { value += '"'; i++; }
        else quoted = !quoted;
      } else value += '\\'.repeat(count);
    } else if (c === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else value += c;
  }
  if (quoted) fail('Claude 실행 명령의 따옴표를 해석하지 못했다.');
  if (started) args.push(value);
  return args;
}

// Read the installed CLI's option arities so new flags are retained too. Never
// replay the original positional prompt or old session-selection arguments.
function launchOptions(argv) {
  if (!argv?.length) fail('Claude 실행 인자를 읽지 못했다.');
  const r = spawnSync(argv[0], ['--help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.status !== 0) fail('Claude 실행 옵션을 확인하지 못했다.');
  const specs = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s+(?:(-\w), )?(--[\w-]+)(?: ([<\[][^>\]]+[>\]]))?(?:\s|$)/);
    if (!m) continue;
    const spec = { value: Boolean(m[3]), required: m[3]?.startsWith('<'), many: m[3]?.includes('...'), name: m[2] };
    specs.set(m[2], spec);
    if (m[1]) specs.set(m[1], spec);
  }
  if (!specs.has('--resume')) fail('Claude 실행 옵션 형식을 확인하지 못했다.');
  const keep = [], replace = new Set(['--resume', '--continue', '--session-id', '--fork-session']);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (!arg.startsWith('-')) continue;
    const name = arg.split('=')[0], spec = specs.get(name);
    if (!spec) fail(`Claude 실행 옵션을 해석하지 못했다: ${name}`);
    const group = [arg];
    if (spec.value && !arg.includes('=')) {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        group.push(argv[++i]);
        if (spec.many) while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) group.push(argv[++i]);
      } else if (spec.required) fail(`Claude 실행 옵션 값이 없다: ${name}`);
    }
    if (!replace.has(spec.name)) keep.push(...group);
  }
  if (keep.includes('--bare')) fail('--bare 세션은 장기 토큰을 읽지 않아 자동 재개하지 않습니다.');
  return keep;
}

function processArgv(pid) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object -ExpandProperty CommandLine`], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout.trim()) fail('Claude 실행 명령을 읽지 못했다. 기존 세션은 유지한다.');
  const argv = splitCommandLine(r.stdout.trim());
  if (!/(?:^|[\\/])claude(?:\.exe)?$/i.test(argv[0] ?? '')) fail('Claude 실행 파일을 확인하지 못했다.');
  return argv;
}
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

function childClaude(pid) {
  // The token launcher adds a node process between the terminal and Claude.
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$all=@(Get-CimInstance Win32_Process); $ids=@(${Number(pid)}); for($depth=0;$depth -lt 8;$depth++){ $level=@($all | Where-Object { $_.ParentProcessId -in $ids }); $found=@($level | Where-Object Name -eq 'claude.exe'); if($found.Count -gt 0){ $found | Select-Object -ExpandProperty ProcessId; break }; $ids=@($level.ProcessId); if($ids.Count -eq 0){break} }`], { encoding: 'utf8', windowsHide: true });
  const found = r.stdout.split(/\s+/).map(Number).filter(n => n > 0);
  if (found.length > 1) fail('터미널 안에 Claude가 여러 개 있어 자동 교체하지 않습니다.');
  return found[0] ?? null;
}

function sessionOf(claudePid) {
  const store = tokenStore(), record = json(tokenRecord(claudePid), null);
  const dirs = [{ dir: store.configDir, account: record?.account ?? store.legacyDirs?.find(entry => entry.dir === store.configDir)?.account ?? null }, ...(store.legacyDirs ?? [])];
  for (const entry of dirs) {
    const s = json(join(entry.dir, 'sessions', `${claudePid}.json`), null);
    if (s?.sessionId) return { account: record?.account ?? entry.account, sessionId: s.sessionId, cwd: s.cwd, configDir: entry.dir, tokenBased: Boolean(record) };
  }
  return null;
}
const activeKey = () => tokenStore().active;

// Every live local Claude terminal, independent of harness project registration.
export function sessions() {
  const active = activeKey(), out = [];
  for (const item of hc(['ls', '--json']).terminals ?? []) {
    if (item.state !== 'live' || !/claude/i.test(item.agent ?? '')) continue;
    try {
      const t = hc(['get', item.address]);
      if (t.state !== 'live') continue;
      const pid = childClaude(t.pid) ?? t.pid, session = sessionOf(pid);
      out.push({ address: item.address, name: t.name ?? t.title ?? item.address,
        where: item.where ?? t.labels?.where ?? null, space: t.labels?.['herdr.space'] ?? null,
        cwd: session?.cwd ?? t.cwd, status: t.status?.state ?? item.status, kind: t.status?.kind ?? null,
        account: session?.account ?? null, tokenBased: session?.tokenBased ?? false, active,
        resumable: Boolean(session && (shellTerminal(t) || t.name)),
        switchable: Boolean(session && active) && (session.account !== active || !session.tokenBased) });
    } catch { /* Closed while refreshing; do not guess the target. */ }
  }
  return out;
}

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
      tokenBased: session?.tokenBased ?? false, account: session?.account ?? null, sessionId: session?.sessionId ?? null, active, switchable: Boolean(session && active) && (session.account !== active || !session.tokenBased) });
  }
  return out;
}

export function switchLead(address, { force = false, note, allowSame = false } = {}) {
  const key = activeKey() ?? fail('현재 계정을 알 수 없다. 등록된 계정으로 먼저 전환한다.');
  const a = tokenStore().accounts[key];
  const t = hc(['get', address]);
  if (t.state !== 'live') fail(`${address}는 살아 있는 터미널이 아니다.`);
  if (!shellTerminal(t)) fail(`${address}는 셸 안에서 뜬 Claude가 아니라 교체하지 않는다.`);
  if (t.status?.state === 'working' && !force) fail(`${address} Lead가 작업 중이다. 이번 턴이 끝난 뒤 교체한다.`);
  const pid = childClaude(t.pid) ?? fail(`${address}에서 실행 중인 Claude를 찾지 못했다.`);
  const session = sessionOf(pid) ?? fail(`${address} Claude의 세션 기록을 찾지 못했다.`);
  if (session.account === key && session.tokenBased && !allowSame) fail(`${address} Lead는 이미 현재 계정(${a.label})을 쓴다.`);
  readToken(key); // Decrypt before stopping; never fall back to /login.
  const argv = processArgv(pid), keep = launchOptions(argv);
  const exitFlags = [];
  if (t.status?.state === 'blocked') {
    if (t.status.kind !== 'auth') fail('인증 오류 이외의 대기 화면은 자동으로 종료하지 않습니다.');
    const screen = String(hc(['read', address]));
    const fresh = hc(['get', address]);
    if (fresh.status?.state !== 'blocked' || fresh.status.kind !== 'auth'
      || !/Login expired[^\n]*Please run \/login/i.test(screen)
      || !/^❯[ \t\u00a0]*$/m.test(screen)) fail('인증 만료 입력 화면을 확인하지 못해 기존 세션을 유지합니다.');
    exitFlags.push('--force'); // Only /exit, after inspecting this auth screen.
  }
  hc(['send', ...exitFlags, address, '/exit']);
  for (let i = 0; i < 60 && childClaude(t.pid); i++) sleep(500);
  if (childClaude(t.pid)) fail(`${address} Claude가 30초 안에 끝나지 않았다. 화면을 확인한다.`);
  migrateConversation(session, tokenStore().configDir);
  // 버튼은 세션만 재개한다. 멈추기 직전 지시를 자동 재전송해 이미 끝난 작업을 반복하지 않는다.
  const prompt = note ?? null;
  const command = [process.execPath, TOKEN_LAUNCHER, '--account', key, '--', ...keep, '--resume', session.sessionId, ...(prompt ? ['--', prompt] : [])].map(psQuote).join(' ');
  hc(['send', address, `& ${command}`]);
  let next = null;
  for (let i = 0; i < 60 && !next; i++) { sleep(500); next = childClaude(t.pid); }
  if (!next) fail(`${address}에서 새 Claude가 뜨지 않았다. 화면을 확인한다.`);
  return { address, from: session.account, to: key, sessionId: session.sessionId, pid: next };
}

// ---- Codex 사용량(보기 전용) ----
// Codex는 세션 기록(~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)의 token_count 사건에 rate_limits를 남긴다.
// 가장 최근 기록 하나의 마지막 값을 읽는다. 창 길이(window_minutes)로 주간·5시간을 가른다.
export function codexUsage(root = join(homedir(), '.codex', 'sessions')) {
  const newest = (dir, depth) => {
    let names;
    try { names = readdirSync(dir).sort().reverse(); } catch { return []; }
    if (depth === 0) return names.filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n));
    for (const n of names) { const found = newest(join(dir, n), depth - 1); if (found.length) return found; }
    return [];
  };
  const files = newest(root, 3).map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(0, 5)) {
    const text = readFileSync(f, 'utf8'), lines = text.slice(Math.max(0, text.length - 400000)).split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"rate_limits"')) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const rl = ev.payload?.rate_limits;
      if (!rl) continue;
      const out = { updated: Math.floor(Date.parse(ev.timestamp) / 1000) || null, plan: rl.plan_type ?? null, five_hour: null, seven_day: null };
      for (const w of [rl.primary, rl.secondary]) {
        if (!w || typeof w.used_percent !== 'number') continue;
        out[w.window_minutes >= 1440 ? 'seven_day' : 'five_hour'] = { used: w.used_percent, reset: w.resets_at ?? null };
      }
      return out;
    }
  }
  return null;
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
