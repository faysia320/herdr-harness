import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 실제 복구 함수를 실행하되 파일·프로세스 경계만 대역으로 바꾼다.
const source = readFileSync(new URL('../core/claude-accounts.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const help = `Options:
  --chrome  Enable Chrome
  --dangerously-skip-permissions  Skip permissions
  --model <model>  Model
  --settings <file-or-json>  Settings
  --add-dir <directories...>  Directories
  -c, --continue  Continue
  -r, --resume [value]  Resume
  --session-id <uuid>  Session
  --fork-session  Fork
`;
function fixture({ loggedIn = true, working = false, commandLine = 'claude.exe', helpText = help, inheritSettings, withSettings = false } = {}) {
  const home = resolve('fixture-account-home'), b = join(home, '.claude-b');
  const files = new Map(), calls = [];
  const put = (p, value) => files.set(p, Buffer.from(JSON.stringify(value)));
  put(join(home, '.config/herdr-harness/claude-accounts.json'), {
    version: 1, accounts: { a: { label: '기본', dir: null }, b: { label: 'B', dir: b, inheritSettings } },
  });
  if (withSettings) {
    put(join(home, '.claude/settings.json'), { model: 'from-a', hooks: { SessionStart: [] } });
    put(join(b, 'settings.json'), { remoteControlAtStartup: false });
  }
  put(join(b, '.credentials.json'), { claudeAiOauth: loggedIn ? { accessToken: 'test-only' } : { expiresAt: 0 } });
  put(join(home, '.claude/sessions/101.json'), { sessionId: 'session-a', cwd: 'D:/repo' });
  const terminal = { address: 't19m', state: 'live', argv: ['pwsh.exe'], pid: 10,
    name: null, title: '대화 제목', status: { app: 'claude-code', state: working ? 'working' : 'error' } };
  let pid = 101;
  const spawnSync = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    let value = '';
    if (cmd === 'powershell.exe') value = args.at(-1).includes('GetEnvironmentVariable') ? b
      : args.at(-1).includes('ExpandProperty CommandLine') ? commandLine : String(pid ?? '');
    else if (/claude\.exe$/.test(cmd) && args[0] === '--help') value = helpText;
    else if (cmd === 'hc') {
      if (args[0] === 'get') value = JSON.stringify(terminal);
      else if (args[0] === 'send') {
        pid = args[2] === '/exit' ? null : 202;
        value = '{}';
      } else throw new Error(`Unexpected destructive call: ${args}`);
    } else throw new Error(`Unexpected process: ${cmd}`);
    return { status: 0, stdout: value, stderr: '' };
  };
  const api = {
    existsSync: (p) => files.has(p), readFileSync: (p, encoding) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return encoding ? files.get(p).toString(encoding) : files.get(p);
    }, mkdirSync() {}, writeFileSync() { throw new Error('Unexpected write'); },
    copyFileSync() { throw new Error('Unexpected copy'); }, renameSync() { throw new Error('Unexpected rename'); },
    homedir: () => home, join, resolve, spawnSync, Atomics: { wait() {} },
  };
  const module = new Function(...Object.keys(api), `${source}; return {resumeTerminal, status, use, splitCommandLine, launchOptions};`)(...Object.values(api));
  return { ...module, calls, alive: () => pid };
}

test('이름 없는 셸의 Claude를 실제 세션 ID로 같은 터미널에서 재개한다', () => {
  const f = fixture();
  assert.deepEqual(f.resumeTerminal('t19m'), { address: 't19m', from: 'a', to: 'b', sessionId: 'session-a', pid: 202 });
  const sends = f.calls.filter((c) => c.cmd === 'hc' && c.args[0] === 'send');
  assert.deepEqual(sends[0].args, ['send', 't19m', '/exit']);
  assert.equal(sends[1].args[1], 't19m');
  assert.match(sends[1].args[2], /CLAUDE_CONFIG_DIR=.*; & 'claude.exe' '--resume' 'session-a'$/);
  assert.ok(!f.calls.some((c) => c.cmd === 'hc' && ['kill', 'rm', 'run'].includes(c.args[0])));
});

test('독립 설정 계정은 계정 전환과 Lead 재개 때 A 설정을 복사하지 않는다', () => {
  const f = fixture({ inheritSettings: false, withSettings: true });
  assert.equal(f.use('b').accounts.find((a) => a.key === 'b').active, true);
  assert.equal(f.resumeTerminal('t19m').to, 'b');
  // The fixture rejects every file write/copy, so both paths must preserve B settings.
});

test('설정 상속을 지정하지 않은 기존 계정은 공통 설정 동기화를 계속 시도한다', () => {
  const f = fixture({ withSettings: true });
  assert.throws(() => f.use('b'), /Unexpected write/);
});

test('Lead 교체는 기존 Chrome·권한·모델·경로 옵션을 보존하고 세션과 프롬프트만 교체한다', () => {
  const f = fixture({ commandLine: '"C:\\Program Files\\Claude\\claude.exe" --dangerously-skip-permissions --chrome --model=opus --settings "D:\\my repo\\it\'s.json" --resume old --fork-session -- "old prompt"' });
  f.resumeTerminal('t19m');
  const command = f.calls.filter((c) => c.cmd === 'hc' && c.args[0] === 'send').at(-1).args[2];
  assert.ok(command.endsWith("& 'C:\\Program Files\\Claude\\claude.exe' '--dangerously-skip-permissions' '--chrome' '--model=opus' '--settings' 'D:\\my repo\\it''s.json' '--resume' 'session-a'"));
  assert.ok(!command.includes('old'));
  assert.ok(!command.includes('--fork-session'));
});

test('실행 명령이나 옵션을 읽을 수 없으면 기존 Claude를 종료하지 않는다', () => {
  for (const options of [{ commandLine: '' }, { commandLine: 'claude.exe --unknown' }, { helpText: '' }]) {
    const f = fixture(options);
    assert.throws(() => f.resumeTerminal('t19m'), /Claude 실행/);
    assert.equal(f.alive(), 101);
    assert.ok(!f.calls.some((c) => c.cmd === 'hc' && c.args[0] === 'send'));
  }
});

test('Windows 실행 인자는 빈 값·JSON 따옴표·경로 끝 역슬래시를 보존한다', () => {
  const f = fixture();
  assert.deepEqual(f.splitCommandLine(String.raw`claude.exe --settings "{\"x\":\"y\"}" "" "D:\my repo\\"`),
    ['claude.exe', '--settings', '{"x":"y"}', '', 'D:\\my repo\\']);
  assert.deepEqual(f.launchOptions(['claude.exe', '--chrome', '-c', '-r', 'old', '--session-id=new', '--add-dir', 'a', 'b', '--', 'prompt']),
    ['--chrome', '--add-dir', 'a', 'b']);
});

test('토큰이 지워진 B는 로그인 필요로 표시하고 기존 세션 종료 전에 재개를 거부한다', () => {
  const f = fixture({ loggedIn: false });
  assert.equal(f.status().accounts.find((a) => a.key === 'b').loggedIn, false);
  assert.throws(() => f.resumeTerminal('t19m'), /B.*로그인이 필요/);
  assert.equal(f.alive(), 101);
  assert.ok(!f.calls.some((c) => c.cmd === 'hc' && c.args[0] === 'send'));
});

test('작업 중인 셸은 재개 버튼으로 종료하지 않는다', () => {
  const f = fixture({ working: true });
  assert.throws(() => f.resumeTerminal('t19m'), /작업 중/);
  assert.equal(f.alive(), 101);
});

test('재개 버튼의 오류는 뒤따르는 자동 새로고침 후에도 화면에 남는다', async () => {
  const uiSource = readFileSync(new URL('../mod/claude-accounts/main.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export default class ClaudeAccounts', 'class ClaudeAccounts');
  const jobs = [], clicks = new Map(), texts = [], commands = [];
  const el = () => {
    let id;
    const e = new Proxy({}, { get: (_, name) => (...args) => {
      if (name === 'id') id = args[0];
      if (name === 'on_click') clicks.set(id, args[0]);
      if (name === 'when' && args[0]) args[1](e);
      if (name === 'child' && typeof args[0] === 'string') texts.push(args[0]);
      return e;
    } });
    return e;
  };
  const api = { View: class {}, div: el, v_flex: el, h_flex: el, layout: () => ({}), home: () => 'fixture',
    theme: () => ({}), readTextFile: async (p) => p.endsWith('active.json') ? '{"release":"release"}' : '{}',
    exec: async (_cmd, args) => {
      commands.push(args.slice(1));
      const cmd = args[1];
      return cmd === 'resume' ? { code: 2, stderr: 'B 계정은 로그인이 필요하다.' }
        : { code: 0, stdout: JSON.stringify(cmd === 'status' ? { accounts: [] } : [{ address: 't19m' }]) };
    } };
  const Accounts = new Function(...Object.keys(api), `${uiSource}; return ClaudeAccounts;`)(...Object.values(api));
  const view = new Accounts();
  const cx = { notify() {}, stop_propagation() {}, spawn(fn) { jobs.push(fn(cx)); }, timer: { every() {} } };
  const drain = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
  view.init({}, cx); await drain(); view.render(cx);
  clicks.get('acct-resume-t19m')({}, cx); await drain();
  view.refresh(cx, true); await drain(); view.render(cx);
  assert.ok(commands.some((a) => a[0] === 'resume' && a[1] === 't19m'));
  assert.ok(texts.some((t) => /이어서 실행 실패: B 계정은 로그인이 필요/.test(t)));
  assert.equal(view.refreshError, null);
  assert.match(view.error, /로그인이 필요/);
});
