import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const { candidateBinding, encodeEnvelope } = createRequire(import.meta.url)('../core/qa-receipt-policy.cjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const image = 'docker.io/library/node@sha256:' + 'd'.repeat(64);
const steps = [['node', '--test', '--test-reporter=tap']];
const policy = { version: 1, output: 'target/hh-verify/receipts', exempt_pr_max: 7,
  platforms: { windows: { runner: 'host' }, linux: { runner: 'docker', image } },
  checks: { suite: { result: 'tap', steps } }, required: [{ checks: ['suite'], platforms: ['windows', 'linux'] }] };

// PR 이벤트·actions/checkout(merge 커밋, fetch-depth 0)을 실제 Git으로 재현한다. 검증기는 release 없이 세 파일만 복사해 실행한다.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-receipt-ci-')), cwd = join(dir, 'repo'), tools = join(dir, 'tools');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const file of ['bin/verify-qa-receipt.mjs', 'core/qa-receipt-policy.cjs', 'core/dev14.cjs']) {
    mkdirSync(dirname(join(tools, file)), { recursive: true });
    cpSync(join(root, file), join(tools, file));
  }
  mkdirSync(join(cwd, 'policy'), { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status) throw Error(args.join(' ') + ': ' + r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'ci'); git('config', 'user.email', 'ci@example.invalid'); git('config', 'core.autocrlf', 'false');
  const write = (file, text) => { mkdirSync(dirname(join(cwd, file)), { recursive: true }); writeFileSync(join(cwd, file), text); };
  write('policy/qa-receipt.json', JSON.stringify(policy));
  write('app.txt', 'base\n'); write('shared.txt', 'shared\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const B = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'topic');
  write('app.txt', 'candidate\n'); write('feature/new.txt', 'new\n');
  git('add', '-A'); git('commit', '-q', '-m', 'candidate');
  const H0 = git('rev-parse', 'HEAD');
  const binding = candidateBinding((...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return r.stdout.includes('\0') ? r.stdout : r.stdout.trim(); }, B, B, H0);
  const result = platform => ({ platform, check: 'suite', steps, state: 'passed', exit: 0, tests: 9, pass: 9, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  const receipt = { kind: 'herdr-qa-receipt', version: 2, run: 'qa-run', round: 1, runner: { id: 'herdr-qa-receipt', version: 1 }, release: null,
    base: B, candidate: { digest: binding.digest, count: binding.count }, environments: {
      windows: { os: 'windows', node: 'v24.11.1', git: '2.53.0' }, linux: { os: 'linux', node: 'v22.23.5', git: '2.39.5', image } },
    results: [result('windows'), result('linux')] };
  const body = r => '## 남은 검증\r\n- [ ] hosted-pr (AC5) | 환경: GitHub | 확인: 두 검사 성공\r\n\r\n' + encodeEnvelope(r) + '\r\n';
  const advance = (file, text) => {
    git('switch', '-q', 'main'); write(file, text); git('add', '-A'); git('commit', '-q', '-m', 'main ' + file); git('switch', '-q', 'topic');
    return git('rev-parse', 'main');
  };
  const sync = main => { git('merge', '-q', '--no-edit', main); return git('rev-parse', 'HEAD'); };
  // actions/checkout 기본 ref: main과 PR head를 부모로 하는 merge 커밋을 detach로 꺼낸다.
  const checkout = (head, main = git('rev-parse', 'main')) => {
    const merge = git('commit-tree', git('merge-tree', '--write-tree', main, head), '-p', main, '-p', head, '-m', 'merge ref');
    git('checkout', '-q', '--detach', merge);
  };
  const verify = ({ number = 12, head = git('rev-parse', 'topic'), text = body(receipt), base = B, args = [] } = {}) => {
    const event = join(dir, 'event.json');
    writeFileSync(event, JSON.stringify({ action: 'synchronize', pull_request: { number, body: text, head: { sha: head, ref: 'topic' }, base: { sha: base, ref: 'main' } } }));
    const started = Date.now();
    const r = spawnSync(process.execPath, [join(tools, 'bin/verify-qa-receipt.mjs'), '--cwd', cwd, '--event', event, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, GITHUB_EVENT_PATH: '' } });
    const ms = Date.now() - started;
    assert.ok(ms < 60000, 'CI 검증은 60초 안에 끝나야 한다: ' + ms);
    return { ...r, ms, json: r.stdout ? JSON.parse(r.stdout) : null };
  };
  return { cwd, git, write, B, H0, receipt, body, advance, sync, checkout, verify };
}

test('CI 검증: PR 본문 영수증·후보 지문·검사 목록이 맞으면 release 없이 60초 안에 통과한다', t => {
  const f = fixture(t);
  f.checkout(f.H0);
  const ok = f.verify();
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([ok.json.status, ok.json.pr, ok.json.head, ok.json.base, ok.json.candidate.count, ok.json.run], ['pass', 12, f.H0, f.B, 2, 'qa-run']);
  assert.ok(ok.json.ms < 60000);
  // 독립 main 변경을 PR에 두 번 동기화하고 payload base.sha가 낡아도 merge 커밋의 첫 부모(실제 main)로 비교한다.
  f.git('switch', '-q', 'topic');
  f.sync(f.advance('docs/one.md', 'one\n'));
  const second = f.sync(f.advance('docs/two.md', 'two\n'));
  f.checkout(second);
  const synced = f.verify({ head: second });
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(synced.json.main, f.git('rev-parse', 'main'));
  // merge 커밋이 아닌 checkout은 origin/<base.ref>, 그다음 이벤트 base.sha로 비교한다.
  f.git('checkout', '-q', '--detach', second);
  f.git('update-ref', 'refs/remotes/origin/main', f.git('rev-parse', 'main'));
  assert.equal(f.verify({ head: second }).status, 0);
  assert.equal(f.verify({ head: second, args: ['--main', f.git('rev-parse', 'main')] }).status, 0);
});

test('CI 검증 거부: 영수증 없음·변조·후보 불일치·검사 누락·main의 후보 경로 변경', t => {
  const f = fixture(t);
  f.checkout(f.H0);
  const rejected = (input, pattern) => {
    const r = f.verify(input);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, pattern);
    assert.match(r.stderr, /같은 runner\(node bin\/qa-receipt\.mjs\)|검증 실패/);
  };
  rejected({ text: '## 남은 검증\n- [ ] x\n' }, /QA 실행 영수증\(herdr-qa-receipt:v2\)이 없다/);
  rejected({ text: null }, /없다/);
  rejected({ text: f.body(f.receipt) + f.body(f.receipt) }, /여러 개/);
  rejected({ text: f.body(f.receipt).replace(/v2 ([A-Za-z0-9_-]{20})/, 'v2 $1@@') }, /형식이 다르다/);
  rejected({ text: f.body({ ...f.receipt, candidate: { ...f.receipt.candidate, digest: '0'.repeat(64) } }) }, /후보 지문 불일치/);
  rejected({ text: f.body({ ...f.receipt, version: 1 }) }, /v2 형식이 아니다/);
  rejected({ text: f.body({ ...f.receipt, results: f.receipt.results.slice(0, 1) }) }, /필수 검사 결과 없음: linux\/suite/);
  rejected({ text: f.body({ ...f.receipt, results: [f.receipt.results[0], { ...f.receipt.results[1], state: 'failed', exit: 1 }] }) }, /통과하지 않은 검사: linux\/suite/);
  rejected({ text: f.body({ ...f.receipt, environments: { windows: f.receipt.environments.windows } }) }, /실행 환경 기록 없음·불일치: linux/);
  const unrelated = f.git('commit-tree', f.git('rev-parse', f.B + '^{tree}'), '-m', 'unrelated');
  rejected({ text: f.body({ ...f.receipt, base: unrelated }) }, /조상이 아니다/);
  rejected({ number: 'x' }, /PR 번호·head가 없다/);
  // QA 뒤 PR에 커밋을 더하면 후보가 바뀐다.
  f.git('switch', '-q', 'topic');
  f.write('feature/late.txt', 'late\n');
  f.git('add', '-A'); f.git('commit', '-q', '-m', 'late');
  const late = f.git('rev-parse', 'HEAD');
  f.checkout(late);
  rejected({ head: late }, /후보 지문 불일치\(영수증 2개 경로, PR 3개 경로\)/);
  // main이 후보 경로를 바꾼 뒤 동기화하면 무효다.
  f.git('switch', '-q', 'topic');
  f.git('reset', '-q', '--hard', f.H0);
  const main = f.advance('app.txt', 'upstream\n');
  const merged = f.git('commit-tree', f.git('rev-parse', f.H0 + '^{tree}'), '-p', f.H0, '-p', main, '-m', 'sync keeping candidate');
  f.checkout(merged);
  rejected({ head: merged }, /후보 지문 불일치/);
});

test('도입 전 PR은 번호 기준으로 영수증만 면제하고, 정책 파일 검사는 면제하지 않는다', t => {
  const f = fixture(t);
  f.checkout(f.H0);
  const exempt = f.verify({ number: 7, text: '' });
  assert.equal(exempt.status, 0, exempt.stderr);
  assert.equal(exempt.json.status, 'exempt');
  assert.match(exempt.stderr, /도입 전 PR/);
  assert.equal(f.verify({ number: 8, text: '' }).status, 1);
  f.write('policy/qa-receipt.json', JSON.stringify({ ...policy, required: [] }));
  const broken = f.verify({ number: 7, text: '' });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /정책 오류/);
});

test('CI 검증 OR 정책: anyPlatform 규칙은 한 OS 결과만으로 통과하고 결과가 없으면 거부한다', t => {
  const f = fixture(t);
  f.checkout(f.H0);
  // 정책은 PR merge checkout의 작업 파일에서 읽는다. 후보 지문은 Git 커밋으로 계산하므로 영향이 없다.
  f.write('policy/qa-receipt.json', JSON.stringify({ ...policy, platforms: { windows: { runner: 'host' }, linux: { runner: 'host' } },
    required: [{ checks: ['suite'], platforms: ['windows', 'linux'], anyPlatform: true }] }));
  const linux = { os: 'linux', node: 'v22.23.5', git: '2.39.5' };
  for (const [results, environments] of [[[f.receipt.results[0]], { windows: f.receipt.environments.windows }], [[f.receipt.results[1]], { linux }]]) {
    const ok = f.verify({ text: f.body({ ...f.receipt, results, environments }) });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.json.status, 'pass');
  }
  const none = f.verify({ text: f.body({ ...f.receipt, results: [] }) });
  assert.equal(none.status, 1, none.stdout);
  assert.match(none.stderr, /플랫폼 하나\(windows\|linux\)에서 suite 통과 필요/);
});

test('HH workflow: 두 필수 검사 이름을 유지하고 PR 이벤트(본문 수정 포함)에서 영수증 검증만 실행한다', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /name: harness-ci \(\$\{\{ matrix\.os \}\}\)/);
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, edited\]/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /- run: node bin\/verify-qa-receipt\.mjs\r?\n/);
  // main push·nightly 사후 검사, 전체 시험 폴백, 경로 필터·job skip이 없다.
  for (const forbidden of [/^\s*push:/m, /schedule:/, /npm test/, /node --test/, /paths(?:-ignore)?:/, /^\s*if:/m, /concurrency:/]) assert.doesNotMatch(workflow, forbidden);
});
