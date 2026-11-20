import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from '../scripts/build.mjs';
import { validateLedger } from '../core/contract.js';
const require = createRequire(import.meta.url);
const { accept, verify, KIND } = require('../core/merged-closure.cjs');
const { workflow, hash } = require('../adapters/runtime.cjs');
const NOW = '2026-11-21T03:00:00.000Z';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// 임시 bare origin을 GitHub URL로 가리키고(insteadOf), gh는 고정 응답을 돌려주는 대역으로 바꾼다. 운영 계정·네트워크를 쓰지 않는다.
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'hh-merged-closure-'));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const origin = join(temp, 'origin.git'), repo = join(temp, 'repo'), other = join(temp, 'other');
  git(temp, 'init', '-q', '--bare', '-b', 'main', origin);
  const setup = dir => {
    git(temp, 'init', '-q', '-b', 'main', dir);
    git(dir, 'config', 'user.name', 'fixture');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
    git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    git(dir, 'config', `url.${origin.replaceAll('\\', '/')}.insteadOf`, 'https://github.com/acme/app.git');
  };
  setup(repo);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const responses = join(temp, 'gh.json'), stub = join(temp, 'gh.mjs');
  writeFileSync(stub, `import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(temp, 'gh.log'))}, JSON.stringify(args) + '\\n');
const all = JSON.parse(readFileSync(${JSON.stringify(responses)}, 'utf8'));
const value = all[args[2]];
if (args[0] !== 'pr' || args[1] !== 'view' || args[3] !== '--repo' || args[4] !== 'github.com/acme/app' || !value) { console.error('no such PR'); process.exit(1); }
console.log(JSON.stringify(value));
`);
  const env = { ...process.env, HERDR_HARNESS_GH: JSON.stringify([process.execPath, stub]) };
  const commit = (dir, text) => {
    writeFileSync(join(dir, 'a.txt'), text);
    git(dir, 'commit', '-q', '-am', text.trim());
    return git(dir, 'rev-parse', 'HEAD');
  };
  const prs = value => writeFileSync(responses, JSON.stringify(value));
  const merged = (number, oid, extra = {}) => ({ number, state: 'MERGED', mergeCommit: { oid }, mergedAt: '2026-11-20T00:00:00Z',
    url: `https://github.com/acme/app/pull/${number}`, headRefName: 'sw/sw-0122-x', ...extra });
  return { temp, origin, repo, other, setup, env, commit, prs, merged, log: () => readFileSync(join(temp, 'gh.log'), 'utf8') };
}

const task = (extra = {}) => ({ id: 'SW-0122', project: 'fx', title: 'SW-0122', state: 'BLOCKED', awaiting: 'flow-delivery-blocked', pending: null,
  branch: 'sw/sw-0122-x', current: null, depends: [], created: '2026-11-19T00:00:00.000Z', updated: '2026-11-20T00:00:00.000Z',
  runs: [{ stage: 'qa', round: 1, status: 'ended', outcome: 'PASS' }],
  history: [{ at: '2026-11-20T00:00:00.000Z', from: 'QA', to: 'BLOCKED', why: 'strict main 보호 근거 불충분' }],
  x_flow: { version: 2, phase: 'delivery-blocked', delivery: { pr: 1131 }, verification: { verdict: 'PASS' } }, ...extra });
const input = (extra = {}) => ({ pr: 1131, explicit: true, evidence: { quote: '병합된 블록 정리해', source: 'SW Lead t1t1 2026-11-21' }, terminal: 't-lead', ...extra });

test('PR이 MERGED이고 병합 커밋이 지금 원격 main에 있으면 확인하고, 로컬 origin/main이 낡아도 최신 main을 직접 조회한다', t => {
  const f = fixture(t);
  const merge = f.commit(f.repo, 'merged\n');
  git(f.repo, 'push', '-q', 'origin', 'main');
  // 다른 clone이 main을 더 앞으로 민다. repo의 origin/main은 낡은 채로 남는다.
  f.setup(f.other);
  git(f.other, 'pull', '-q', 'origin', 'main');
  f.commit(f.other, 'later\n');
  git(f.other, 'push', '-q', 'origin', 'main');
  const tip = git(f.other, 'rev-parse', 'HEAD');
  f.prs({ 1131: f.merged(1131, merge) });
  const result = verify(f.repo, 1131, f.env);
  assert.deepEqual(result, { repo: 'github.com/acme/app', pr: 1131, url: 'https://github.com/acme/app/pull/1131', merge, main: tip, branch: 'sw/sw-0122-x', mergedAt: '2026-11-20T00:00:00Z' });
  assert.match(f.log(), /"pr","view","1131","--repo","github\.com\/acme\/app","--json"/);
});

test('GH_HOST가 다른 호스트를 가리켜도 origin의 GitHub 호스트를 --repo에 넣어 조회한다', t => {
  const f = fixture(t);
  const merge = f.commit(f.repo, 'merged\n');
  git(f.repo, 'push', '-q', 'origin', 'main');
  f.prs({ 1131: f.merged(1131, merge) });
  assert.equal(verify(f.repo, 1131, { ...f.env, GH_HOST: 'qa-enterprise.invalid' }).repo, 'github.com/acme/app');
  assert.match(f.log(), /"--repo","github\.com\/acme\/app"/);
});

test('미병합·다른 번호·SHA 없음·조회 실패·GitHub 아닌 origin·main에 없는 병합 커밋·낡은 tracking ref는 거부한다', t => {
  const f = fixture(t);
  const base = git(f.repo, 'rev-parse', 'HEAD');
  // 별도 브랜치에만 있는 커밋.
  git(f.repo, 'checkout', '-q', '-b', 'side');
  const side = f.commit(f.repo, 'side\n');
  git(f.repo, 'push', '-q', 'origin', 'side');
  git(f.repo, 'checkout', '-q', 'main');
  // 원격에 없는 로컬 커밋을 origin/main tracking ref에만 둔다.
  const stale = f.commit(f.repo, 'local only\n');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', stale);
  f.prs({ 1: { ...f.merged(1, base), state: 'OPEN', mergeCommit: null }, 2: { ...f.merged(2, base), state: 'CLOSED' }, 3: f.merged(4, base),
    5: f.merged(5, null), 6: f.merged(6, side), 7: f.merged(7, stale), 8: f.merged(8, base) });
  assert.throws(() => verify(f.repo, 1, f.env), /병합되지 않았다\(OPEN\)/);
  assert.throws(() => verify(f.repo, 2, f.env), /병합되지 않았다\(CLOSED\)/);
  assert.throws(() => verify(f.repo, 3, f.env), /번호가 다르다/);
  assert.throws(() => verify(f.repo, 5, f.env), /병합 커밋 SHA가 없다/);
  assert.throws(() => verify(f.repo, 6, f.env), /현재 원격 main.*에 없다/);
  assert.throws(() => verify(f.repo, 7, f.env), /현재 원격 main.*에 없다/);
  assert.throws(() => verify(f.repo, 9, f.env), /gh pr view 9 실패/);
  assert.throws(() => verify(f.repo, 0, f.env), /PR 번호/);
  assert.equal(verify(f.repo, 8, f.env).merge, base);
  git(f.repo, 'remote', 'set-url', 'origin', f.origin);
  assert.throws(() => verify(f.repo, 8, f.env), /GitHub 저장소가 아니다/);
});

test('사용자 승인 종결: 상태·phase·QA 결과·최초 게시 기록과 무관하게 DONE과 closure·history를 남기고 진행 회차를 끝낸다', () => {
  const verified = { repo: 'github.com/acme/app', pr: 1131, url: 'https://github.com/acme/app/pull/1131', merge: 'a'.repeat(40), main: 'b'.repeat(40), branch: 'sw/sw-0122-x', mergedAt: null };
  const cases = [
    task(),
    task({ state: 'QA', awaiting: null, x_flow: { version: 2, phase: 'publish', verification: { verdict: 'PASS' } } }),
    task({ state: 'QA', awaiting: null, x_flow: { version: 2, phase: 'ci', delivery: { pr: 1131 }, verification: { verdict: 'PASS' } } }),
    task({ state: 'READY_TO_IMPLEMENT', pending: 'implement', x_flow: { version: 2, phase: 'repair', verification: { verdict: 'FAIL' } } }),
    task({ state: 'BLOCKED', x_flow: { version: 2, phase: 'blocked', verification: null } }),
  ];
  for (const original of cases) {
    const { task: done, event } = accept(original, input(), verified, { now: NOW });
    assert.deepEqual([done.state, done.pending, done.awaiting, done.current, done.updated, done.x_flow.phase], ['DONE', null, null, null, NOW, 'closed']);
    assert.deepEqual(done.x_flow.closure, { kind: KIND, pr: 1131, url: verified.url, merge: verified.merge, main: verified.main, branch: 'sw/sw-0122-x', explicit: true,
      at: NOW, terminal: 't-lead', evidence: { quote: '병합된 블록 정리해', source: 'SW Lead t1t1 2026-11-21' },
      previousState: original.state, previousPhase: original.x_flow.phase });
    assert.deepEqual(done.history.slice(0, -1), original.history);
    assert.deepEqual(done.history.at(-1), { at: NOW, from: original.state, to: 'DONE', why: `사용자 승인 병합 종결: PR #1131 병합 ${'a'.repeat(12)}`, closure: done.x_flow.closure });
    assert.deepEqual(event, { at: NOW, project: 'fx', task: 'SW-0122', event: 'x_flow', from: original.state, to: 'DONE', phase: 'closed', closure: KIND, pr: 1131, merge: verified.merge });
    // 기존 QA·게시 기록은 감사 근거로 남는다.
    assert.deepEqual(done.x_flow.verification, original.x_flow.verification);
    assert.deepEqual(done.runs, original.runs);
    validateLedger({ version: 1, project: 'fx', tasks: { [done.id]: done } }, 'fx');
  }
  // 진행 중 회차는 종결 사실로 끝내 늦은 수집이 다시 판정하지 못한다.
  const running = task({ state: 'IMPLEMENTING', current: { run: 1, stage: 'implement' }, x_flow: { version: 2, phase: 'repair' },
    runs: [{ stage: 'qa', round: 1, status: 'ended', outcome: 'FAIL' }, { stage: 'implement', status: 'running', token: 'r2' }] });
  const closed = accept(running, input(), verified, { now: NOW }).task;
  assert.equal(closed.current, null);
  assert.deepEqual(closed.runs[1], { stage: 'implement', status: 'ended', token: 'r2', ended: NOW, outcome: 'closed', note: `사용자 승인 병합 종결: PR #1131 병합 ${'a'.repeat(12)}` });
  // 연결된 번호만 쓰면 PR 브랜치가 업무 브랜치와 같아야 한다. Lead가 번호를 직접 지정하면 받는다.
  const other = { ...verified, branch: 'sw/other' };
  assert.throws(() => accept(task(), input({ explicit: false }), other, { now: NOW }), /업무 브랜치 sw\/sw-0122-x와 다르다/);
  assert.equal(accept(task(), input(), other, { now: NOW }).task.x_flow.closure.branch, 'sw/other');
  // 거부: DONE 재종결, v1, 원문·출처·터미널 누락, 다른 PR 결과.
  assert.throws(() => accept(task({ state: 'DONE' }), input(), verified), /이미 DONE/);
  assert.throws(() => accept(task({ x_flow: { version: 1 } }), input(), verified), /v2 업무가 아니다/);
  assert.throws(() => accept(task(), input({ evidence: { source: 's' } }), verified), /원문/);
  assert.throws(() => accept(task(), input({ evidence: { quote: 'q', source: ' ' } }), verified), /출처/);
  assert.throws(() => accept(task(), input({ terminal: '' }), verified), /터미널/);
  assert.throws(() => accept(task(), input({ pr: 1 }), verified), /요청한 PR과 다르다/);
});

test('공통 runtime workflow accept-merged: 검증된 binding의 release·저장소로 판정하고, 기능 없는 release와 미병합은 거부한다', t => {
  const f = fixture(t);
  const merge = f.commit(f.repo, 'merged\n');
  git(f.repo, 'push', '-q', 'origin', 'main');
  f.prs({ 1131: f.merged(1131, merge), 1132: { ...f.merged(1132, merge), state: 'OPEN' }, 1133: f.merged(1133, merge, { headRefName: 'sw/other' }) });
  const built = build();
  const manifest = JSON.parse(readFileSync(join(built.release, 'manifest.json'), 'utf8'));
  assert.ok(Object.hasOwn(manifest.files, 'core/merged-closure.cjs'));
  const state = join(f.repo, '.local/state'), file = join(state, 'harness-binding.json');
  mkdirSync(state, { recursive: true });
  const bind = release => writeFileSync(file, JSON.stringify({ version: 1, project: 'fx', release: release.release, manifestHash: release.manifestHash, cwd: f.repo }));
  bind(built);
  const saved = process.env.HERDR_HARNESS_GH;
  process.env.HERDR_HARNESS_GH = f.env.HERDR_HARNESS_GH;
  t.after(() => { if (saved === undefined) delete process.env.HERDR_HARNESS_GH; else process.env.HERDR_HARNESS_GH = saved; });
  const call = extra => workflow(file, { project: 'fx', stateDir: state, action: 'accept-merged', task: task(), evidence: input().evidence, terminal: 't-lead', now: NOW, ...extra });
  const done = call({ pr: 1131, explicit: true });
  assert.deepEqual([done.task.state, done.task.x_flow.closure.merge, done.task.x_flow.closure.explicit], ['DONE', merge, true]);
  // pr을 생략하면 연결된 PR(delivery.pr)을 쓰고 명시 지정으로 올리지 않는다.
  assert.equal(call({ explicit: true }).task.x_flow.closure.explicit, false);
  assert.throws(() => call({ pr: 1132, explicit: true }), /병합되지 않았다\(OPEN\)/);
  assert.throws(() => call({ pr: 1133 }), /업무 브랜치 .*와 다르다/);
  assert.throws(() => workflow(file, { project: 'other', stateDir: state, action: 'accept-merged', task: task() }), /연결 경계/);
  // 이 기능이 없는 고정 release는 실행하지 않는다.
  const legacy = mkdtempSync(join(tmpdir(), 'hh-merged-legacy-'));
  t.after(() => rmSync(legacy, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  cpSync(built.release, legacy, { recursive: true });
  rmSync(join(legacy, 'core/merged-closure.cjs'));
  delete manifest.files['core/merged-closure.cjs'];
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(legacy, 'manifest.json'), raw);
  bind({ release: legacy, manifestHash: hash(raw) });
  assert.throws(() => call({ pr: 1131, explicit: true }), /사용자 승인 병합 종결을 지원하지 않는다/);
});
