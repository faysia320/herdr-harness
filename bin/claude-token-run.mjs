import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { tokenStore, readToken, tokenEnvironment, tokenRecord } from '../core/claude-tokens.mjs';

try {
  const s = tokenStore();
  const argv = process.argv.slice(2);
  let key = s.active;
  if (argv[0] === '--account') { argv.shift(); key = argv.shift(); }
  if (argv[0] === '--') argv.shift();
  const separator = argv.indexOf('--');
  if (argv.slice(0, separator < 0 ? undefined : separator).includes('--bare')) throw new Error('--bare는 장기 토큰 환경변수를 읽지 않아 지원하지 않습니다.');
  if (!key) throw new Error('장기 토큰을 등록한 뒤 사용할 계정을 선택하세요.');
  const env = tokenEnvironment(key, readToken(key), process.env, s);
  mkdirSync(env.HERDR_CLAUDE_USAGE_DIR, { recursive: true });
  const executable = join(homedir(), '.local', 'bin', 'claude.exe');
  const child = spawn(executable, argv, { env, stdio: 'inherit', windowsHide: true });
  let record;
  child.once('spawn', () => {
    try {
      record = tokenRecord(child.pid); mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, JSON.stringify({ pid: child.pid, account: key, configDir: s.configDir, started: Date.now() }));
    } catch { console.error('Claude 계정 추적 기록을 저장하지 못했습니다.'); child.kill(); }
  });
  const cleanup = () => { if (record) { try { unlinkSync(record); } catch {} } };
  child.once('error', () => { cleanup(); console.error('Claude 실행에 실패했습니다. 실행 파일 설치 상태를 확인하세요.'); process.exitCode = 1; });
  child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} catch (error) { console.error(error.message); process.exitCode = 2; }
