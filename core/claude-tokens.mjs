import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const TOKEN_ROOT = join(homedir(), '.config', 'herdr-harness');
export const TOKEN_STORE = join(TOKEN_ROOT, 'claude-tokens.json');
export const TOKEN_LAUNCHER = fileURLToPath(new URL('../bin/claude-token-run.mjs', import.meta.url));
export const keyCheck = (key) => {
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(key ?? '')) throw new Error('토큰 키는 소문자 영문으로 시작하는 짧은 이름이어야 합니다.');
  return key;
};
export const tokenFile = key => join(TOKEN_ROOT, 'tokens', `${keyCheck(key)}.dpapi`);
export const tokenRecord = pid => join(TOKEN_ROOT, 'token-sessions', `${Number(pid)}.json`);
export function tokenStore() {
  if (!existsSync(TOKEN_STORE)) return { version: 2, active: null, configDir: join(homedir(), '.claude'), accounts: {}, legacyDirs: [] };
  const store = JSON.parse(readFileSync(TOKEN_STORE, 'utf8'));
  if (store.version !== 2 || !store.accounts || !isAbsolute(store.configDir ?? '')) throw new Error('장기 토큰 설정 형식이 올바르지 않습니다.');
  return store;
}
export function saveTokenStore(store) {
  mkdirSync(dirname(TOKEN_STORE), { recursive: true });
  const temp = `${TOKEN_STORE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(store, null, 2) + '\n');
  renameSync(temp, TOKEN_STORE);
}
export function requireToken(key) {
  keyCheck(key);
  if (!tokenStore().accounts[key] || !existsSync(tokenFile(key))) throw new Error(`${key.toUpperCase()} 장기 토큰을 먼저 등록하세요. /login 방식은 사용하지 않습니다.`);
}
export function readToken(key) {
  requireToken(key);
  // DPAPI decryption stays in this user's local process tree; no secret in argv.
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $secure=ConvertTo-SecureString ((Get-Content -LiteralPath $env:HERDR_TOKEN_FILE -Raw).Trim()); $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }"],
  { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH')), HERDR_TOKEN_FILE: tokenFile(key) } });
  if (result.status !== 0) throw new Error(`${key.toUpperCase()} 장기 토큰 복호화 실패. 같은 Windows 사용자로 다시 등록하세요.`);
  const token = result.stdout.trim();
  if (!/^sk-ant-oat\d+-[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('등록된 값이 Claude OAuth 장기 토큰 형식이 아닙니다.');
  return token;
}
export function registerToken(key, label = key.toUpperCase()) {
  keyCheck(key);
  if (!existsSync(tokenFile(key))) throw new Error('먼저 보안 입력 화면에서 토큰을 저장하세요.');
  const s = tokenStore();
  s.accounts[key] = { ...s.accounts[key], label };
  saveTokenStore(s);
  return tokenStatus();
}
export function tokenStatus() {
  const s = tokenStore();
  return { store: TOKEN_STORE, mode: 'long-lived-token', configDir: s.configDir, accounts: Object.entries(s.accounts).map(([key, a]) => ({
    key, label: a.label, active: s.active === key, configured: existsSync(tokenFile(key)),
    usageFile: join(TOKEN_ROOT, 'token-usage', key, 'usage-cache.json'),
  })) };
}
export function tokenUse(key) {
  readToken(key); // Verify usability before changing the selector, without network calls.
  const s = tokenStore(); s.active = key; saveTokenStore(s);
  return tokenStatus();
}
export function tokenEnvironment(key, token, inherited = process.env, store = tokenStore()) {
  const env = { ...inherited };
  const replaced = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_PROFILE', 'CLAUDE_CONFIG_DIR', 'HERDR_CLAUDE_ACCOUNT', 'HERDR_CLAUDE_USAGE_DIR']);
  for (const name of Object.keys(env)) if (replaced.has(name.toUpperCase())) delete env[name];
  if (resolve(store.configDir).toLowerCase() !== resolve(homedir(), '.claude').toLowerCase()) env.CLAUDE_CONFIG_DIR = store.configDir;
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.HERDR_CLAUDE_ACCOUNT = key;
  env.HERDR_CLAUDE_USAGE_DIR = join(TOKEN_ROOT, 'token-usage', key);
  return env;
}
