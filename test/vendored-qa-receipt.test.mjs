import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueReceipt } from '../core/qa-receipt-runner.mjs';
const { encodeEnvelope, verifyResults } = createRequire(import.meta.url)('../core/qa-receipt-policy.cjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const host = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform];
const other = host === 'windows' ? 'linux' : 'windows';
const image = 'docker.io/library/node@sha256:' + 'e'.repeat(64);
const smoke = { result: 'exit', steps: [['node', '--version']] };
const orPolicy = platforms => ({ version: 1, output: 'target/receipts', exempt_pr_max: 0, platforms, checks: { smoke },
  required: [{ checks: ['smoke'], platforms: Object.keys(platforms), anyPlatform: true }] });
const env = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));

function repo(t, policy, { vendor = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-vendored-')), cwd = join(dir, 'repo');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(join(cwd, 'policy'), { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status) throw Error(args.join(' ') + ': ' + r.stderr);
    return r.stdout.trim();
  };
  const write = (file, text) => { mkdirSync(dirname(join(cwd, file)), { recursive: true }); writeFileSync(join(cwd, file), text); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'vendor'); git('config', 'user.email', 'vendor@example.invalid'); git('config', 'core.autocrlf', 'false');
  // 소비 저장소는 CommonJS이고 하네스가 설치되지 않았다. 공통 목록의 파일만 상대 위치를 유지해 tools/hh에 복사한다.
  write('package.json', JSON.stringify({ name: 'consumer', private: true, type: 'commonjs' }));
  write('.gitignore', 'target/\n');
  write('policy/qa-receipt.json', JSON.stringify(policy));
  write('app.txt', 'base\n');
  if (vendor) for (const file of JSON.parse(readFileSync(join(root, 'policy/qa-receipt-files.json'), 'utf8')).files) {
    mkdirSync(dirname(join(cwd, 'tools/hh', file)), { recursive: true });
    cpSync(join(root, file), join(cwd, 'tools/hh', file));
  }
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  write('app.txt', 'candidate\n');
  git('add', '-A'); git('commit', '-q', '-m', 'candidate');
  return { dir, cwd, git, write, base, head: git('rev-parse', 'HEAD') };
}

test('사본 목록: 발급기·검증기와 그 의존이 모두 들어 있고 서로 상대 import만 쓴다', () => {
  const { files } = JSON.parse(readFileSync(join(root, 'policy/qa-receipt-files.json'), 'utf8'));
  for (const file of ['bin/qa-receipt.mjs', 'bin/verify-qa-receipt.mjs', 'bin/heavy.mjs', 'core/qa-receipt-runner.mjs', 'core/qa-receipt-policy.cjs',
    'core/process.js', 'core/verification-receipt.cjs', 'core/dev14.cjs', 'package.json']) assert.ok(files.includes(file), file);
  // 목록 파일이 상대 경로로 부르는 파일은 모두 목록에 있다.
  for (const file of files.filter(f => /\.(mjs|cjs|js)$/.test(f))) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [, ref] of text.matchAll(/(?:from |require\(|join\([^)]*?)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = join(dirname(file), ref).replaceAll('\\', '/');
      assert.ok(files.includes(target), `${file} → ${target}`);
    }
  }
});

test('release 없는 발급: 사본 CLI가 OR 정책에서 이 PC host만 실행해 영수증을 내고, 사본 검증기가 PR을 통과·거부한다', t => {
  // 소비 저장소 정책이 검사별 timeout_ms를 지정해도 사본 발급기·검증기가 그대로 받는다.
  const timed = { ...orPolicy({ windows: { runner: 'host' }, linux: { runner: 'host' } }), checks: { smoke: { ...smoke, timeout_ms: 600000 } } };
  const r = repo(t, timed, { vendor: true });
  const slots = join(r.dir, 'slots');
  const run = (script, args) => spawnSync(process.execPath, [join(r.cwd, 'tools/hh/bin', script), ...args],
    { cwd: r.cwd, encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: { ...env(), HERDR_HEAVY_DIR: join(slots, 'heavy'), HERDR_METRICS_DIR: join(slots, 'metrics'), GITHUB_EVENT_PATH: '' } });
  const issued = run('qa-receipt.mjs', ['--base', r.base, '--run', 'local']);
  assert.equal(issued.status, 0, issued.stderr);
  const out = join(r.cwd, 'target/receipts/local');
  const receipt = JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
  assert.equal(receipt.release, null);
  assert.deepEqual(receipt.results.map(x => [x.platform, x.check, x.state]), [[host, 'smoke', 'passed']]);
  assert.deepEqual(Object.keys(receipt.environments), [host]);
  const verify = body => {
    const event = join(r.dir, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { number: 1, body, head: { sha: r.head, ref: 'topic' }, base: { sha: r.base, ref: 'main' } } }));
    return run('verify-qa-receipt.mjs', ['--main', r.base, '--event', event]);
  };
  const envelope = readFileSync(join(out, 'envelope.txt'), 'utf8');
  const ok = verify('## 남은 검증\n- 없음\n\n' + envelope);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).status, 'pass');
  const empty = verify(encodeEnvelope({ ...receipt, results: [] }) + '\n');
  assert.equal(empty.status, 1, empty.stdout);
  assert.match(empty.stderr, /플랫폼 하나\(windows\|linux\)에서 smoke 통과 필요/);
  // AND 정책은 이 PC가 아닌 OS의 host 실행을 요구하므로 영수증 없이 BLOCKED(exit 3)다.
  r.write('policy/qa-receipt.json', JSON.stringify({ ...orPolicy({ windows: { runner: 'host' }, linux: { runner: 'host' } }),
    required: [{ checks: ['smoke'], platforms: ['windows', 'linux'] }] }));
  const blocked = run('qa-receipt.mjs', ['--base', r.base, '--run', 'and']);
  assert.equal(blocked.status, 3, blocked.stderr);
  assert.match(blocked.stderr, new RegExp(`BLOCKED: ${other}/smoke`));
  assert.equal(existsSync(join(r.cwd, 'target/receipts/and/receipt.json')), false);  // 잘못된 timeout_ms는 사본 발급기도 정책 오류로 거부한다.
  r.write('policy/qa-receipt.json', JSON.stringify({ ...timed, checks: { smoke: { ...smoke, timeout_ms: 0 } } }));
  const invalid = run('qa-receipt.mjs', ['--base', r.base, '--run', 'bad']);
  assert.notEqual(invalid.status, 0, invalid.stderr);
  assert.match(invalid.stderr, /timeout_ms/);
});

// heavy·docker 호출만 흉내 내고 Git 후보 계산과 파일 쓰기는 실제로 한다.
function fake() {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'docker') return { code: 0, stdout: args[0] === 'version' ? 'linux\n' : '', stderr: '' };
    if (args[2] === 'docker') return { code: 0, stdout: 'v22.23.5\n', stderr: 'HH-QA-ENV ' + JSON.stringify({ os: 'linux', node: 'v22.23.5', git: '2.39.5', prepMs: 1 }) + '\n' };
    return { code: 0, stdout: 'v24.11.1\n', stderr: '' };
  };
  return { exec, calls };
}
const heavy = join(root, 'bin/heavy.mjs');

test('OR 발급 선택: AND가 요구한 플랫폼, 이 PC host, Docker Linux 순으로 하나만 실행하고 실행할 곳이 없으면 BLOCKED', async t => {
  const cases = [
    [{ windows: { runner: 'host' }, linux: { runner: 'host' } }, 'windows', ['windows']],
    [{ windows: { runner: 'host' }, linux: { runner: 'host' } }, 'linux', ['linux']],
    [{ windows: { runner: 'host' }, linux: { runner: 'docker', image } }, 'windows', ['windows']],
    [{ windows: { runner: 'host' }, linux: { runner: 'docker', image } }, 'linux', ['linux']],
    [{ windows: { runner: 'host' }, linux: { runner: 'docker', image } }, 'macos', ['linux']],
  ];
  // 정책은 작업 파일에서 읽으므로 저장소 하나에서 정책만 바꿔 가며 발급한다.
  const r = repo(t, orPolicy(cases[0][0]));
  const issue = (policy, hostOs, f) => { r.write('policy/qa-receipt.json', JSON.stringify(policy));
    return issueReceipt({ worktree: r.cwd, base: r.base, run: 'pick', heavy, hostOs, exec: f.exec, env: env() }); };
  for (const [platforms, hostOs, expected] of cases) {
    const f = fake();
    const result = await issue(orPolicy(platforms), hostOs, f);
    assert.equal(result.status, 'PASS', hostOs + ' ' + result.reasons);
    assert.deepEqual(result.receipt.results.map(x => x.platform), expected, hostOs);
    assert.equal(f.calls.some(c => c.includes(' docker run ')), platforms.linux.runner === 'docker' && expected[0] === 'linux');
    assert.deepEqual(verifyResults(result.receipt, orPolicy(platforms), ['policy/qa-receipt.json']), []);
  }
  const f = fake();
  const blocked = await issue(orPolicy({ windows: { runner: 'host' }, linux: { runner: 'host' } }), 'macos', f);
  assert.equal(blocked.status, 'BLOCKED');
  assert.match(blocked.reasons.join('\n'), /이 PC\(macos\)에서 실행할 수 있는 플랫폼이 없다\(windows\|linux 중 하나/);
  assert.deepEqual(f.calls, []);
  assert.equal(blocked.receipt, undefined);
  // 걸린 AND 규칙이 Docker Linux를 요구하면 OR 규칙도 그 플랫폼을 써서 같은 OS×검사를 한 번만 실행한다.
  const both = orPolicy({ windows: { runner: 'host' }, linux: { runner: 'docker', image } });
  both.required.push({ checks: ['smoke'], platforms: ['linux'] });
  const g = fake();
  const result = await issue(both, 'windows', g);
  assert.equal(result.status, 'PASS', result.reasons.join('\n'));
  assert.deepEqual(result.receipt.results.map(x => x.platform), ['linux']);
  assert.equal(g.calls.filter(c => c.includes(' docker run ')).length, 1);
});
