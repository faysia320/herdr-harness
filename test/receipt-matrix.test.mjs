import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueReceipt } from '../core/qa-receipt-runner.mjs';
const require = createRequire(import.meta.url);
const { loadPolicy } = require('../core/qa-receipt-policy.cjs');
const { publishTree } = require('../core/verification-receipt.cjs');

const root = fileURLToPath(new URL('..', import.meta.url));
const verifier = join(root, 'bin/verify-qa-receipt.mjs');
const gitIn = cwd => (...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status) throw Error(args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
};
// 발급한 envelope를 PR 본문 «남은 검증» 뒤에 넣고, 같은 후보 tree로 만든 게시 커밋을 PR head로 CI 검증기를 실행한다.
function rehearseCi(cwd, out, envelope, base, head, main) {
  const event = join(out, 'ci-event.json');
  writeFileSync(event, JSON.stringify({ action: 'opened', pull_request: { number: 9999, head: { sha: head, ref: 'candidate' }, base: { sha: base, ref: 'main' },
    body: '## 남은 검증\r\n- [ ] hosted-pr (AC5, AC7) | 환경: GitHub Actions | 확인: 두 harness-ci 검사 성공\r\n\r\n' + envelope + '\r\n' } }));
  const started = Date.now();
  const r = spawnSync(process.execPath, [verifier, '--cwd', cwd, '--event', event, '--main', main], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { exit: r.status, ms: Date.now() - started, stdout: r.stdout, stderr: r.stderr };
}

test('행렬 fixture: 두 OS 결과가 모인 영수증을 PR 본문에 넣으면 CI 검증기가 게시 커밋에서 통과시킨다', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'hh-matrix-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = gitIn(cwd);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'matrix'); git('config', 'user.email', 'matrix@example.invalid'); git('config', 'core.autocrlf', 'false');
  const policy = JSON.parse(readFileSync(join(root, 'policy/qa-receipt.json'), 'utf8'));
  mkdirSync(join(cwd, 'policy'));
  writeFileSync(join(cwd, 'policy/qa-receipt.json'), JSON.stringify(policy));
  writeFileSync(join(cwd, '.gitignore'), '/target/hh-verify/\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'feature.txt'), 'candidate\n');
  const tap = 'TAP version 13\n# tests 3\n# suites 0\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 9\n';
  const env = 'HH-QA-ENV ' + JSON.stringify({ os: 'linux', node: 'v22.23.5', git: '2.39.5', prepMs: 1 }) + '\n';
  const exec = async (command, args) => command === 'docker' ? { code: 0, stdout: args[0] === 'version' ? 'linux\n' : '', stderr: '' }
    : { code: 0, stdout: tap, stderr: args[2] === 'docker' ? env : '' };
  const issued = await issueReceipt({ worktree: cwd, base, run: 'matrix-fixture', heavy: join(root, 'bin/heavy.mjs'), hostOs: 'windows', exec });
  assert.equal(issued.status, 'PASS', issued.reasons.join('\n'));
  assert.deepEqual(issued.receipt.results.map(r => r.platform), Object.keys(loadPolicy(join(cwd, 'policy/qa-receipt.json')).platforms));
  git('add', 'feature.txt'); git('commit', '-q', '-m', 'publish');
  const ci = rehearseCi(cwd, issued.out, issued.envelope, base, git('rev-parse', 'HEAD'), base);
  assert.equal(ci.exit, 0, ci.stderr);
  assert.equal(JSON.parse(ci.stdout).status, 'pass');
});

// matrix-live: 독립 QA가 $env:HH_RECEIPT_LIVE_RUN에 QA run token을 넣고 이 파일만 실행할 때 등록한다(heavy로 감싸지 않는다. runner가 OS마다 슬롯을 잡는다).
// 현재 후보(미커밋 포함)를 실제 Windows와 Docker Linux에서 전체 suite로 검사하고, 결과·로그·CI 리허설을
// target/hh-verify/receipts/<token>/에 남긴다. 평소 전체 suite에서는 등록하지 않아 재귀 실행이 없다.
const live = process.env.HH_RECEIPT_LIVE_RUN;
if (live) test('matrix-live: 현재 후보를 실제 Windows·Docker Linux에서 검사하고 발급한 영수증을 로컬 CI 검증기로 확인한다', async () => {
  const git = gitIn(root);
  const base = process.env.HH_RECEIPT_LIVE_BASE ?? git('merge-base', 'refs/remotes/origin/main', 'HEAD');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('HH_RECEIPT_LIVE')));
  const issued = await issueReceipt({ worktree: root, base, run: live, heavy: join(root, 'bin/heavy.mjs'), env });
  assert.equal(issued.status, 'PASS', issued.reasons.join('\n') + '\n' + join(issued.out, 'result.json'));
  const { results, environments } = issued.receipt;
  assert.deepEqual(results.map(r => [r.platform, r.state]), [['windows', 'passed'], ['linux', 'passed']]);
  assert.ok(results.every(r => r.tests > 0 && r.pass === r.tests && r.fail === 0));
  assert.equal(environments.linux.image, loadPolicy(join(root, 'policy/qa-receipt.json')).platforms.linux.image);
  // 발급기의 tree 객체는 임시 저장소와 함께 지워졌으므로 같은 후보를 다시 계산한다.
  const tree = publishTree(root, issued.base);
  assert.equal(tree, issued.tree);
  // 미커밋 후보는 게시 때와 같은 커밋(부모 base, 후보 tree)을 만들어 PR head로 쓴다. 참조가 없는 객체만 생긴다.
  const head = git('commit-tree', tree, '-p', issued.base, '-m', 'matrix-live CI rehearsal');
  const main = (() => { try { return git('rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'); } catch { return issued.base; } })();
  const ci = rehearseCi(root, issued.out, issued.envelope, issued.base, head, main);
  writeFileSync(join(issued.out, 'ci-rehearsal.json'), JSON.stringify({ head, main, ...ci }, null, 2) + '\n');
  assert.equal(ci.exit, 0, ci.stderr);
  assert.ok(ci.ms < 60000);
});

// HH-008: 기준 main에 과정 문서가 커밋된 저장소. 발급기는 B 대비 실제 변경에만 과정 산출물 정책을 적용하고, CI는 실제 게시 커밋을 센다.
// 바뀌지 않은 추적 문서는 양쪽 모두 행을 만들지 않는다. 실제 삭제(D)는 허용이라 양쪽에 남는다. 게시 금지인 수정·신규를 PR에 넣으면 CI가 거부한다(현재 정책 유지).
test('과정 문서가 커밋된 main: 발급기와 CI 검증기가 같은 후보를 세고 과정 문서 삭제·수정·신규는 현재 정책대로 처리한다', async t => {
  const cases = [
    { name: 'unchanged', publish: [], qa: [['A', 'feature.txt']], ci: 'pass' },
    { name: 'deleted', edit: c => rmSync(join(c, 'docs/projects/task/note.md')), publish: ['docs/projects/task/note.md'],
      qa: [['D', 'docs/projects/task/note.md'], ['A', 'feature.txt']], ci: 'pass' },
    { name: 'modified-local', edit: c => writeFileSync(join(c, 'docs/projects/task/note.md'), 'edited\n'), publish: [], qa: [['A', 'feature.txt']], ci: 'pass' },
    { name: 'modified-published', edit: c => writeFileSync(join(c, 'docs/projects/task/note.md'), 'edited\n'), publish: ['docs/projects/task/note.md'],
      qa: [['A', 'feature.txt']], ci: 'fail' },
    { name: 'exempt-modified', edit: c => writeFileSync(join(c, 'docs/projects/kept/note.md'), 'edited\n'), publish: ['docs/projects/kept/note.md'],
      qa: [['A', 'feature.txt'], ['M', 'docs/projects/kept/note.md']], ci: 'pass' },
    { name: 'new-local', edit: c => { mkdirSync(join(c, 'docs/projects/new')); writeFileSync(join(c, 'docs/projects/new/note.md'), 'new\n'); }, publish: [],
      qa: [['A', 'feature.txt']], ci: 'pass' },
    { name: 'new-published', edit: c => { mkdirSync(join(c, 'docs/projects/new')); writeFileSync(join(c, 'docs/projects/new/note.md'), 'new\n'); },
      publish: ['docs/projects/new/note.md'], qa: [['A', 'feature.txt']], ci: 'fail' },
  ];
  const temp = mkdtempSync(join(tmpdir(), 'hh-process-docs-'));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const policy = { version: 1, output: 'target/qa', exempt_pr_max: 0, platforms: { windows: { runner: 'host' } },
    checks: { version: { result: 'exit', steps: [['node', '--version']] } }, required: [{ platforms: ['windows'], checks: ['version'] }] };
  const exec = async () => ({ code: 0, stdout: '', stderr: '' });
  for (const c of cases) {
    const cwd = join(temp, c.name);
    mkdirSync(join(cwd, 'policy'), { recursive: true });
    const git = gitIn(cwd);
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'docs'); git('config', 'user.email', 'docs@example.invalid'); git('config', 'core.autocrlf', 'false');
    writeFileSync(join(cwd, '.gitignore'), '/target/\n');
    writeFileSync(join(cwd, 'policy/qa-receipt.json'), JSON.stringify(policy));
    mkdirSync(join(cwd, '.agents/harness'), { recursive: true });
    writeFileSync(join(cwd, '.agents/harness/config.json'), JSON.stringify({ process_artifacts: { paths: ['docs/projects/{slug}/'],
      exempt: [{ path: 'docs/projects/kept/', reason: 'fixture' }] } }));
    for (const dir of ['task', 'kept', 'other']) {
      mkdirSync(join(cwd, 'docs/projects', dir), { recursive: true });
      writeFileSync(join(cwd, 'docs/projects', dir, 'note.md'), 'original\n');
    }
    git('add', '-A'); git('commit', '-q', '-m', 'base with committed process docs');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-q', '-c', 'candidate');
    writeFileSync(join(cwd, 'feature.txt'), 'change\n');
    c.edit?.(cwd);
    const issued = await issueReceipt({ worktree: cwd, base, run: c.name, heavy: join(root, 'bin/heavy.mjs'), hostOs: 'windows', exec });
    assert.equal(issued.status, 'PASS', c.name + ': ' + issued.reasons.join('\n'));
    const tree = publishTree(cwd, base);
    assert.equal(tree, issued.tree, c.name);
    const rows = git('diff', '--name-status', '--no-renames', base, tree).split('\n').map(line => line.split('\t'));
    assert.deepEqual(rows.sort(), c.qa.sort(), c.name);
    assert.equal(issued.candidate.count, c.qa.length, c.name);
    // 실제 게시: 기능 파일과 이 사례가 게시하는 과정 문서만 커밋한다. 나머지 로컬 편집은 작업 사본에 남는다.
    git('add', '--', 'feature.txt', ...c.publish); git('commit', '-q', '-m', 'publish');
    const ci = rehearseCi(cwd, issued.out, issued.envelope, base, git('rev-parse', 'HEAD'), base);
    const verdict = JSON.parse(ci.stdout);
    assert.equal(verdict.status, c.ci, c.name + ': ' + ci.stderr);
    assert.equal(ci.exit, c.ci === 'pass' ? 0 : 1, c.name);
    if (c.ci === 'pass') assert.deepEqual(verdict.candidate, issued.candidate, c.name);
    else assert.match(ci.stderr, /후보 지문 불일치/, c.name);
  }
});
