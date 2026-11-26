import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueReceipt } from '../core/qa-receipt-runner.mjs';
const require = createRequire(import.meta.url);
const { decodeEnvelope, loadPolicy, verifyResults } = require('../core/qa-receipt-policy.cjs');
const { publishTree } = require('../core/verification-receipt.cjs');

const heavy = fileURLToPath(new URL('../bin/heavy.mjs', import.meta.url));
const image = 'docker.io/library/node@sha256:' + 'c'.repeat(64);
const host = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform];
const tap = n => `TAP version 13\n# tests ${n}\n# suites 0\n# pass ${n}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 42.5\n`;
const envLine = 'HH-QA-ENV ' + JSON.stringify({ os: 'linux', node: 'v22.23.5', git: '2.39.5', prepMs: 7 }) + '\n';
const policy = { version: 1, output: 'target/hh-verify/receipts', exempt_pr_max: 0,
  platforms: { windows: { runner: 'host' }, linux: { runner: 'docker', image } },
  checks: { suite: { result: 'tap', steps: [['node', 'scripts/build.mjs'], ['node', '--test', '--test-reporter=tap']] }, docs: { result: 'exit', steps: [['node', 'docs.mjs']] } },
  required: [{ checks: ['suite'], platforms: ['windows', 'linux'] }, { paths: ['docs/'], checks: ['docs'], platforms: ['windows'] }] };

function repo(t, value = policy) {
  const cwd = mkdtempSync(join(tmpdir(), 'hh-qa-runner-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status) throw Error(args.join(' ') + ': ' + r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'runner'); git('config', 'user.email', 'runner@example.invalid'); git('config', 'core.autocrlf', 'false');
  writeFileSync(join(cwd, '.gitignore'), 'target/hh-verify/\n');
  mkdirSync(join(cwd, 'policy'));
  writeFileSync(join(cwd, 'policy/qa-receipt.json'), JSON.stringify(value));
  writeFileSync(join(cwd, 'a.txt'), 'base\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'a.txt'), 'candidate\n');
  return { cwd, git, base };
}

// heavy·docker 호출만 흉내 낸다. Git 후보 계산과 파일 쓰기는 실제로 한다.
function fake(scenario = {}) {
  const calls = [];
  const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr });
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'docker') {
      if (args[0] === 'version') return scenario.docker ?? ok('linux\n');
      if (args[0] === 'image') return { code: scenario.imageMissing ? 1 : 0, stdout: '', stderr: '' };
      if (args[0] === 'pull') return scenario.pull ?? ok();
      if (args[0] === 'rm') return ok();
      throw Error('unexpected docker ' + args.join(' '));
    }
    assert.deepEqual([command, args[0], args[1]], [process.execPath, heavy, '--']);
    if (args[2] === 'docker') {
      const input = /^"type=bind,source=(.+),target=\/input,readonly"$/.exec(args[args.indexOf('--mount') + 1])[1];
      assert.ok(existsSync(join(input, 'candidate.tar')) && existsSync(join(input, 'phase.cjs')));
      return scenario.linux?.(JSON.parse(readFileSync(join(input, 'input.json'), 'utf8'))) ?? ok(tap(5), '[heavy] slot\n' + envLine);
    }
    return scenario.windows?.(args.slice(2), options) ?? ok('{"release":"x"}\n' + tap(5));
  };
  return { exec, calls };
}
const issue = (r, f, extra = {}) => issueReceipt({ worktree: r.cwd, base: r.base, run: 'qa-1', heavy, hostOs: 'windows', exec: f.exec, ...extra });
const out = r => join(r.cwd, 'target/hh-verify/receipts/qa-1');

test('PASS: 정책의 두 OS를 heavy 슬롯에서 하나씩 실행하고 영수증·봉투를 무시 경로에 남긴다', async t => {
  const r = repo(t), f = fake();
  const result = await issue(r, f, { round: 2, release: 'f'.repeat(64), env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8', HH_KEEP: '1' } });
  assert.equal(result.status, 'PASS', result.reasons.join('\n'));
  const receipt = JSON.parse(readFileSync(join(out(r), 'receipt.json'), 'utf8'));
  assert.deepEqual(decodeEnvelope('## 남은 검증\n- [ ] x\n\n' + readFileSync(join(out(r), 'envelope.txt'), 'utf8')), receipt);
  assert.deepEqual([receipt.kind, receipt.version, receipt.run, receipt.round, receipt.release, receipt.base, receipt.candidate.count],
    ['herdr-qa-receipt', 2, 'qa-1', 2, 'f'.repeat(64), r.base, 1]);
  assert.deepEqual(receipt.results.map(x => [x.platform, x.check, x.state, x.exit, x.tests, x.pass, x.fail]), [['windows', 'suite', 'passed', 0, 5, 5, 0], ['linux', 'suite', 'passed', 0, 5, 5, 0]]);
  assert.deepEqual([receipt.environments.linux.image, receipt.environments.linux.node, receipt.environments.windows.os], [image, 'v22.23.5', 'windows']);
  assert.match(receipt.environments.windows.node, /^v\d+/);
  assert.deepEqual(verifyResults(receipt, loadPolicy(join(r.cwd, 'policy/qa-receipt.json')), ['a.txt']), []);
  // 호스트는 정책 명령을 &&로 이은 heavy 명령, Linux는 고정 digest 이미지에 읽기 전용으로 마운트한 사본에서 비root로 실행한다.
  const runs = f.calls.filter(c => c.command === process.execPath);
  assert.deepEqual(runs[0].args.slice(2), ['node', 'scripts/build.mjs', '&&', 'node', '--test', '--test-reporter=tap']);
  assert.deepEqual(runs[1].args.slice(2, 10), ['docker', 'run', '--rm', '--init', '--name', 'hh-qa-qa-1-linux-suite', '--user', 'node']);
  assert.deepEqual(runs[1].args.slice(-3), [image, 'node', '/input/phase.cjs']);
  assert.ok(runs.every(c => c.options.env.NODE_TEST_CONTEXT === undefined && c.options.env.HH_KEEP === '1' && c.options.cwd === r.cwd));
  assert.ok(f.calls.some(c => c.command === 'docker' && c.args[0] === 'rm' && c.args.includes('hh-qa-qa-1-linux-suite')));
  assert.equal(existsSync(join(out(r), 'linux-suite')), false);
  assert.match(readFileSync(join(out(r), 'linux-suite.log'), 'utf8'), /HH-QA-ENV/);
  assert.deepEqual(result.phases.map(p => [p.platform, p.state, p.tests, p.testMs]), [['windows', 'passed', 5, 43], ['linux', 'passed', 5, 43]]);
  assert.equal(result.phases[1].prepMs, 7);
  // 영수증·로그는 후보에 들어가지 않는다.
  assert.equal(r.git('status', '--porcelain'), 'M a.txt');
  // 경로 규칙이 걸리면 그 검사를 더 실행한다.
  mkdirSync(join(r.cwd, 'docs'));
  writeFileSync(join(r.cwd, 'docs/x.md'), 'doc\n');
  const docs = await issue(r, fake({ windows: () => ({ code: 0, stdout: tap(1), stderr: '' }) }));
  assert.deepEqual(docs.receipt.results.map(x => x.platform + '/' + x.check), ['windows/suite', 'windows/docs', 'linux/suite']);
});

test('격리를 켜면 발급기는 임시 객체 저장소만 쓰고 지운다: 연결 worktree·빈 실제 index에서도 공유 objects와 tree 해시가 그대로다', async t => {
  const r = repo(t), temp = mkdtempSync(join(tmpdir(), 'hh-qa-temp-')), keys = ['TEMP', 'TMP', 'TMPDIR'], saved = keys.map(key => process.env[key]);
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd = join(temp, 'linked'), scratch = join(temp, 'scratch');
  mkdirSync(scratch);
  r.git('worktree', 'add', '-q', '--detach', cwd, r.base);
  writeFileSync(join(cwd, 'a.txt'), 'candidate only\n');
  const objects = () => readdirSync(join(r.cwd, '.git/objects'), { recursive: true }).sort();
  const before = objects(), runs = [];
  t.after(() => keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }));
  for (const key of keys) process.env[key] = scratch;
  process.env.HERDR_RECEIPT_PRIVATE_OBJECTS = '1'; t.after(() => delete process.env.HERDR_RECEIPT_PRIVATE_OBJECTS);
  for (const empty of [false, true]) {
    if (empty) assert.equal(spawnSync('git', ['read-tree', '--empty'], { cwd, windowsHide: true }).status, 0);
    runs.push(await issue({ cwd, base: r.base }, fake()));
  }
  runs.push(await issue({ cwd, base: r.base }, fake({ windows: () => ({ code: 1, stdout: '', stderr: '' }) })));
  await assert.rejects(issue({ cwd, base: r.base }, fake({ windows: () => { throw Error('boom'); } })), /boom/);
  assert.deepEqual(runs.map(x => [x.status, x.candidate.count]), [['PASS', 1], ['PASS', 1], ['FAIL', 1]]);
  assert.deepEqual(objects(), before);
  assert.deepEqual(readdirSync(scratch), []);
  const tree = publishTree(cwd, r.base);
  assert.ok(runs.every(x => x.tree === tree));
});

test('검사별 timeout_ms: 지정한 검사의 heavy 실행에만 쓰고 생략한 검사는 기본 45분이다', async t => {
  const value = structuredClone(policy);
  value.checks.docs.timeout_ms = 4500000;
  value.required = [{ checks: ['suite', 'docs'], platforms: ['windows', 'linux'] }];
  const r = repo(t, value), f = fake({ windows: () => ({ code: 0, stdout: tap(1), stderr: '' }) });
  const result = await issue(r, f);
  assert.equal(result.status, 'PASS', result.reasons.join('\n'));
  const runs = f.calls.filter(c => c.command === process.execPath)
    .map(c => c.args[2] === 'docker' ? ['linux', c.args[c.args.indexOf('--name') + 1].split('-').pop(), c.options.timeout]
      : ['windows', c.args.includes('docs.mjs') ? 'docs' : 'suite', c.options.timeout]);
  assert.deepEqual(runs, [['windows', 'suite', 2700000], ['windows', 'docs', 4500000], ['linux', 'suite', 2700000], ['linux', 'docs', 4500000]]);
  // 호출자가 넘긴 timeout은 정책값이 없는 검사의 기본값으로만 쓴다.
  const g = fake({ windows: () => ({ code: 0, stdout: tap(1), stderr: '' }) });
  await issue(r, g, { timeout: 1000 });
  assert.deepEqual(g.calls.filter(c => c.command === process.execPath).map(c => c.options.timeout), [1000, 4500000, 1000, 4500000]);
});

test('BLOCKED·FAIL은 영수증을 남기지 않고 같은 회차를 다시 시작하면 이전 PASS부터 지운다', async t => {
  const r = repo(t);
  const fresh = async (scenario, extra) => {
    assert.equal((await issue(r, fake())).status, 'PASS');
    assert.ok(existsSync(join(out(r), 'receipt.json')));
    const f = fake(scenario), result = await issue(r, f, extra);
    assert.equal(existsSync(join(out(r), 'receipt.json')) || existsSync(join(out(r), 'envelope.txt')), false);
    assert.equal(JSON.parse(readFileSync(join(out(r), 'result.json'), 'utf8')).status, result.status);
    return { ...result, calls: f.calls };
  };
  const cases = [
    [{ docker: { code: 127, stdout: '', stderr: 'docker: command not found' } }, 'BLOCKED', /Docker Linux 엔진에 연결할 수 없다/],
    [{ docker: { code: 0, stdout: 'windows\n', stderr: '' } }, 'BLOCKED', /Docker Linux 엔진/],
    [{ imageMissing: true, pull: { code: 1, stdout: '', stderr: 'manifest unknown' } }, 'BLOCKED', /이미지를 준비할 수 없다.*manifest unknown/],
    [{ linux: () => ({ code: 90, stdout: '', stderr: 'HH-QA-PREP 사본 tree x가 후보 tree y와 다르다.\n' }) }, 'BLOCKED', /사본 준비 실패\(exit 90\).*사본 tree/],
    [{ linux: () => ({ code: 125, stdout: '', stderr: 'docker: invalid mount' }) }, 'BLOCKED', /exit 125/],
    [{ linux: () => ({ code: 0, stdout: tap(5), stderr: '' }) }, 'BLOCKED', /exit 0/],
    [{ linux: () => ({ code: 1, stdout: tap(5).replace('# pass 5', '# pass 4').replace('# fail 0', '# fail 1'), stderr: envLine }) }, 'FAIL', /linux\/suite: exit 1, tests 5 pass 4 fail 1/],
    [{ linux: () => ({ code: 0, stdout: tap(0), stderr: envLine }) }, 'FAIL', /linux\/suite: exit 0, tests 0/],
    [{ windows: () => ({ code: 124, stdout: 'TAP version 13\n', stderr: '시간 한도' }) }, 'FAIL', /windows\/suite: 시간 한도 초과/],
  ];
  for (const [scenario, status, pattern] of cases) {
    const result = await fresh(scenario);
    assert.equal(result.status, status, JSON.stringify(scenario));
    assert.match(result.reasons.join('\n'), pattern);
  }
  // Windows가 실패하면 Linux를 실행하지 않는다. 실패 로그는 남는다.
  const early = await fresh({ windows: () => ({ code: 1, stdout: tap(3).replace('# pass 3', '# pass 2').replace('# fail 0', '# fail 1'), stderr: '' }) });
  assert.equal(early.status, 'FAIL');
  assert.equal(early.calls.some(c => c.command === 'docker'), false);
  assert.ok(existsSync(join(out(r), 'windows-suite.log')));
  // 이 PC가 정책의 호스트 OS가 아니면 실행하지 않는다.
  assert.match((await fresh({}, { hostOs: 'linux' })).reasons[0], /linux\)에서는 windows 호스트 검사/);
  // 검사 도중 후보가 바뀌면 PASS 영수증을 쓰지 않는다.
  const moved = await fresh({ windows: () => { writeFileSync(join(r.cwd, 'a.txt'), 'moved\n'); return { code: 0, stdout: tap(2), stderr: '' }; } });
  assert.deepEqual([moved.status, moved.reasons], ['BLOCKED', ['검사 도중 후보가 바뀌었다. 후보를 고정한 뒤 다시 발급한다.']]);
});

test('실행 전 거부: 무시되지 않는 output, 조상이 아닌 base, 정책 오류, 회차·heavy 오류', async t => {
  const r = repo(t, { ...policy, output: 'receipts' });
  const f = fake();
  await assert.rejects(issue(r, f), /Git 무시 대상이 아니다: receipts\/qa-1/);
  const ok = repo(t);
  const orphan = ok.git('commit-tree', ok.git('rev-parse', 'HEAD^{tree}'), '-m', 'orphan');
  await assert.rejects(issue(ok, f, { base: orphan }), /조상이 아니다/);
  await assert.rejects(issue(ok, f, { run: '../x' }), /회차 식별자/);
  await assert.rejects(issue(ok, f, { heavy: join(ok.cwd, 'missing-heavy.mjs') }), /heavy/);
  writeFileSync(join(ok.cwd, 'policy/qa-receipt.json'), JSON.stringify({ ...policy, required: [] }));
  await assert.rejects(issue(ok, f), /정책 오류/);
  assert.equal(f.calls.length, 0);
});

test('bin/qa-receipt.mjs는 하네스 밖 checkout에서 origin/main 기준으로 실제 heavy 슬롯을 거쳐 같은 영수증을 발급한다', t => {
  const value = { version: 1, output: 'target/hh-verify/receipts', exempt_pr_max: 0, platforms: { [host]: { runner: 'host' } },
    checks: { version: { result: 'exit', steps: [['node', '--version']] } }, required: [{ checks: ['version'], platforms: [host] }] };
  const r = repo(t, value);
  r.git('update-ref', 'refs/remotes/origin/main', r.base);
  r.git('switch', '-q', '-c', 'outside');
  r.git('commit', '-qam', 'outside change');
  const slots = mkdtempSync(join(tmpdir(), 'hh-qa-slots-'));
  t.after(() => rmSync(slots, { recursive: true, force: true }));
  const env = { ...process.env, HERDR_HEAVY_DIR: join(slots, 'heavy'), HERDR_METRICS_DIR: join(slots, 'metrics') };
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../bin/qa-receipt.mjs', import.meta.url)), '--worktree', r.cwd, ...args],
    { encoding: 'utf8', windowsHide: true, env, timeout: 60000 });
  const passed = cli('--run', 'outside-1');
  assert.equal(passed.status, 0, passed.stderr);
  const summary = JSON.parse(passed.stdout);
  assert.deepEqual([summary.status, summary.base, summary.candidate.count], ['PASS', r.base, 1]);
  const receipt = decodeEnvelope(readFileSync(join(r.cwd, 'target/hh-verify/receipts/outside-1/envelope.txt'), 'utf8'));
  assert.deepEqual([receipt.release, receipt.results[0].state, receipt.environments[host].os], [null, 'passed', host]);
  // 이 PC에서 실행할 수 없는 OS가 정책에 있으면 BLOCKED(exit 3)이고 영수증이 없다.
  const other = host === 'windows' ? 'linux' : 'windows';
  writeFileSync(join(r.cwd, 'blocked.json'), JSON.stringify({ ...value, platforms: { ...value.platforms, [other]: { runner: 'host' } },
    required: [{ checks: ['version'], platforms: [host, other] }] }));
  const blocked = cli('--run', 'outside-2', '--policy', 'blocked.json');
  assert.equal(blocked.status, 3, blocked.stderr);
  assert.match(blocked.stderr, /BLOCKED: .*호스트 검사를 실행할 수 없다/);
  assert.equal(existsSync(join(r.cwd, 'target/hh-verify/receipts/outside-2/envelope.txt')), false);
});
