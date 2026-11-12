import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { build, root } from '../scripts/build.mjs';
import { run } from '../core/process.js';
import { decisionInbox } from '../core/decisions.js';
import { createRequire } from 'node:module';

// 회사 소스는 개인 저장소에 복제하지 않는다. 호출자가 지정한 checkout에서 임시 fixture로만 읽는다.
assert.ok(process.env.HERDR_HARNESS_ADAPTERS, 'HERDR_HARNESS_ADAPTERS=<로컬 adapter 목록 JSON>이 필요하다');
const adapters = JSON.parse(readFileSync(process.env.HERDR_HARNESS_ADAPTERS, 'utf8'));
const built = build();
const policy = createRequire(import.meta.url)(join(built.release, 'core/execution-policy.cjs'));
for (const adapter of adapters) test(`${adapter.name}: 공통 launcher → 회사 CLI → 공통 결정함`, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'herdr-adapter-')), repo = join(temp, 'repo');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  mkdirSync(repo);
  const copy = (file) => { mkdirSync(dirname(join(repo, file)), { recursive: true }); copyFileSync(join(adapter.root, file), join(repo, file)); };
  for (const file of [adapter.cli, '.agents/harness/config.json', '.agents/harness/runtime.cjs']) copy(file);
  // Git checkout의 LF/CRLF 차이는 런타임 소스 변경으로 취급하지 않는다.
  const source = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(source(join(repo, '.agents/harness/runtime.cjs')), source(join(root, 'adapters/runtime.cjs')));
  if (adapter.name === 'sw') copy('scripts/ci/check-worktree.mjs');
  if (adapter.name === 'vdp') for (const file of ['.agents/harness/decision.mjs', '.agents/harness/process-artifacts.mjs', '.agents/harness/cli-io.mjs', 'scripts/check-process-artifacts.mjs']) copy(file);
  const config = JSON.parse(readFileSync(join(repo, '.agents/harness/config.json'), 'utf8'));
  const project = config.project.id, stateDir = join(repo, config.project.state_dir);
  mkdirSync(stateDir, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', `https://example.invalid/${config.project.remote_pattern ?? project}.git`]]) {
    assert.equal(run('git', ['-C', repo, ...args]).code, 0);
  }
  const ledger = { version: 1, project, seq: 1, lead: { terminal: 'fixture-lead', attached_at: null, previous: null }, tasks: { 'T-1': { id: 'T-1', state: 'DONE' } } };
  const ledgerPath = join(stateDir, 'ledger.json'), eventsPath = join(stateDir, 'events.jsonl');
  writeFileSync(ledgerPath, JSON.stringify(ledger)); writeFileSync(eventsPath, 'fixture unchanged\n');
  const ledgerBytes = readFileSync(ledgerPath), eventBytes = readFileSync(eventsPath);
  const live = join(temp, 'live.json'); writeFileSync(live, '{"exists":true,"state":"live"}');
  const env = { ...process.env, HC_TERMINAL_ID: 'fixture-lead', FIXTURE_LIVE: live };
  for (const key of ['SWH_STATE_DIR', 'VDH_STATE_DIR', 'HARNESS_STATE_DIR', 'HARNESS_CONFIG', 'HARNESS_REPO_ROOT']) delete env[key];
  let command;
  if (adapter.kind === 'python') {
    const driver = join(repo, 'fixture.py');
    writeFileSync(driver, `import sys,json,os\nfrom pathlib import Path\nsys.path.insert(0,str(Path(__file__).parent/'scripts'))\nimport herdr_harness as hh\nhh.terminal_info=lambda env,name: json.loads(Path(os.environ['FIXTURE_LIVE']).read_text())\nsys.exit(hh.main())\n`);
    command = ['python', '-B', driver];
  } else {
    const fake = join(temp, 'fake-hc.mjs');
    writeFileSync(fake, `import{readFileSync}from'node:fs';console.log(readFileSync(process.env.FIXTURE_LIVE,'utf8'));`);
    env[adapter.name === 'sw' ? 'SWH_HC' : 'VDH_HC'] = JSON.stringify([process.execPath, fake]);
    command = [process.execPath, join(repo, adapter.cli)];
  }
  const binding = join(stateDir, 'harness-binding.json');
  writeFileSync(binding, JSON.stringify({ version: 1, project, release: built.release, manifestHash: built.manifestHash, cwd: repo, command }));
  const argv = [join(built.release, 'bin/harness.mjs'), '--binding', binding];
  function cli(args, options = {}) {
    const result = run(process.execPath, [...argv, ...args], { cwd: repo, env: { ...env, ...options.env } });
    if (options.fail) { assert.notEqual(result.code, 0, result.stdout); return result; }
    assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
  }
  const effective = cli(['policy']);
  const expected = policy.configure(config);
  assert.deepEqual(effective.limits, expected.limits);
  assert.deepEqual(effective.policy, expected.execution_policy);
  assert.deepEqual(config.execution_overrides, {}, '현재 프로젝트 예외는 없어야 한다');
  for (const [profile, stage, rework] of [['normal', 'research', 0], ['normal', 'implement', 0], ['normal', 'qa', 0], ['high-risk', 'architect', 0], ['ui-simple', 'research', 0], ['shared-component', 'implement', 1], ['normal', 'implement', 2], ['token', 'qa', 0]]) {
    const result = cli(['policy', '--profile', profile, '--stage', stage, '--rework', String(rework)]);
    const resolved = policy.resolve(config, { profile, rework }, stage);
    const comparable = argv => argv.map((value,index) => index === 0 && process.platform === 'win32' ? value.toLowerCase() : value);
    assert.deepEqual(comparable(result.argv), comparable(resolved.argv));
    assert.equal(result.releaseHash, built.manifestHash);
    assert.equal(result.policy.sha256, expected.execution_policy.sha256);
  }
  cli(['policy', '--stage', 'implement', '--profile', 'typo'], { fail: true });
  const question = join(temp, 'question.json'), answer = join(temp, 'answer.json');
  writeFileSync(question, JSON.stringify({ question: '범위를 정해주세요', source: '합성 사용자 대화' }));
  writeFileSync(answer, JSON.stringify({ quote: '좁게', source: '합성 실제 답변' }));
  const first = cli(['decision', 'request', 'scope', '--file', question]);
  assert.deepEqual(cli(['decision', 'request', 'scope', '--file', question]), first);
  writeFileSync(question, JSON.stringify({ task: 'T-1', question: '병합할까요?', source: '합성 QA 이후 보고' }));
  cli(['decision', 'request', 'merge', '--file', question]);
  assert.equal(cli(['decision', 'list']).length, 2);
  const file = join(stateDir, 'decisions.json'), before = readFileSync(file);
  cli(['decision', 'resolve', 'scope', '--file', answer, '--revision', '0'], { fail: true });
  cli(['decision', 'request', 'bad', '--file', question], { fail: true, env: { HC_TERMINAL_ID: 'other' } });
  writeFileSync(live, '{"exists":true,"state":"finished"}');
  cli(['decision', 'request', 'bad', '--file', question], { fail: true });
  assert.deepEqual(readFileSync(file), before);
  writeFileSync(live, '{"exists":true,"state":"live"}');
  cli(['decision', 'resolve', 'scope', '--file', answer, '--revision', '1']);
  assert.deepEqual(cli(['decision', 'list']).map((r) => r.id), ['merge']);
  assert.equal(cli(['decision', 'list', '--all']).length, 2);
  // 두 별도 프로세스가 같은 기존 ledger.lock을 거쳐 서로의 질문을 잃지 않아야 한다.
  const concurrent = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...argv, 'decision', 'request', id, '--file', question], { cwd: repo, env, windowsHide: true });
    let err = ''; child.stderr.on('data', (b) => err += b); child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(err)));
  });
  await Promise.all([concurrent('parallel-a'), concurrent('parallel-b')]);
  const inbox = decisionInbox(readFileSync(file, 'utf8'), project);
  assert.equal(inbox.status, 'ready'); assert.equal(inbox.requests.length, 4);
  const valid = readFileSync(file);
  writeFileSync(file, '{'); cli(['decision', 'request', 'bad', '--file', question], { fail: true }); assert.equal(readFileSync(file, 'utf8'), '{');
  writeFileSync(file, valid);
  const wrong = run(command[0], [...command.slice(1), 'decision', 'list'], { cwd: temp, env }); assert.notEqual(wrong.code, 0);
  assert.deepEqual(readFileSync(ledgerPath), ledgerBytes); assert.deepEqual(readFileSync(eventsPath), eventBytes);
});
