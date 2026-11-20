import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { build } from '../scripts/build.mjs';
import { run } from '../core/process.js';
const require = createRequire(import.meta.url);
const { cleanup } = require('../core/worktree-cleanup.cjs');
const policy = require('../core/artifact-policy.cjs');
const { candidateTree } = require('../core/verification-receipt.cjs');
const { worktreeCleanup, hash } = require('../adapters/runtime.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'herdr-cleanup-fixture-'));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = join(temp, 'repo'), state = join(root, '.local/state'), dir = join(root, '.local/worktrees');
  mkdirSync(state, { recursive: true });
  mkdirSync(dir, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'cleanup fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.local/\ndist/\n/target/hh-verify/\n.env*\n');
  writeFileSync(join(root, 'a.txt'), 'base\n');
  writeFileSync(join(root, 'gone.txt'), 'delete me\n');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 255, 13, 10]));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return { temp, root, state, dir, base: git(root, 'rev-parse', 'HEAD') };
}
function checkout(f, name) {
  const worktree = join(f.dir, name), branch = 'hh/' + name;
  git(f.root, 'worktree', 'add', '-q', '-b', branch, worktree, f.base);
  return { worktree, branch };
}
const input = (f, w, extra = {}) => ({ id: 'HH-7', state: 'DONE', root: f.root, worktreeDir: f.dir, worktree: w.worktree, branch: w.branch,
  stateDir: f.state, activity: { current: false, runs: [] }, ignored: { keep: ['target/hh-verify/'], discard: ['dist/'] },
  retry: 'node launch.mjs cleanup-worktree HH-7', at: '2026-11-20T00:00:00.000Z', ...extra });
function commitIn(w, file, text) {
  writeFileSync(join(w.worktree, file), text);
  git(w.worktree, 'add', '--', file);
  git(w.worktree, 'commit', '-q', '-m', 'candidate ' + file);
  return git(w.worktree, 'rev-parse', 'HEAD');
}
function outputs(w) {
  mkdirSync(join(w.worktree, 'dist'), { recursive: true });
  mkdirSync(join(w.worktree, 'target/hh-verify'), { recursive: true });
  writeFileSync(join(w.worktree, 'dist/out.js'), 'generated\n');
  writeFileSync(join(w.worktree, 'target/hh-verify/latest-qa.json'), '{"qa":"receipt"}\n');
}
// 파일 바이트·링크 대상·index·등록·ref 전부. 거부 전후가 같아야 한다. 링크·junction은 따라가지 않는다.
function snapshot(f, w) {
  const files = {};
  const walk = (dir, rel = '') => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const name = rel + e.name;
      if (e.isSymbolicLink()) files[name] = 'link ' + readlinkSync(join(dir, e.name));
      else if (e.isDirectory()) walk(join(dir, e.name), name + '/');
      else files[name] = sha(readFileSync(join(dir, e.name)));
    }
  };
  walk(w.worktree);
  return { files, list: git(f.root, 'worktree', 'list', '--porcelain'), refs: git(f.root, 'for-each-ref', '--format=%(refname) %(objectname)'),
    status: existsSync(w.worktree) ? git(w.worktree, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored') : null };
}
const refExists = (f, branch) => { try { git(f.root, 'rev-parse', '--verify', '-q', 'refs/heads/' + branch); return true; } catch { return false; } };

test('병합 증명 업무: 무시된 영수증을 보관하고 worktree와 squash 뒤 남은 업무 브랜치를 지우며 재실행은 같은 결과다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-squash');
  const head = commitIn(w, 'a.txt', 'merged change\n');
  outputs(w);
  git(f.root, 'merge', '--squash', '-q', w.branch);
  git(f.root, 'commit', '-q', '-m', 'squash');
  const proof = { head, original: null, branch: w.branch };
  const first = cleanup(input(f, w, { kind: 'merged', proof }));
  assert.equal(first.status, 'done', first.reasons.join('\n'));
  assert.equal(existsSync(w.worktree), false);
  assert.doesNotMatch(git(f.root, 'worktree', 'list', '--porcelain'), /hh-7-squash/);
  // upstream이 없는 squash 브랜치는 -d가 거부하고, 증명된 tip·이름·사용처·제거 완료를 다시 확인한 뒤 -D로 지운다.
  assert.deepEqual([first.branch.state, first.branch.method, first.branch.tip], ['deleted', '-D', head]);
  assert.match(first.branch.refused, /not fully merged|병합/);
  assert.equal(refExists(f, w.branch), false);
  assert.equal(first.preserved.declared, false);
  assert.deepEqual(Object.keys(first.preserved.files), ['target/hh-verify/latest-qa.json']);
  const kept = join(f.state, first.preserved.dir, 'target/hh-verify/latest-qa.json');
  assert.equal(readFileSync(kept, 'utf8'), '{"qa":"receipt"}\n');
  assert.equal(first.preserved.files['target/hh-verify/latest-qa.json'], sha(readFileSync(kept)));
  assert.equal(first.patch, null);
  assert.equal(first.retry, null);
  const journal = readFileSync(join(f.state, first.journal));
  // 같은 입력의 재실행은 새 삭제·기록 없이 같은 결과를 돌려준다.
  const again = cleanup(input(f, w, { kind: 'merged', proof, at: '2026-11-21T00:00:00.000Z' }));
  assert.deepEqual(again, first);
  assert.deepEqual(readFileSync(join(f.state, first.journal)), journal);
});

test('선언한 과정 문서는 재보관해 지문을 확인한 뒤 지우고, 선언 밖 미추적 파일은 거부한다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-docs');
  const head = commitIn(w, 'a.txt', 'merged\n');
  mkdirSync(join(w.worktree, 'docs/projects/x'), { recursive: true });
  writeFileSync(join(w.worktree, 'docs/projects/x/README.md'), '- 조사: 완료\n');
  const artifacts = { config: { process_artifacts: { paths: ['docs/projects/{slug}/'] } }, vars: { slug: 'x' } };
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch }, artifacts });
  mkdirSync(join(w.worktree, 'docs/projects/y'), { recursive: true });
  writeFileSync(join(w.worktree, 'docs/projects/y/README.md'), 'other task\n');
  const before = snapshot(f, w);
  const refused = cleanup(value);
  assert.match(refused.reasons.join('\n'), /미추적 docs\/projects\/y\/README\.md/);
  assert.deepEqual(snapshot(f, w), before);
  rmSync(join(w.worktree, 'docs/projects/y'), { recursive: true });
  const done = cleanup(value);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.equal(done.preserved.declared, true);
  assert.deepEqual(Object.keys(done.preserved.files), ['docs/projects/x/README.md']);
  assert.equal(readFileSync(join(f.state, done.preserved.dir, 'docs/projects/x/README.md'), 'utf8'), '- 조사: 완료\n');
  const manifest = JSON.parse(readFileSync(join(f.state, done.preserved.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files['docs/projects/x/README.md'], done.preserved.files['docs/projects/x/README.md']);
  assert.equal(existsSync(w.worktree), false);
});

test('일반 병합은 -d로 지우고, 원격 동기화로 PR head가 앞선 증명은 로컬 tip이 최초 게시 anchor여도 일치로 본다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-sync');
  const anchor = commitIn(w, 'a.txt', 'anchor\n');
  git(f.root, 'merge', '--ff-only', '-q', w.branch);
  const synced = git(f.root, 'commit-tree', git(f.root, 'rev-parse', anchor + '^{tree}'), '-p', anchor, '-m', 'sync main');
  const result = cleanup(input(f, w, { kind: 'merged', proof: { head: synced, original: anchor, branch: w.branch } }));
  assert.equal(result.status, 'done', result.reasons.join('\n'));
  assert.deepEqual([result.branch.state, result.branch.method, result.branch.tip], ['deleted', '-d', anchor]);
  assert.equal(result.branch.refused, undefined);
});

test('예외 종결 업무: 미커밋 후보를 binary patch로 보존하고 기준 HEAD에 적용하면 같은 tree이며 브랜치는 남긴다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-closed');
  writeFileSync(join(w.worktree, 'a.txt'), 'candidate\n');
  rmSync(join(w.worktree, 'gone.txt'));
  writeFileSync(join(w.worktree, 'bin.dat'), Buffer.from([255, 0, 9, 13, 13, 10, 0]));
  mkdirSync(join(w.worktree, 'new/deep'), { recursive: true });
  writeFileSync(join(w.worktree, 'new/deep/n.txt'), 'new file\n');
  writeFileSync(join(w.worktree, 'staged.txt'), 'staged\n');
  git(w.worktree, 'add', '--', 'staged.txt');
  outputs(w);
  const paths = ['a.txt', 'bin.dat', 'gone.txt', 'new/deep/n.txt', 'staged.txt'];
  const candidate = { head: f.base, tree: candidateTree(w.worktree), paths: paths.map(path => ({ path })) };
  const first = cleanup(input(f, w, { kind: 'closed', candidate }));
  assert.equal(first.status, 'done', first.reasons.join('\n'));
  assert.equal(existsSync(w.worktree), false);
  assert.deepEqual(first.branch, { name: w.branch, state: 'kept', reason: '정책 예외 종결 업무의 브랜치는 보존한다.' });
  assert.equal(git(f.root, 'rev-parse', 'refs/heads/' + w.branch), f.base);
  assert.deepEqual([...first.patch.paths].sort(), paths);
  assert.equal(first.patch.head, f.base);
  assert.equal(first.patch.tree, candidate.tree);
  assert.match(first.patch.file, /^tasks\/HH-7\/worktree-[0-9a-f]{12}\.patch$/);
  const patchFile = join(f.state, ...first.patch.file.split('/'));
  assert.equal(sha(readFileSync(patchFile)), first.patch.sha256);
  // 저장한 patch만으로 기준 HEAD 위에 같은 후보 tree를 복원한다.
  const index = join(f.temp, 'restore.index'), env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync('git', ['read-tree', f.base], { cwd: f.root, env });
  execFileSync('git', ['apply', '--cached', '--binary', patchFile], { cwd: f.root, env });
  assert.equal(execFileSync('git', ['write-tree'], { cwd: f.root, env, encoding: 'utf8' }).trim(), candidate.tree);
  const again = cleanup(input(f, w, { kind: 'closed', candidate }));
  assert.deepEqual(again, first);
});

test('살아 있는 위임·조회 실패·예상 밖 파일·경계·잠금·중첩·증명 불일치는 아무것도 지우지 않고 이유와 재시도 명령을 돌려준다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-refuse');
  const head = commitIn(w, 'a.txt', 'merged change\n');
  outputs(w);
  const proof = { head, original: null, branch: w.branch };
  const base = input(f, w, { kind: 'merged', proof });
  const refused = (change, pattern, undo = () => {}) => {
    const value = structuredClone(base);
    const extra = change(value) ?? value;
    const before = snapshot(f, w);
    const result = cleanup(extra);
    assert.equal(result.status, 'refused', pattern.source);
    assert.match(result.reasons.join('\n'), pattern);
    assert.equal(result.retry, base.retry);
    assert.ok(result.remaining.includes(extra.worktree));
    assert.ok(result.remaining.includes('refs/heads/' + extra.branch));
    assert.deepEqual(snapshot(f, w), before);
    assert.equal(existsSync(join(f.state, 'tasks/HH-7/cleanup.json')), false);
    undo();
  };
  refused(v => { v.activity.runs = [{ token: 'r1', status: 'ended', address: 't9', state: 'live', run: 'r1' }]; }, /살아 있는 위임 터미널.*t9/);
  refused(v => { v.activity.runs = [{ token: 'r1', status: 'ended', address: 't9', state: 'live', run: null }]; }, /살아 있는 위임 터미널/);
  refused(v => { v.activity.runs = [{ token: 'r1', status: 'ended', address: 't9', state: 'unknown', error: 'hc down' }]; }, /확인하지 못했다.*hc down/);
  refused(v => { v.activity = { current: true, runs: [] }; }, /실행 중인 회차/);
  refused(v => { v.activity.runs = [{ token: 'r2', status: 'running', address: null, state: 'absent' }]; }, /실행 중인 회차/);
  refused(v => { delete v.activity; }, /조회 결과가 없다/);
  writeFileSync(join(w.worktree, 'stray.txt'), 'unexpected\n');
  refused(() => {}, /미추적 stray\.txt/, () => unlinkSync(join(w.worktree, 'stray.txt')));
  writeFileSync(join(w.worktree, '.env.local'), 'SECRET=1\n');
  refused(() => {}, /무시됨 \.env\.local/, () => unlinkSync(join(w.worktree, '.env.local')));
  writeFileSync(join(w.worktree, 'a.txt'), 'uncommitted\n');
  refused(() => {}, /변경 a\.txt/, () => git(w.worktree, 'checkout', '--', 'a.txt'));
  refused(v => { v.proof.head = f.base; }, /tip .*병합 증명의 head와 다르다/);
  refused(v => { v.proof.branch = 'hh/other'; }, /PR 브랜치\(hh\/other\)/);
  refused(v => { delete v.proof.branch; }, /브랜치 이름이 없다/);
  refused(v => { v.state = 'QA'; }, /DONE 업무만/);
  const elsewhere = join(f.root, '.local/elsewhere');
  mkdirSync(elsewhere);
  refused(v => { v.worktreeDir = elsewhere; }, /worktree_dir 바로 아래가 아니다/);
  refused(v => { v.worktree = f.root; v.worktreeDir = f.temp; }, /원본 checkout|브랜치/);
  git(f.root, 'worktree', 'lock', '--reason', 'fixture lock', w.worktree);
  refused(() => {}, /잠긴 worktree.*fixture lock/, () => git(f.root, 'worktree', 'unlock', w.worktree));
  const inner = join(w.worktree, 'inner');
  git(f.root, 'worktree', 'add', '-q', '-b', 'hh/inner', inner, f.base);
  refused(() => {}, /다른 등록 worktree/, () => git(f.root, 'worktree', 'remove', inner));
  // 조건이 맞으면 같은 checkout을 정리한다.
  const done = cleanup(base);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
});

test('예외 종결 후보가 QA 이후 바뀌었거나 patch에 담을 수 없는 staged 중간 내용이 있으면 거부한다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-drift');
  writeFileSync(join(w.worktree, 'a.txt'), 'candidate\n');
  const candidate = { head: f.base, tree: candidateTree(w.worktree), paths: [{ path: 'a.txt' }] };
  const value = input(f, w, { kind: 'closed', candidate });
  const check = (pattern) => {
    const before = snapshot(f, w);
    const result = cleanup(value);
    assert.equal(result.status, 'refused');
    assert.match(result.reasons.join('\n'), pattern);
    assert.deepEqual(snapshot(f, w), before);
  };
  writeFileSync(join(w.worktree, 'a.txt'), 'changed after QA\n');
  check(/QA 후보와 다르다/);
  writeFileSync(join(w.worktree, 'a.txt'), 'candidate\n');
  git(w.worktree, 'add', '--', 'a.txt');
  writeFileSync(join(w.worktree, 'a.txt'), 'candidate plus unstaged\n');
  check(/staged 중간 내용 a\.txt/);
  git(w.worktree, 'reset', '-q', '--', 'a.txt');
  writeFileSync(join(w.worktree, 'a.txt'), 'candidate\n');
  writeFileSync(join(w.worktree, 'extra.txt'), 'not in candidate\n');
  check(/미추적 extra\.txt/);
  unlinkSync(join(w.worktree, 'extra.txt'));
  assert.equal(cleanup(value).status, 'done');
});

test('index 플래그·fsmonitor로 status가 숨기는 작업 사본 변경은 보존 대상 밖으로 보고 파일·브랜치를 그대로 둔다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-hidden');
  const head = commitIn(w, 'a.txt', 'merged\n');
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } });
  const kept = (pattern, text) => {
    const before = snapshot(f, w);
    const result = cleanup(value);
    assert.equal(result.status, 'refused');
    assert.match(result.reasons.join('\n'), pattern);
    assert.deepEqual(snapshot(f, w), before);
    assert.equal(readFileSync(join(w.worktree, 'a.txt'), 'utf8'), text);
    assert.deepEqual([refExists(f, w.branch), existsSync(join(f.state, 'tasks/HH-7/cleanup.json'))], [true, false]);
  };
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    git(w.worktree, 'update-index', '--' + flag, 'a.txt');
    writeFileSync(join(w.worktree, 'a.txt'), 'local only\n');
    // 플래그가 걸린 경로의 작업 사본 변경은 status에 나오지 않는다.
    assert.equal(git(w.worktree, 'status', '--porcelain', '--untracked-files=all'), '');
    kept(new RegExp('index 플래그.*a\\.txt\\(' + flag + '; 작업 사본≠index\\)'), 'local only\n');
    // 내용이 같아도 플래그가 남아 있으면 정리하지 않는다.
    writeFileSync(join(w.worktree, 'a.txt'), 'merged\n');
    kept(new RegExp('a\\.txt\\(' + flag + '; 작업 사본=index\\)'), 'merged\n');
    git(w.worktree, 'update-index', '--no-' + flag, 'a.txt');
  }
  // 변경이 없다고만 답하는 fsmonitor hook은 status에서 수정을 숨긴다. 정리는 fsmonitor를 끄고 조회한다.
  const hook = join(f.temp, 'fsmonitor-hook.sh');
  writeFileSync(hook, "#!/bin/sh\nprintf 'fixture\\0'\n", { mode: 0o755 });
  git(w.worktree, 'config', 'core.fsmonitor', hook.replaceAll('\\', '/'));
  git(w.worktree, 'config', 'core.fsmonitorHookVersion', '2');
  git(w.worktree, 'status');
  git(w.worktree, 'status');
  writeFileSync(join(w.worktree, 'a.txt'), 'hidden from fsmonitor\n');
  assert.equal(git(w.worktree, 'status', '--porcelain', '--untracked-files=all'), '');
  kept(/변경 a\.txt/, 'hidden from fsmonitor\n');
  git(w.worktree, 'config', '--unset', 'core.fsmonitor');
  writeFileSync(join(w.worktree, 'a.txt'), 'merged\n');
  const done = cleanup(value);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
});

// stat 정보(크기·mtime 초)가 index 기록과 같으면 status는 파일을 읽지 않는다. 같은 길이로 고친 뒤 mtime을 되돌리면 변경이 보이지 않는다.
const stamp = new Date('2020-01-02T03:04:05.000Z');
function statHidden(w, file, text) {
  const abs = join(w.worktree, file);
  writeFileSync(abs, text);
  utimesSync(abs, stamp, stamp);
  assert.equal(git(w.worktree, 'status', '--porcelain', '--untracked-files=all'), '');
  return git(w.worktree, 'hash-object', '--', file) !== git(w.worktree, 'rev-parse', ':' + file);
}

test('stat 정보가 같아 status가 숨긴 같은 길이 수정은 사전검사와 제거 직전 모두 내용 해시로 찾아 파일·브랜치를 보존한다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-stat');
  git(f.root, 'config', 'core.trustctime', 'false');
  git(f.root, 'config', 'core.checkStat', 'minimal');
  const head = commitIn(w, 'a.txt', 'merged\n');
  utimesSync(join(w.worktree, 'a.txt'), stamp, stamp);
  git(w.worktree, 'update-index', '--refresh');
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } });
  assert.equal(statHidden(w, 'a.txt', 'MERGED\n'), true);
  const before = snapshot(f, w);
  const refused = cleanup(value);
  assert.equal(refused.status, 'refused');
  assert.match(refused.reasons.join('\n'), /status에 나오지 않은 작업 사본 변경.*내용 해시≠index blob.*: a\.txt\./);
  assert.deepEqual(snapshot(f, w), before);
  assert.equal(readFileSync(join(w.worktree, 'a.txt'), 'utf8'), 'MERGED\n');
  assert.deepEqual(refused.remaining, [w.worktree, 'refs/heads/' + w.branch]);
  assert.equal(existsSync(join(f.state, 'tasks/HH-7/cleanup.json')), false);
  // 사전검사를 통과한 뒤(과정 문서 보관 중) 같은 방식으로 바뀌면 worktree remove 직전 확인이 멈춘다.
  assert.equal(statHidden(w, 'a.txt', 'merged\n'), false);
  const preserve = policy.preserve;
  policy.preserve = (...args) => { const kept = preserve(...args); writeFileSync(join(w.worktree, 'a.txt'), 'MERGED\n'); utimesSync(join(w.worktree, 'a.txt'), stamp, stamp); return kept; };
  let late;
  try { late = cleanup(value); } finally { policy.preserve = preserve; }
  assert.equal(late.status, 'partial');
  assert.match(late.reasons.join('\n'), /status에 나오지 않은 작업 사본 변경.*a\.txt/);
  assert.equal(readFileSync(join(w.worktree, 'a.txt'), 'utf8'), 'MERGED\n');
  assert.match(git(f.root, 'worktree', 'list', '--porcelain'), /hh-7-stat/);
  assert.ok(refExists(f, w.branch));
  assert.deepEqual(late.remaining, [w.worktree, 'refs/heads/' + w.branch]);
  // 내용을 되돌리면 같은 입력의 재시도가 정리를 끝낸다.
  assert.equal(statHidden(w, 'a.txt', 'merged\n'), false);
  const done = cleanup(value);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.equal(existsSync(w.worktree), false);
  assert.equal(refExists(f, w.branch), false);
});

test('내용 확인은 Git이 같다고 보는 정규화 차이와 링크 항목을 변경으로 보지 않고, 시간 한도를 넘거나 한도 값이 잘못되면 지우지 않는다', (t) => {
  const f = fixture(t);
  // worktree를 꺼내기 전에 설정한다. Git for Windows 기본(시스템 core.autocrlf=true)은 꺼낼 때 CRLF로 쓰므로, 꺼낸 뒤 바꾸면 그 파일이 변경으로 보인다.
  git(f.root, 'config', 'core.autocrlf', 'false');
  const w = checkout(f, 'hh-7-content');
  // CRLF로 커밋한 뒤 eol=lf 속성을 더한 파일: 필터 적용 해시는 index blob과 다르지만 원래 바이트는 index blob과 같다.
  writeFileSync(join(w.worktree, 'crlf.txt'), 'one\r\ntwo\r\n');
  utimesSync(join(w.worktree, 'crlf.txt'), stamp, stamp);
  git(w.worktree, 'add', '--', 'crlf.txt');
  git(w.worktree, 'commit', '-q', '-m', 'crlf');
  writeFileSync(join(w.worktree, '.gitattributes'), 'crlf.txt text eol=lf\n');
  // 링크 항목(mode 120000): 링크를 만들 수 있는 OS는 링크로, 아니면 대상 문자열을 담은 파일로 꺼낸다.
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: w.worktree, input: 'a.txt', encoding: 'utf8' }).trim();
  git(w.worktree, 'update-index', '--add', '--cacheinfo', '120000,' + blob + ',link');
  git(w.worktree, 'add', '--', '.gitattributes');
  git(w.worktree, 'commit', '-q', '-m', 'attributes and link');
  git(w.worktree, 'checkout', '--', 'link');
  assert.equal(git(w.worktree, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.notEqual(git(w.worktree, 'hash-object', '--', 'crlf.txt'), git(w.worktree, 'rev-parse', ':crlf.txt'));
  const head = git(w.worktree, 'rev-parse', 'HEAD');
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } });
  const kept = (limits, pattern) => {
    const before = snapshot(f, w);
    const result = cleanup({ ...value, limits });
    assert.equal(result.status, 'refused');
    assert.match(result.reasons.join('\n'), pattern);
    assert.deepEqual(snapshot(f, w), before);
    assert.equal(existsSync(join(f.state, 'tasks/HH-7/cleanup.json')), false);
  };
  // 한도 안에 내용 확인을 끝내지 못하면 변경 여부를 모르므로 지우지 않는다.
  kept({ contentMs: 1 }, /시간 한도\(1ms\).*재시도 명령/);
  kept({ contentMs: 0 }, /limits\.contentMs/);
  kept({ contentMs: '60000' }, /limits\.contentMs/);
  // 내용 해시를 통과한 뒤 폴더 순회가 한도를 넘겨도 같은 이유로 멈춘다(순회를 시작하면 시계를 한도 뒤로 옮긴다).
  const fs = require('node:fs'), readdir = fs.readdirSync, now = Date.now;
  let walked = 0;
  fs.readdirSync = (...args) => { walked++; Date.now = () => now() + 3600000; return readdir(...args); };
  try { kept({ contentMs: 600000 }, /폴더 순회가 시간 한도\(600000ms\)/); } finally { fs.readdirSync = readdir; Date.now = now; }
  assert.equal(walked, 1);
  const done = cleanup({ ...value, limits: { contentMs: 600000 } });
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.equal(existsSync(w.worktree), false);
});

test('submodule이 있는 worktree는 Git이 비강제 제거를 거부하므로 의도 기록 전에 멈추고 내용을 보존한다', (t) => {
  const f = fixture(t);
  const sub = join(f.temp, 'sub');
  mkdirSync(sub);
  git(sub, 'init', '-q', '-b', 'main');
  writeFileSync(join(sub, 's.txt'), 'sub\n');
  git(sub, 'add', '.');
  git(sub, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '-m', 'sub');
  const w = checkout(f, 'hh-7-submodule');
  git(w.worktree, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.replaceAll('\\', '/'), 'sub');
  git(w.worktree, 'commit', '-q', '-m', 'with submodule');
  const head = git(w.worktree, 'rev-parse', 'HEAD');
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } });
  const before = snapshot(f, w);
  const result = cleanup(value);
  assert.equal(result.status, 'refused');
  assert.match(result.reasons.join('\n'), /submodule.*\.gitmodules.*gitlink sub/);
  assert.deepEqual(snapshot(f, w), before);
  // submodule은 core.autocrlf=true(Git for Windows 기본)면 CRLF로 꺼내므로 줄 끝은 둘 다 받는다.
  assert.match(readFileSync(join(w.worktree, 'sub/s.txt'), 'utf8'), /^sub\r?\n$/);
  assert.deepEqual(result.remaining, [w.worktree, 'refs/heads/' + w.branch]);
  assert.equal(existsSync(join(f.state, 'tasks/HH-7/cleanup.json')), false);
  // gitlink 없이 .gitmodules만 남아도 같은 이유로 멈춘다.
  git(w.worktree, 'rm', '-q', '--cached', 'sub');
  rmSync(join(w.worktree, 'sub'), { recursive: true, force: true });
  git(w.worktree, 'commit', '-q', '-m', 'drop gitlink');
  const left = cleanup({ ...value, proof: { ...value.proof, head: git(w.worktree, 'rev-parse', 'HEAD') } });
  assert.equal(left.status, 'refused');
  assert.match(left.reasons.join('\n'), /submodule.*\.gitmodules/);
  assert.ok(existsSync(w.worktree));
});

// worktree 밖 폴더를 가리키는 링크. Windows는 junction(Git for Windows의 비강제 remove가 따라가 대상을 지운다), 다른 OS는 심볼릭 링크로 만든다.
function outsideDir(f) {
  const outside = join(f.temp, 'outside'), precious = join(outside, 'precious.txt');
  mkdirSync(outside);
  writeFileSync(precious, 'outside the worktree\n');
  return { outside, precious, intact: () => readFileSync(precious, 'utf8') === 'outside the worktree\n' };
}

test('status가 보여 주지 않는 .git 이름 항목·중첩 저장소·링크·junction은 아무것도 지우지 않고 멈춰 worktree 밖 파일과 중첩 저장소 커밋을 보존한다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-unseen');
  mkdirSync(join(w.worktree, 'sub'));
  writeFileSync(join(w.worktree, 'sub/keep.txt'), 'tracked in sub\n');
  git(w.worktree, 'add', '--', 'sub/keep.txt');
  const head = commitIn(w, 'a.txt', 'merged\n');
  outputs(w);
  const o = outsideDir(f), sub = join(w.worktree, 'sub');
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } });
  const kept = (setup, pattern, undo) => {
    setup();
    const before = snapshot(f, w);
    const result = cleanup(value);
    assert.equal(result.status, 'refused', pattern.source);
    assert.match(result.reasons.join('\n'), pattern);
    assert.deepEqual(snapshot(f, w), before);
    assert.ok(o.intact());
    assert.deepEqual(result.remaining, [w.worktree, 'refs/heads/' + w.branch]);
    assert.equal(existsSync(join(f.state, 'tasks/HH-7/cleanup.json')), false);
    undo();
  };
  const link = p => symlinkSync(o.outside, join(w.worktree, p), 'junction');
  // 폐기 목록(dist/) 안의 링크, 폐기 폴더 자체가 링크, 보존 목록 안의 링크, Git이 폴더로 따라가 보여 주는 미추적 링크
  kept(() => link('dist/link'), /링크·junction dist\/link\./, () => unlinkSync(join(w.worktree, 'dist/link')));
  rmSync(join(w.worktree, 'dist'), { recursive: true });
  // 폐기 폴더 자체가 링크: Windows의 junction은 Git이 폴더로 보아 «!! dist/»로 보고하므로 폴더 순회가 «링크·junction dist»로 멈춘다.
  // 다른 OS의 심볼릭 링크는 무시 패턴 dist/(폴더에만 맞음)에 맞지 않아 «?? dist»로 보고되므로 분류가 먼저 «미추적 dist»로 멈춘다.
  kept(() => link('dist'), /링크·junction dist\.|미추적 dist/, () => unlinkSync(join(w.worktree, 'dist')));
  kept(() => link('target/hh-verify/link'), /링크·junction target\/hh-verify\/link\./, () => unlinkSync(join(w.worktree, 'target/hh-verify/link')));
  kept(() => link('sub/link'), /sub\/link/, () => unlinkSync(join(sub, 'link')));
  // 추적 폴더 안의 중첩 저장소(자체 커밋 보유). 바깥 status에는 아무것도 나오지 않는다.
  let inner;
  kept(() => {
    git(sub, 'init', '-q', '-b', 'inner');
    git(sub, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'inner only');
    inner = git(sub, 'rev-parse', 'HEAD');
    assert.equal(git(w.worktree, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'), '!! target/hh-verify/');
  }, /\.git 이름 항목 sub\/\.git\./, () => {
    assert.equal(git(sub, 'cat-file', '-t', inner), 'commit');
    rmSync(join(sub, '.git'), { recursive: true, force: true });
  });
  // 저장소가 아닌 .git 이름 폴더: 추적 폴더 안, 미추적 폴더 안, 폐기 폴더 안의 중첩 저장소
  kept(() => { mkdirSync(join(sub, '.git')); writeFileSync(join(sub, '.git/notes.txt'), 'local only\n'); },
    /\.git 이름 항목 sub\/\.git\./, () => rmSync(join(sub, '.git'), { recursive: true }));
  kept(() => { mkdirSync(join(w.worktree, 'scratch/.git'), { recursive: true }); writeFileSync(join(w.worktree, 'scratch/.git/notes.txt'), 'local only\n'); },
    /\.git 이름 항목 scratch\/\.git\./, () => rmSync(join(w.worktree, 'scratch'), { recursive: true }));
  outputs(w);
  kept(() => { mkdirSync(join(w.worktree, 'dist/pkg')); git(join(w.worktree, 'dist/pkg'), 'init', '-q'); },
    /\.git 이름 항목 dist\/pkg\/\.git\./, () => rmSync(join(w.worktree, 'dist/pkg'), { recursive: true, force: true }));
  // 일반 파일만 든 폐기·보존 폴더와 빈 폴더는 그대로 정리하고 worktree 밖 파일은 남는다.
  mkdirSync(join(w.worktree, 'empty/deeper'), { recursive: true });
  const done = cleanup(value);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.equal(existsSync(w.worktree), false);
  assert.ok(o.intact());
});

// 대소문자를 구분하는 worktree 폴더. Windows는 checkout 전에 fsutil로 폴더의 대소문자 구분을 켠다(뒤에 만드는 하위 폴더가 물려받는다).
// 켜지 못하면(fsutil 실패·대소문자를 구분하지 않는 파일 시스템) 대소문자만 다른 두 항목을 실제로 만들 수 없으므로 native=false를 돌려준다.
function caseSensitive(f, name) {
  const worktree = join(f.dir, name);
  mkdirSync(worktree);
  if (process.platform === 'win32') spawnSync('fsutil', ['file', 'setCaseSensitiveInfo', worktree, 'enable'], { windowsHide: true, stdio: 'ignore' });
  writeFileSync(join(worktree, 'probe'), '');
  const native = !existsSync(join(worktree, 'PROBE'));
  unlinkSync(join(worktree, 'probe'));
  return { ...checkout(f, name), native };
}

test('core.ignorecase=true에서 status가 보여 주지 않는 대소문자만 다른 미추적 파일·폴더는 멈추고 보존하며, false 대조군은 Git이 미추적으로 보고해 멈춘다', (t) => {
  const f = fixture(t), w = caseSensitive(f, 'hh-7-case');
  mkdirSync(join(w.worktree, 'sub'));
  writeFileSync(join(w.worktree, 'sub/keep.txt'), 'tracked in sub\n');
  git(w.worktree, 'add', '--', 'sub/keep.txt');
  const head = commitIn(w, 'a.txt', 'merged\n');
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } });
  const fs = require('node:fs'), readdir = fs.readdirSync;
  // 추적 항목(of)과 대소문자만 다른 미추적 항목(twin). 폴더 변형은 그 안에 추적 파일과 같은 이름의 파일을 둔다.
  for (const { of, twin, precious } of [{ of: 'a.txt', twin: 'A.TXT', precious: 'A.TXT' }, { of: 'sub', twin: 'SUB', precious: 'SUB/keep.txt' }]) {
    for (const ignorecase of ['true', 'false']) {
      git(f.root, 'config', 'core.ignorecase', ignorecase);
      if (w.native) {
        if (twin === 'SUB') mkdirSync(join(w.worktree, twin));
        writeFileSync(join(w.worktree, precious), 'uncommitted work, never added\n');
        assert.ok(readdirSync(w.worktree).includes(of) && readdirSync(w.worktree).includes(twin));
        // ignorecase=true면 Git은 twin을 추적 항목과 같은 index 경로로 보아 보고하지 않는다. false면 미추적으로 보고한다.
        assert.equal(git(w.worktree, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'), ignorecase === 'true' ? '' : '?? ' + precious);
      } else {
        // 대역: 대소문자를 구분하는 폴더를 만들 수 없으면 worktree 루트(.git 파일이 있는 폴더)의 목록에 twin 항목을 더한다.
        // 실제 파일이 없어 Git은 보고하지 않으므로 false 대조군은 폴더 순회가 «설명되지 않는 파일»로 멈춘다.
        fs.readdirSync = (dir, options) => {
          const list = readdir(dir, options);
          if (!options?.withFileTypes || !list.some(d => d.name === '.git' && d.isFile())) return list;
          const source = list.find(d => d.name === of);
          return [...list, Object.assign(Object.create(Object.getPrototypeOf(source)), source, { name: twin })];
        };
      }
      const before = snapshot(f, w);
      let result;
      try { result = cleanup(value); } finally { fs.readdirSync = readdir; }
      const e = s => s.replaceAll('.', '\\.');
      const pattern = ignorecase === 'true'
        ? new RegExp(`대소문자만 다른 이름 (${e(twin)}\\(${e(of)}|${e(of)}\\(${e(twin)})와 같은 index 경로\\)`)
        : new RegExp(`${w.native ? '미추적' : '설명되지 않는 파일'} ${e(precious)}`);
      assert.equal(result.status, 'refused', `${twin} ignorecase=${ignorecase}`);
      assert.match(result.reasons.join('\n'), pattern);
      assert.deepEqual(snapshot(f, w), before);
      assert.deepEqual(result.remaining, [w.worktree, 'refs/heads/' + w.branch]);
      assert.equal(existsSync(join(f.state, 'tasks/HH-7/cleanup.json')), false);
      if (w.native) {
        assert.equal(readFileSync(join(w.worktree, precious), 'utf8'), 'uncommitted work, never added\n');
        rmSync(join(w.worktree, twin), { recursive: true });
      }
    }
  }
  // 대소문자만 다른 항목이 없으면 ignorecase=true여도 정리를 끝낸다.
  git(f.root, 'config', 'core.ignorecase', 'true');
  const done = cleanup(value);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.equal(existsSync(w.worktree), false);
});

test('폴더 순회는 worktree remove 직전에도 다시 해 사전검사 뒤 생긴 junction을 막고, 링크를 풀면 재시도가 정리를 끝낸다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-late-link');
  const head = commitIn(w, 'a.txt', 'merged\n');
  outputs(w);
  const o = outsideDir(f);
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } });
  const preserve = policy.preserve;
  policy.preserve = (...args) => { const kept = preserve(...args); symlinkSync(o.outside, join(w.worktree, 'dist/link'), 'junction'); return kept; };
  let late;
  try { late = cleanup(value); } finally { policy.preserve = preserve; }
  assert.equal(late.status, 'partial');
  assert.match(late.reasons.join('\n'), /링크·junction dist\/link/);
  assert.ok(o.intact());
  assert.equal(readFileSync(join(w.worktree, 'dist/out.js'), 'utf8'), 'generated\n');
  assert.match(git(f.root, 'worktree', 'list', '--porcelain'), /hh-7-late-link/);
  assert.ok(refExists(f, w.branch));
  assert.deepEqual(late.remaining, [w.worktree, 'refs/heads/' + w.branch]);
  unlinkSync(join(w.worktree, 'dist/link'));
  const done = cleanup(value);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.equal(existsSync(w.worktree), false);
  assert.ok(o.intact());
});

// 추적 링크(mode 120000). core.symlinks=false라 링크 대상 문자열을 담은 일반 파일로 꺼낸다(Windows 기본과 같다).
function trackedLink(f, w) {
  git(f.root, 'config', 'core.symlinks', 'false');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: w.worktree, input: 'shared', encoding: 'utf8' }).trim();
  git(w.worktree, 'update-index', '--add', '--cacheinfo', '120000,' + blob + ',link');
  git(w.worktree, 'commit', '-q', '-m', 'tracked link');
  git(w.worktree, 'checkout', '--', 'link');
  assert.ok(statSync(join(w.worktree, 'link')).isFile());
  return git(w.worktree, 'rev-parse', 'HEAD');
}

test('예외 종결 후보가 추적 링크 경로를 worktree 밖 폴더 junction으로 바꿨으면 의도 기록 전에 멈추고, 일반 파일로 풀린 추적 링크는 정리한다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-link-path');
  const head = trackedLink(f, w), o = outsideDir(f), link = join(w.worktree, 'link');
  writeFileSync(join(w.worktree, 'a.txt'), 'candidate\n');
  unlinkSync(link);
  symlinkSync(o.outside, link, 'junction');
  // Windows는 ' D link'와 '?? link/precious.txt', 다른 OS는 ' M link'로 보고하고 후보 경로에 link가 든다.
  const tree = candidateTree(w.worktree);
  const paths = git(w.worktree, 'diff', '--name-only', '--no-renames', '-z', head, tree).split('\0').filter(Boolean);
  assert.ok(paths.includes('link') && paths.includes('a.txt'));
  const before = snapshot(f, w);
  const refused = cleanup(input(f, w, { kind: 'closed', candidate: { head, tree, paths: paths.map(path => ({ path })) } }));
  assert.equal(refused.status, 'refused');
  assert.match(refused.reasons.join('\n'), /링크·junction link\(index의 추적 링크와 다름\)/);
  assert.deepEqual(snapshot(f, w), before);
  assert.ok(o.intact());
  assert.equal(realpathSync.native(link), realpathSync.native(o.outside));
  assert.match(git(f.root, 'worktree', 'list', '--porcelain'), /hh-7-link-path/);
  assert.equal(git(f.root, 'rev-parse', 'refs/heads/' + w.branch), head);
  assert.deepEqual(readdirSync(join(f.state, 'tasks/HH-7')), []);
  // junction을 풀고 추적 링크를 일반 파일로 되돌린 후보는 patch를 남기고 정리한다. 밖 파일은 그대로다.
  unlinkSync(link);
  git(w.worktree, 'checkout', '--', 'link');
  const clean = { head, tree: candidateTree(w.worktree), paths: [{ path: 'a.txt' }] };
  const done = cleanup(input(f, w, { kind: 'closed', candidate: clean }));
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.deepEqual(done.patch.paths, ['a.txt']);
  assert.equal(existsSync(w.worktree), false);
  assert.ok(o.intact());
});

test('Git이 후보 경로를 되돌리기 직전에 그 경로가 junction으로 바뀌면 checkout 전에 멈추고 밖 파일·등록·브랜치를 보존한다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-revert-link');
  writeFileSync(join(w.worktree, 'a.txt'), 'candidate\n');
  mkdirSync(join(w.worktree, 'new'));
  writeFileSync(join(w.worktree, 'new/n.txt'), 'new file\n');
  const o = outsideDir(f);
  const value = input(f, w, { kind: 'closed', candidate: { head: f.base, tree: candidateTree(w.worktree), paths: [{ path: 'a.txt' }, { path: 'new/n.txt' }] } });
  const swap = () => { unlinkSync(join(w.worktree, 'a.txt')); symlinkSync(o.outside, join(w.worktree, 'a.txt'), 'junction'); };
  const unswap = () => { unlinkSync(join(w.worktree, 'a.txt')); writeFileSync(join(w.worktree, 'a.txt'), 'candidate\n'); };
  const kept = (result, status) => {
    assert.equal(result.status, status);
    assert.match(result.reasons.join('\n'), /Git이 지우거나 덮어쓸 경로에 링크·junction.*: 링크·junction a\.txt\./);
    assert.ok(o.intact());
    assert.equal(readFileSync(join(w.worktree, 'new/n.txt'), 'utf8'), 'new file\n');
    assert.match(git(f.root, 'worktree', 'list', '--porcelain'), /hh-7-revert-link/);
    assert.equal(git(f.root, 'rev-parse', 'refs/heads/' + w.branch), f.base);
    assert.deepEqual(result.remaining, [w.worktree]);
  };
  // 파일을 쓴 직후(patch 저장·의도 기록) a.txt를 junction으로 바꾼다. 사전검사·QA 후보 대조·폴더 순회는 이미 통과한 뒤다.
  const fs = require('node:fs'), rename = fs.renameSync;
  const after = (suffix) => {
    fs.renameSync = (from, to) => { rename(from, to); if (String(to).endsWith(suffix)) swap(); };
    try { return cleanup(value); } finally { fs.renameSync = rename; }
  };
  // patch 저장 뒤 바뀌면 의도 기록 전 확인이 멈춘다.
  kept(after('.patch'), 'refused');
  assert.equal(existsSync(join(f.state, 'tasks/HH-7/cleanup.json')), false);
  unswap();
  // 의도 기록 뒤 되돌리기 직전에 바뀌면 되돌리기 안의 확인이 Git checkout 전에 멈춘다.
  const late = after('cleanup.json');
  kept(late, 'partial');
  assert.equal(realpathSync.native(join(w.worktree, 'a.txt')), realpathSync.native(o.outside));
  assert.ok(existsSync(join(f.state, 'tasks/HH-7/cleanup.json')));
  // 링크를 풀고 후보 내용으로 되돌리면 같은 입력의 재시도가 정리를 끝낸다.
  unswap();
  const done = cleanup(value);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.deepEqual(done.patch.paths, ['a.txt', 'new/n.txt']);
  assert.equal(existsSync(w.worktree), false);
  assert.ok(o.intact());
});

test('예외 종결 후보가 추적 파일을 폴더로, 추적 폴더를 파일로 바꿨어도 후보 경로를 되돌려 정리하고 patch로 같은 tree를 복원한다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-swap');
  mkdirSync(join(w.worktree, 'd'));
  writeFileSync(join(w.worktree, 'd/k'), 'dir d\n');
  git(w.worktree, 'add', '--', 'd/k');
  git(w.worktree, 'commit', '-q', '-m', 'tracked dir');
  const head = git(w.worktree, 'rev-parse', 'HEAD');
  unlinkSync(join(w.worktree, 'a.txt'));
  mkdirSync(join(w.worktree, 'a.txt'));
  writeFileSync(join(w.worktree, 'a.txt/y'), 'now a folder\n');
  rmSync(join(w.worktree, 'd'), { recursive: true });
  writeFileSync(join(w.worktree, 'd'), 'now a file\n');
  const tree = candidateTree(w.worktree), paths = ['a.txt', 'a.txt/y', 'd', 'd/k'];
  const done = cleanup(input(f, w, { kind: 'closed', candidate: { head, tree, paths: paths.map(path => ({ path })) } }));
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.deepEqual([...done.patch.paths].sort(), paths);
  assert.equal(existsSync(w.worktree), false);
  const index = join(f.temp, 'swap.index'), env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync('git', ['read-tree', head], { cwd: f.root, env });
  execFileSync('git', ['apply', '--cached', '--binary', join(f.state, ...done.patch.file.split('/'))], { cwd: f.root, env });
  assert.equal(execFileSync('git', ['write-tree'], { cwd: f.root, env, encoding: 'utf8' }).trim(), tree);
});

test('worktree 전용 ref와 진행 중인 병합 상태는 worktree와 함께 사라지므로 멈추고 ref·커밋·worktree를 보존한다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-own');
  const head = commitIn(w, 'a.txt', 'merged\n');
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } });
  const kept = (pattern) => {
    const before = snapshot(f, w);
    const result = cleanup(value);
    assert.equal(result.status, 'refused');
    assert.match(result.reasons.join('\n'), pattern);
    assert.deepEqual(snapshot(f, w), before);
    assert.deepEqual(result.remaining, [w.worktree, 'refs/heads/' + w.branch]);
    assert.equal(existsSync(join(f.state, 'tasks/HH-7/cleanup.json')), false);
  };
  // refs/worktree/wip만 가리키는 커밋
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: w.worktree, input: 'wip only here\n', encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['mktree'], { cwd: w.worktree, input: `100644 blob ${blob}\twip.txt\n`, encoding: 'utf8' }).trim();
  const wip = git(w.worktree, 'commit-tree', tree, '-p', head, '-m', 'wip under refs/worktree');
  git(w.worktree, 'update-ref', 'refs/worktree/wip', wip);
  git(w.worktree, 'update-ref', 'refs/bisect/bad', head);
  kept(/worktree 전용 ref.*: refs\/bisect\/bad, refs\/worktree\/wip\./);
  assert.equal(git(w.worktree, 'rev-parse', 'refs/worktree/wip'), wip);
  assert.equal(git(w.worktree, 'show', `${wip}:wip.txt`), 'wip only here');
  git(w.worktree, 'update-ref', '-d', 'refs/worktree/wip');
  git(w.worktree, 'update-ref', '-d', 'refs/bisect/bad');
  // 커밋하지 않은 병합 진행 상태(MERGE_HEAD). status에는 아무것도 나오지 않는다.
  const other = git(f.root, 'commit-tree', f.base + '^{tree}', '-p', f.base, '-m', 'other line');
  git(f.root, 'branch', 'other', other);
  git(w.worktree, 'merge', '--no-commit', '--no-ff', '-s', 'ours', 'other');
  assert.equal(git(w.worktree, 'status', '--porcelain', '--untracked-files=all'), '');
  kept(/진행 중인 Git 작업 상태가 있다: MERGE_HEAD\./);
  git(w.worktree, 'merge', '--abort');
  const done = cleanup(value);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.equal(git(f.root, 'rev-parse', 'refs/heads/other'), other);
});

// 의도 기록을 남긴 뒤 worktree 제거 전에 중단된 정리(프로세스 종료·Windows의 부분 삭제). 기록 형식은 core가 첫 되돌리기·삭제 전에 남기는 것과 같다.
function interrupted(f, w, tips) {
  const real = p => (process.platform === 'win32' ? realpathSync.native(p).toLowerCase() : realpathSync.native(p));
  const name = basename(w.worktree);
  mkdirSync(join(f.state, 'tasks/HH-7'), { recursive: true });
  writeFileSync(join(f.state, 'tasks/HH-7/cleanup.json'), JSON.stringify({ version: 1, id: 'HH-7', kind: 'merged',
    worktree: join(real(f.dir), process.platform === 'win32' ? name.toLowerCase() : name), branch: w.branch, tips,
    preserved: null, patch: null, intent: '2026-11-19T00:00:00.000Z', removed: null, branchResult: null }, null, 2) + '\n');
}

test('중단된 정리의 재시도: 의도 기록이 있는 경로만 등록 해제·빈 골격 삭제로 수렴시키고 파일이 남으면 보존한다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-retry');
  const head = commitIn(w, 'a.txt', 'merged\n');
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } });
  interrupted(f, w, [head]);
  // 등록은 사라지고 파일이 남은 폴더는 지우지 않는다.
  rmSync(join(w.worktree, '.git'));
  git(f.root, 'worktree', 'prune');
  const left = cleanup(value);
  assert.equal(left.status, 'partial');
  assert.match(left.reasons.join('\n'), /파일이 남았다/);
  assert.equal(readFileSync(join(w.worktree, 'a.txt'), 'utf8'), 'merged\n');
  assert.deepEqual(left.remaining, [w.worktree, 'refs/heads/' + w.branch]);
  // 파일·링크가 없는 빈 골격만 아래부터 비재귀로 지우고 브랜치 단계로 넘어간다.
  rmSync(w.worktree, { recursive: true, force: true });
  mkdirSync(join(w.worktree, 'sub/deeper'), { recursive: true });
  const done = cleanup(value);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.equal(existsSync(w.worktree), false);
  assert.equal(done.branch.state, 'deleted');
  // 정리한 경로에 새 worktree가 생기면 같은 업무의 정리로 보지 않는다.
  git(f.root, 'worktree', 'add', '-q', '-b', w.branch, w.worktree, f.base);
  const reused = cleanup(value);
  assert.equal(reused.status, 'refused');
  assert.match(reused.reasons.join('\n'), /새 worktree/);
  assert.ok(existsSync(w.worktree));
  // 등록만 남고 폴더가 사라진 상태는 의도 기록이 있을 때만 비강제 remove로 등록을 해제한다.
  const g = fixture(t), x = checkout(g, 'hh-7-missing');
  const tip = commitIn(x, 'a.txt', 'merged\n');
  rmSync(x.worktree, { recursive: true, force: true });
  const missingValue = input(g, x, { kind: 'merged', proof: { head: tip, original: null, branch: x.branch } });
  const missing = cleanup(missingValue);
  assert.equal(missing.status, 'refused');
  assert.match(missing.reasons.join('\n'), /의도 기록이 없어/);
  assert.match(git(g.root, 'worktree', 'list', '--porcelain'), /hh-7-missing/);
  interrupted(g, x, [tip]);
  const unregistered = cleanup(missingValue);
  assert.equal(unregistered.status, 'done', unregistered.reasons.join('\n'));
  assert.doesNotMatch(git(g.root, 'worktree', 'list', '--porcelain'), /hh-7-missing/);
  assert.equal(refExists(g, x.branch), false);
});

test('중단된 정리의 재시도는 이전 지문 위에 다시 보관한 파일의 새 지문을 덮어 기록이 보관본·manifest와 같다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-record');
  const head = commitIn(w, 'a.txt', 'merged\n');
  outputs(w);
  mkdirSync(join(w.worktree, 'docs/projects/x'), { recursive: true });
  writeFileSync(join(w.worktree, 'docs/projects/x/README.md'), '- 조사: 완료\n');
  const artifacts = { config: { process_artifacts: { paths: ['docs/projects/{slug}/'] } }, vars: { slug: 'x' } };
  const value = input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch }, artifacts });
  // 보관 뒤 예상하지 못한 파일이 생겨 제거 직전 확인에서 멈춘다(과정 문서는 지문 확인 뒤 이미 지웠다).
  const preserve = policy.preserve;
  policy.preserve = (...args) => { const kept = preserve(...args); writeFileSync(join(w.worktree, 'stray.txt'), 'late\n'); return kept; };
  let first;
  try { first = cleanup(value); } finally { policy.preserve = preserve; }
  assert.equal(first.status, 'partial');
  assert.match(first.reasons.join('\n'), /미추적 stray\.txt/);
  assert.equal(existsSync(join(w.worktree, 'docs/projects/x/README.md')), false);
  unlinkSync(join(w.worktree, 'stray.txt'));
  writeFileSync(join(w.worktree, 'target/hh-verify/latest-qa.json'), '{"qa":"round 2"}\n');
  const done = cleanup(value);
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  const dir = join(f.state, done.preserved.dir), names = ['docs/projects/x/README.md', 'target/hh-verify/latest-qa.json'];
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(done.preserved.files), names);
  for (const name of names) assert.deepEqual([done.preserved.files[name], manifest.files[name]], [sha(readFileSync(join(dir, name))), sha(readFileSync(join(dir, name)))]);
  assert.equal(done.preserved.files[names[0]], first.preserved.files[names[0]]);
  assert.equal(done.preserved.files[names[1]], sha('{"qa":"round 2"}\n'));
  assert.notEqual(first.preserved.files[names[1]], done.preserved.files[names[1]]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.state, done.journal), 'utf8')).preserved, done.preserved);
});

test('사용 중인 worktree는 Windows에서 제거 전에 거부하고, 다른 OS에서는 Git이 그대로 정리한다', async (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-busy');
  const head = commitIn(w, 'a.txt', 'merged\n');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: w.worktree, stdio: 'ignore', windowsHide: true });
  let result;
  try {
    await once(child, 'spawn');
    result = cleanup(input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } }));
  } finally {
    child.kill();
    await once(child, 'exit');
  }
  if (process.platform === 'win32') {
    assert.equal(result.status, 'refused');
    assert.match(result.reasons.join('\n'), /사용 중/);
    assert.ok(existsSync(join(w.worktree, 'a.txt')) && refExists(f, w.branch));
  } else assert.equal(result.status, 'done', result.reasons.join('\n'));
});

test('binding으로 고정한 정리 진입점은 Node·JSON stdin에서 같고, 경계 변조와 정리 모듈이 없는 옛 release를 거부한다', (t) => {
  const f = fixture(t), w = checkout(f, 'hh-7-binding');
  const head = commitIn(w, 'a.txt', 'merged\n');
  const built = build(), file = join(f.state, 'harness-binding.json');
  writeFileSync(file, JSON.stringify({ version: 1, project: 'fixture', release: built.release, manifestHash: built.manifestHash, cwd: f.root }));
  const request = { action: 'cleanup', project: 'fixture', stateDir: f.state, task: input(f, w, { kind: 'merged', proof: { head, original: null, branch: w.branch } }) };
  assert.throws(() => worktreeCleanup(file, { ...request, project: 'other' }), /경계/);
  assert.throws(() => worktreeCleanup(file, { ...request, task: { ...request.task, root: f.temp } }), /저장소 경계/);
  assert.throws(() => worktreeCleanup(file, { ...request, action: 'typo' }), /동작/);
  assert.ok(existsSync(w.worktree));
  const direct = worktreeCleanup(file, request);
  assert.equal(direct.status, 'done', direct.reasons.join('\n'));
  const r = run(process.execPath, ['adapters/runtime.cjs', file, 'cleanup'], { input: JSON.stringify(request) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), direct);
  // 정리 모듈을 뺀 release(현재 설치본과 같은 상태)는 실행하지 않고 지원하지 않음을 알린다.
  const legacy = join(f.temp, 'legacy');
  cpSync(built.release, legacy, { recursive: true });
  rmSync(join(legacy, 'core/worktree-cleanup.cjs'));
  const manifest = JSON.parse(readFileSync(join(legacy, 'manifest.json'), 'utf8'));
  delete manifest.files['core/worktree-cleanup.cjs'];
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(legacy, 'manifest.json'), raw);
  writeFileSync(file, JSON.stringify({ version: 1, project: 'fixture', release: legacy, manifestHash: hash(raw), cwd: f.root }));
  assert.throws(() => worktreeCleanup(file, request), /지원하지 않는다/);
  assert.ok(statSync(f.state).isDirectory());
});

test('사용자 승인 병합 종결: worktree는 같은 사전검사로 지우고 브랜치는 -d만 시도해 미병합 tip이면 보존하며 재실행은 같은 결과다', (t) => {
  const f = fixture(t);
  // 병합 커밋으로 main에 들어간 브랜치는 -d가 지운다.
  const a = checkout(f, 'hh-7-accepted');
  const merged = commitIn(a, 'a.txt', 'merged\n');
  outputs(a);
  git(f.root, 'merge', '-q', '--no-ff', '-m', 'merge', a.branch);
  const first = cleanup(input(f, a, { kind: 'merged-accepted' }));
  assert.equal(first.status, 'done', first.reasons.join('\n'));
  assert.deepEqual(first.branch, { name: a.branch, state: 'deleted', tip: merged, method: '-d', at: '2026-11-20T00:00:00.000Z' });
  assert.equal(existsSync(a.worktree), false);
  assert.equal(refExists(f, a.branch), false);
  assert.deepEqual(Object.keys(first.preserved.files), ['target/hh-verify/latest-qa.json']);
  assert.deepEqual(cleanup(input(f, a, { kind: 'merged-accepted', at: '2026-11-21T00:00:00.000Z' })), first);
});

test('사용자 승인 병합 종결: squash로 로컬 tip이 미병합이면 worktree만 지우고 브랜치 SHA를 보존하며, dirty는 거부한다', (t) => {
  const f = fixture(t);
  const w = checkout(f, 'hh-8-squash');
  const head = commitIn(w, 'a.txt', 'squashed\n');
  git(f.root, 'merge', '--squash', '-q', w.branch);
  git(f.root, 'commit', '-q', '-m', 'squash');
  // 작업 사본에 커밋하지 않은 변경이 있으면 아무것도 지우지 않는다.
  writeFileSync(join(w.worktree, 'gone.txt'), 'dirty\n');
  const before = snapshot(f, w);
  const refused = cleanup(input(f, w, { kind: 'merged-accepted' }));
  assert.equal(refused.status, 'refused');
  assert.match(refused.reasons.join('\n'), /변경 gone\.txt/);
  assert.deepEqual(refused.remaining, [w.worktree, 'refs/heads/' + w.branch]);
  assert.deepEqual(snapshot(f, w), before);
  git(w.worktree, 'checkout', '--', 'gone.txt');
  const done = cleanup(input(f, w, { kind: 'merged-accepted' }));
  assert.equal(done.status, 'done', done.reasons.join('\n'));
  assert.equal(existsSync(w.worktree), false);
  assert.deepEqual([done.branch.state, done.branch.tip], ['kept', head]);
  assert.match(done.branch.reason, /git branch -d 거부/);
  assert.equal(git(f.root, 'rev-parse', 'refs/heads/' + w.branch), head);
  const again = cleanup(input(f, w, { kind: 'merged-accepted', at: '2026-11-21T00:00:00.000Z' }));
  assert.deepEqual(again, done);
  assert.equal(git(f.root, 'rev-parse', 'refs/heads/' + w.branch), head);
});
