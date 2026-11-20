import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueReceipt } from '../core/qa-receipt-runner.mjs';
const { loadPolicy } = createRequire(import.meta.url)('../core/qa-receipt-policy.cjs');

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
  // 미커밋 후보는 게시 때와 같은 커밋(부모 base, 후보 tree)을 만들어 PR head로 쓴다. 참조가 없는 객체만 생긴다.
  const head = git('commit-tree', issued.tree, '-p', issued.base, '-m', 'matrix-live CI rehearsal');
  const main = (() => { try { return git('rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'); } catch { return issued.base; } })();
  const ci = rehearseCi(root, issued.out, issued.envelope, issued.base, head, main);
  writeFileSync(join(issued.out, 'ci-rehearsal.json'), JSON.stringify({ head, main, ...ci }, null, 2) + '\n');
  assert.equal(ci.exit, 0, ci.stderr);
  assert.ok(ci.ms < 60000);
});
