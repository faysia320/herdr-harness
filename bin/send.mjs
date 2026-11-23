#!/usr/bin/env node
// hc send 보정 전송. Codex는 붙여 넣기 직후의 Enter를 줄바꿈으로 삼켜 입력창에 원문이 남는 경우가 있다.
// 대상이 Codex일 때만 잠시 뒤 입력창(모델 상태 줄 바로 위 › 블록)을 읽어 이번 원문이 남아 있으면 Enter만 다시 누른다.
// 원문을 다시 붙여 넣지 않는다. 끝까지 남거나 화면을 읽지 못하면 실패로 끝낸다. 다른 대상은 hc send와 같다.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = ms => new Promise(done => setTimeout(done, ms));

export function runHc(args, { command = process.env.HH_SEND_HC } = {}) {
  // 시험용 가짜 hc는 node 스크립트로 지정한다(HH_SEND_HC). 평소에는 PATH의 hc를 shell 없이 부른다.
  const [file, pre] = command ? [process.execPath, [command]] : ['hc', []];
  const r = spawnSync(file, [...pre, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, shell: false });
  return { code: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? `${r.stderr ?? ''}${r.error.message}\n` : r.stderr ?? '' };
}

const squash = s => String(s).replace(/\s+/g, '');
export const isCodex = terminal => [terminal?.status?.app, terminal?.agent].some(v => typeof v === 'string' && /codex/i.test(v));

// 빈 입력창에 흐리게 표시되는 Codex 안내 문구. 초안이 아니므로 원문 탐지에서 뺀다.
const PLACEHOLDERS = new Set([
  'Ask Codex to do anything', 'Explain this codebase', 'Summarize recent commits', 'Implement {feature}',
  'Find and fix a bug in @filename', 'Write tests for @filename', 'Improve documentation in @filename',
  'Run /review on my current changes', 'Use /skills to list available skills',
].map(squash));

// 화면 하단의 현재 입력 블록. 마지막 비어 있지 않은 줄(모델 상태 줄) 위로 올라가 처음 만나는 › 줄까지다.
// 입력창 본문의 글머리표(•)는 초안의 일부로 보존한다. 구분선에 먼저 닿거나 블록이 지나치게 길면 찾지 못한 것으로 본다(null).
export function inputBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  const block = [];
  for (let i = end - 1; i >= 0 && block.length < 40; i--) {
    const line = lines[i].trimStart();
    if (line.startsWith('›')) return [line.slice(1), ...block].join('\n');
    if (/^[─━]/.test(line)) return null;
    block.unshift(line);
  }
  return null;
}

// 원문이 입력창에 남았는지. 표시상 줄바꿈·공백을 무시하고, 긴 원문은 앞·뒤 일부로 찾는다(앞부분이 스크롤로 가려질 수 있다).
export function remains(text, screen) {
  const block = inputBlock(screen);
  if (block === null) return false;
  const have = squash(block), want = squash(text);
  if (!want || PLACEHOLDERS.has(have)) return false;
  return want.length <= 60 ? have.includes(want) : have.includes(want.slice(0, 40)) || have.includes(want.slice(-40));
}

export async function send(address, text, { hc = runHc, delay = 1500, retries = 3, log = () => {} } = {}) {
  const sent = hc(['send', address, text, '--json']);
  if (sent.code !== 0) return { code: sent.code, stdout: sent.stdout, stderr: sent.stderr };
  const got = hc(['get', address, '--json']);
  let terminal = null;
  try { terminal = got.code === 0 ? JSON.parse(got.stdout) : null; } catch { /* 판정 불가 */ }
  if (!isCodex(terminal)) return { code: 0, stdout: sent.stdout, stderr: '' };
  for (let attempt = 0; ; attempt++) {
    await sleep(delay);
    const read = hc(['read', address, '--json']);
    let screen;
    try { screen = read.code === 0 ? JSON.parse(read.stdout).text : undefined; } catch { /* 아래에서 실패 */ }
    if (typeof screen !== 'string') return { code: 1, stdout: sent.stdout, stderr: `전송 뒤 ${address} 화면을 읽지 못했다: ${(read.stderr || read.stdout).trim()}\n` };
    if (!remains(text, screen)) return { code: 0, stdout: sent.stdout, stderr: '' };
    if (attempt >= retries) return { code: 1, stdout: sent.stdout, stderr: `Enter ${retries}회 뒤에도 ${address} 입력창에 원문이 남아 있다. 화면을 확인한다.\n` };
    log(`${address} 입력창에 원문이 남아 Enter를 보낸다(${attempt + 1}/${retries}).`);
    const keys = hc(['keys', address, 'enter', '--json']);
    if (keys.code !== 0) return { code: keys.code, stdout: sent.stdout, stderr: `Enter 전송 실패: ${(keys.stderr || keys.stdout).trim()}\n` };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [address, text, ...rest] = process.argv.slice(2);
  if (!address || typeof text !== 'string' || !text.trim() || rest.length) {
    console.error('사용법: node send.mjs <터미널> <텍스트>');
    process.exit(2);
  }
  const delay = Number(process.env.HH_SEND_DELAY_MS ?? 1500);
  const r = await send(address, text, { delay: Number.isFinite(delay) && delay >= 0 ? delay : 1500, log: m => console.error(m) });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
