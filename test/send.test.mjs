import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { send, remains } from '../bin/send.mjs';

const cli = fileURLToPath(new URL('../bin/send.mjs', import.meta.url));
const text = 'Lead 주소가 t9로 바뀌었다. 완료 보고는 t9로 보낸다.';
const status = '  GPT-6-Luna xhigh · Context 12% used';
const left = `› 이전 질문\n\n• 이전 답\n\n› <hc from="t1 lead">${text}</hc>\n\n${status}\n`;
const empty = `› <hc from="t1 lead">${text}</hc>\n\n• 알겠습니다.\n\n› Ask Codex to do anything\n\n${status}\n`;

// 대상 정보와 화면 순서를 받아 hc 호출을 기록하는 가짜 hc.
function fake(terminal, screens, { sendCode = 0 } = {}) {
  const calls = [];
  const hc = args => {
    calls.push(args);
    if (args[0] === 'send') return sendCode ? { code: sendCode, stdout: '', stderr: 'no such terminal\n' } : { code: 0, stdout: '{"started":true,"status":"idle"}\n', stderr: '' };
    if (args[0] === 'get') return { code: 0, stdout: JSON.stringify(terminal), stderr: '' };
    if (args[0] === 'read') return { code: 0, stdout: JSON.stringify({ complete: true, text: screens.length > 1 ? screens.shift() : screens[0] }), stderr: '' };
    if (args[0] === 'keys') return { code: 0, stdout: '{}', stderr: '' };
    throw new Error('예상 밖 호출 ' + args.join(' '));
  };
  return { hc, calls, kinds: () => calls.map(a => a[0]) };
}
const codex = { address: 't5', state: 'live', status: { app: 'codex', state: 'idle' } };

test('(a) Codex 입력창에 원문이 남으면 원문을 다시 붙이지 않고 Enter만 보낸 뒤 재확인한다', async () => {
  const f = fake(codex, [left, empty]);
  const r = await send('t5', text, { hc: f.hc, delay: 0 });
  assert.equal(r.code, 0);
  assert.deepEqual(f.calls[0], ['send', 't5', text, '--json']);
  assert.deepEqual(f.kinds(), ['send', 'get', 'read', 'keys', 'read']);
  assert.deepEqual(f.calls[3], ['keys', 't5', 'enter', '--json']);
  assert.equal(f.kinds().filter(k => k === 'send').length, 1);
});

test('(b) 입력창이 비었으면 대화 기록에 같은 원문이 있어도 추가 키를 보내지 않는다', async () => {
  for (const terminal of [codex, { address: 't5', agent: 'codex', status: { app: null } }]) {
    const f = fake(terminal, [empty]);
    const r = await send('t5', text, { hc: f.hc, delay: 0 });
    assert.equal(r.code, 0);
    assert.deepEqual(f.kinds(), ['send', 'get', 'read']);
  }
  // 다른 초안이 입력창에 있어도 이번 원문이 아니면 건드리지 않는다.
  assert.equal(remains(text, `› 사람이 쓰던 초안\n\n${status}`), false);
  // 표시상 줄바꿈된 원문도 남은 것으로 본다.
  const long = 'x'.repeat(30) + ' 긴 지시 ' + 'y'.repeat(50);
  assert.equal(remains(long, `› <hc from="t1">${long.slice(0, 50)}\n  ${long.slice(50)}</hc>\n\n${status}`), true);
});

test('(c) Codex가 아니면 hc send만 하고 화면을 읽거나 키를 보내지 않는다', async () => {
  const f = fake({ address: 't7', status: { app: 'claude-code', state: 'idle' } }, [left]);
  const r = await send('t7', text, { hc: f.hc, delay: 0 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '{"started":true,"status":"idle"}\n');
  assert.deepEqual(f.kinds(), ['send', 'get']);
  // 전송 실패는 hc send의 종료 코드·진단을 그대로 전한다.
  const failed = fake(codex, [left], { sendCode: 3 });
  const e = await send('t5', text, { hc: failed.hc, delay: 0 });
  assert.equal(e.code, 3); assert.match(e.stderr, /no such terminal/);
  assert.deepEqual(failed.kinds(), ['send']);
});

test('(d) Enter를 상한까지 보내도 남으면 실패 코드로 끝낸다', async () => {
  const f = fake(codex, [left]);
  const r = await send('t5', text, { hc: f.hc, delay: 0 });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Enter 3회 뒤에도 t5 입력창에 원문이 남아 있다/);
  assert.deepEqual(f.kinds(), ['send', 'get', 'read', 'keys', 'read', 'keys', 'read', 'keys', 'read']);
});

test('CLI: 가짜 hc로 Codex가 아니면 send만, 계속 남으면 Enter 3회 뒤 0이 아닌 코드로 끝낸다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-send-'));
  try {
    const log = join(dir, 'calls.jsonl'), state = join(dir, 'screens.json'), hc = join(dir, 'hc.mjs');
    writeFileSync(hc, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), state = ${JSON.stringify(state)};
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const s = JSON.parse(readFileSync(state, 'utf8'));
if (args[0] === 'send') console.log('{"started":true,"status":"idle"}');
if (args[0] === 'get') console.log(JSON.stringify({ status: { app: s.app } }));
if (args[0] === 'read') { console.log(JSON.stringify({ text: s.screens.length > 1 ? s.screens.shift() : s.screens[0] })); writeFileSync(state, JSON.stringify(s)); }
if (args[0] === 'keys') console.log('{}');
`);
    const runCli = (app, screens, message = text) => {
      writeFileSync(state, JSON.stringify({ app, screens })); writeFileSync(log, '');
      const r = spawnSync(process.execPath, [cli, 't5', message], { encoding: 'utf8', env: { ...process.env, HH_SEND_HC: hc, HH_SEND_DELAY_MS: '0' } });
      return { ...r, calls: readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)[0]) };
    };
    let r = runCli('claude-code', [left]);
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.calls, ['send', 'get']);
    r = runCli('codex', [left]);
    assert.equal(r.status, 1); assert.equal(r.calls.filter(c => c === 'keys').length, 3);
    // 글머리표가 있는 여러 줄 초안이 남으면 Enter 한 번 뒤 빈 입력창을 확인하고 끝낸다.
    const placeholder = `› Ask Codex to do anything\n\n${status}\n`;
    const bullet = '다음을 반영해 줘.\n• 회귀 시험을 추가해 줘.';
    r = runCli('codex', [`› <hc from="t1 lead">다음을 반영해 줘.\n  • 회귀 시험을 추가해 줘.</hc>\n\n${status}\n`, placeholder], bullet);
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.calls, ['send', 'get', 'read', 'keys', 'read']);
    // 짧은 원문이 빈 입력창 안내 문구와 겹쳐도 초안으로 보지 않는다.
    r = runCli('codex', [`› <hc from="t1 lead">Codex</hc>\n\n• 확인했습니다.\n\n${placeholder}`], 'Codex');
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.calls, ['send', 'get', 'read']);
    const usage = spawnSync(process.execPath, [cli, 't5'], { encoding: 'utf8', env: { ...process.env, HH_SEND_HC: hc } });
    assert.equal(usage.status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
