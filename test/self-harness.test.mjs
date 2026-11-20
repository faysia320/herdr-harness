import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { build, root } from '../scripts/build.mjs';
import { adapter, git, samePath } from '../.agents/harness/repository.mjs';
import { suiteInvocation } from '../.agents/harness/suite.mjs';
import { archiveKeep } from '../.agents/harness/cleanup.mjs';
import { closeTerminal } from '../.agents/harness/stages.mjs';

const frozenRelease = process.env.HH_TEST_PINNED_RELEASE;
const built = frozenRelease ? { release: frozenRelease, manifestHash: frozenRelease.split(/[\\/]/).at(-1) } : build();
const prefix = ['.agents/harness', 'adapters/runtime.cjs', '.gitignore', 'package.json', 'bin/harness.mjs',
  'core/process.js', 'core/preparation.mjs', 'core/metrics.mjs', 'core/qa-receipt-policy.cjs', 'core/dev14.cjs', 'policy/qa-receipt.json'];
// 검증 계획 실행 위치 분류·해소 결정 주입 표지. HH_TEST_PINNED_RELEASE가 이전 release면 기존 계획 형식으로 분기한다.
const scopedRelease = createRequire(import.meta.url)(join(built.release, 'core/workflow.cjs')).planScopeVersion === 1;
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

// 기능 일부를 뺀 release 사본. manifest를 다시 만들어 binding 검증은 통과한다.
function patchedRelease(t, change) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  cpSync(built.release, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  change(dir, manifest);
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(dir, 'manifest.json'), raw);
  return { release: dir, manifestHash: adapter.hash(raw) };
}
// 정리 모듈이 없는 release(현재 고정 설치본과 같은 상태).
const legacyRelease = t => patchedRelease(t, (dir, manifest) => {
  rmSync(join(dir, 'core/worktree-cleanup.cjs'), { force: true });
  delete manifest.files['core/worktree-cleanup.cjs'];
});
// 실행 위치 분류·해소 결정 조회가 없는 release. 표지와 새 진입점을 지우고, 결정함은 새 조회를 모르는 쓰기 명령으로 받아 거부한다.
// 표지만 지운 사본과 달리 어댑터가 새 조회를 부르면 위임이 실패하므로 «호출하지 않음»을 증명한다.
const preScopeRelease = t => patchedRelease(t, (dir, manifest) => {
  const edit = (file, change) => {
    const bytes = Buffer.from(change(readFileSync(join(dir, file), 'utf8')));
    writeFileSync(join(dir, file), bytes);
    manifest.files[file] = adapter.hash(bytes);
  };
  edit('core/workflow.cjs', text => text + "\nfor (const name of ['planScopeVersion', 'freezePlan', 'remainingVerification', 'missingRemaining']) delete module.exports[name];\n");
  edit('core/decision-store.js', text => text.replaceAll("action === 'resolved-for-task'", "action === 'pre-scope'"));
});
const refExists = (repo, branch) => spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/' + branch], { cwd: repo }).status === 0;

// 임시 저장소에 자체 어댑터를 복사하고 가짜 Herdr로 Lead·위임 터미널을 흉내 낸다. 실제 삭제는 이 저장소 안에서만 일어난다.
async function setup(t) {
  const fixture = {};
  const repo = mkdtempSync(join(tmpdir(), 'hh-flow-'));
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const relative of prefix) {
    const dest = join(repo, relative);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(root, relative), dest, { recursive: true });
  }
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'HH fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/faysia320/herdr-harness.git');
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  git(repo, 'add', '--', ...prefix, 'tracked.txt');
  git(repo, 'commit', '-m', 'fixture base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', base);
  const state = join(repo, '.local/hh-harness'), binding = join(state, 'harness-binding.json');
  const cliPath = join(repo, '.agents/harness/hh.mjs');
  writeJson(binding, { version: 1, project: 'herdr-harness', release: built.release, manifestHash: built.manifestHash, cwd: repo,
    command: [process.execPath, cliPath], adapterConfig: join(repo, '.agents/harness/config.json') });
  const { main } = await import(pathToFileURL(cliPath));
  const sessions = new Map([['t-lead', { state: 'live' }], ['t-other', { state: 'live' }]]);
  const launches = [], kills = [];
  function herdr(cwd, args) {
    assert.ok(samePath(cwd, repo));
    if (args[0] === 'get') {
      const failure = fixture.lookupFails?.(args[1]);
      if (failure) throw new Error(typeof failure === 'string' ? failure : 'fixture hc unavailable');
      return sessions.get(args[1]) ?? null;
    }
    if (args[0] === 'kill') {
      kills.push(args[1]);
      const session = sessions.get(args[1]);
      session.state = 'finished';
      return session;
    }
    assert.equal(args[0], 'run');
    launches.push(args);
    const labels = Object.fromEntries(args.filter(a => /^harness\./.test(a)).map(a => a.split('=')));
    const address = 'stage-' + launches.length;
    const session = { address, state: 'live', labels };
    sessions.set(address, session);
    sessions.set(args[args.indexOf('--name') + 1], session);
    return session;
  }
  const run = (args, terminal = 't-lead', options = {}) => main(args.split(' '), { cwd: repo, terminal, herdr, ...options });
  const ledgerFile = join(state, 'ledger.json'), eventsFile = join(state, 'events.jsonl');
  const stored = () => [readFileSync(ledgerFile, 'utf8'), readFileSync(eventsFile, 'utf8')];
  const close = (id, evidence, terminal = 't-lead') => main(['flow-close', id, ...(evidence === undefined ? [] : ['--evidence', evidence])],
    { cwd: repo, terminal, herdr });
  const refused = async (action, pattern) => {
    const before = stored();
    await assert.rejects(action, pattern);
    assert.deepEqual(stored(), before);
  };
  const launcher = join(repo, '.agents/harness/launch.mjs');
  const viaLauncher = (...args) => spawnSync(process.execPath, [launcher, '--binding', binding, ...args],
    { cwd: repo, encoding: 'utf8', windowsHide: true });
  return Object.assign(fixture, { repo, base, state, binding, main, sessions, launches, kills, herdr, run, ledgerFile, eventsFile, stored, close, refused,
    launcher, viaLauncher, ledger: () => JSON.parse(readFileSync(ledgerFile, 'utf8')),
    edit: change => { const value = JSON.parse(readFileSync(ledgerFile, 'utf8')); change(value); writeFileSync(ledgerFile, JSON.stringify(value, null, 2) + '\n'); } });
}

test('HH fixture: launcher, Lead ownership, stage collection, frozen QA, commit and decision gates', async t => {
  const fixture = await setup(t);
  const { repo, base, state, binding, main, sessions, launches, herdr, run, ledgerFile, stored, close, refused, launcher, viaLauncher } = fixture;
  const who = viaLauncher('whoami');
  assert.equal(who.status, 0, who.stderr);
  assert.equal(JSON.parse(who.stdout).releaseHash, built.manifestHash);
  const foreign = join(repo, '.local/foreign/harness-binding.json');
  writeJson(foreign, { ...JSON.parse(readFileSync(binding)), project: 'foreign' });
  const launchForeign = spawnSync(process.execPath, [launcher, '--binding', foreign, 'whoami'], { cwd: repo, encoding: 'utf8' });
  assert.equal(launchForeign.status, 2);
  const rawForeign = spawnSync(process.execPath, [join(built.release, 'bin/harness.mjs'), '--binding', foreign, 'whoami'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, HERDR_HARNESS_ENTRY_BINDING: binding, HERDR_HARNESS_ENTRY_PID: String(process.pid) } });
  assert.equal(rawForeign.status, 2);
  const foreignThroughCommon = spawnSync(process.execPath, [join(repo, 'bin/harness.mjs'), '--binding', foreign, 'whoami'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, HERDR_HARNESS_ENTRY_BINDING: binding, HERDR_HARNESS_ENTRY_PID: String(process.pid) } });
  assert.equal(foreignThroughCommon.status, 2);
  await run('recover');
  assert.equal(viaLauncher('decision', 'list').status, 0);
  await assert.rejects(run('recover', 't-other'), /기존 Lead/);
  fixture.lookupFails = address => address === 't-lead';
  await assert.rejects(run('recover', 't-other'), /unavailable/);
  fixture.lookupFails = null;
  const request = join(repo, '.local/request.txt');
  writeFileSync(request, 'Update the fixture accurately.\n');
  const add = ['add','--title','Fixture','--desc-file',request,'--workflow','v2','--kind','feature','--slug','fixture','--authorization','Fixture authorization'];
  await assert.rejects(main(add, { cwd: repo, terminal: 't-other', herdr }), /살아 있는 Lead/);
  const task = await main(add, { cwd: repo, terminal: 't-lead', herdr });
  assert.equal(task.state, 'QUEUED');
  assert.equal(task.base, base);
  await assert.rejects(main(add, { cwd: repo, terminal: 't-lead', herdr }), /동일|같은 업무/);
  assert.equal(viaLauncher('publisher-command', task.id).status, 2);
  const research = (await run('next --go')).run;
  assert.equal(research.model, 'gpt-6.2-astra');
  await assert.rejects(run('dispatch ' + task.id), /위임 가능한/);
  await assert.rejects(run('collect ' + task.id), /아직 실행 중/);
  writeJson(join(research.dir, 'research.json'), { run: research.token, summary: 'fixture AC1 and suite', planned_files: ['tracked.txt'] });
  const plan = { run: research.token, version: 2, criteria: ['AC1'], checks: ['hh-suite'],
    ...(scopedRelease ? { checkScopes: [{ id: 'hh-suite', location: 'independent-qa', executor: 'hh-suite', criteria: ['AC1'] }] } : {}) };
  writeJson(join(research.dir, 'verification-plan.json'), { ...plan, checks: ['hh-suite','hh-suite'] });
  await assert.rejects(run('collect ' + task.id), /필수 검사 ID/);
  if (scopedRelease) {
    // 새 release의 동결은 실행 위치 분류가 없는 기존 형식 계획을 받지 않는다.
    const { checkScopes, ...legacyPlan } = plan;
    writeJson(join(research.dir, 'verification-plan.json'), legacyPlan);
    await refused(() => run('collect ' + task.id), /실행 위치 분류/);
  }
  writeJson(join(research.dir, 'verification-plan.json'), plan);
  assert.equal((await run('collect ' + task.id)).state, 'READY_TO_IMPLEMENT');
  // 정상 수집 뒤 그 회차의 위임 터미널을 닫는다.
  assert.deepEqual([sessions.get(research.terminal).state, fixture.ledger().tasks[task.id].runs[0].x_terminal.outcome], ['finished', 'killed']);
  await refused(() => close(task.id, 'fixture exception'), /게시 대기/);
  const implementation = (await run('dispatch ' + task.id)).run;
  assert.equal(implementation.model, 'claude-opus-5-5');
  const target = join(task.worktree, 'tracked.txt');
  writeFileSync(target, 'candidate\n');
  writeFileSync(join(task.worktree, 'outside.txt'), 'out of scope\n');
  writeJson(join(implementation.dir, 'implement.json'), { run: implementation.token, verdict: 'DONE', summary: 'fixture implementation',
    checks: [{ command: 'fixture validation', exit: 0 }, { command: 'for QA', exit: null }] });
  await assert.rejects(run('collect ' + task.id), /예정 경로 밖/);
  rmSync(join(task.worktree, 'outside.txt'));
  // 산출물을 쓴 뒤에도 턴을 이어 가는 에이전트는 수집해도 닫지 않는다.
  sessions.get(implementation.terminal).status = { state: 'working' };
  const implemented = await run('collect ' + task.id);
  const kept = implemented.runs[1].x_terminal;
  assert.deepEqual([kept.outcome, sessions.get(implementation.terminal).state], ['kept', 'live']);
  assert.match(kept.reason, /작업 중/);
  await refused(() => close(task.id, 'fixture exception'), /게시 대기/);
  writeJson(join(research.dir, 'verification-plan.json'), { ...plan, criteria: ['replaced'] });
  const qa = (await run('dispatch ' + task.id)).run;
  assert.equal(qa.model, 'gpt-6.2-sol');
  assert.notEqual(qa.terminal, implementation.terminal);
  await refused(() => close(task.id, 'fixture exception'), /게시 대기/);
  const reportFile = join(qa.dir, 'verification.json'), receiptFile = join(task.worktree, 'target/hh-verify/latest-qa.json');
  const report = { run: qa.token, version: 2, verdict: 'PASS', candidate: implemented.candidate.fingerprint, findings: [],
    criteria: [{ id: 'AC1', status: 'passed', evidence: 'fixture contents' }],
    checks: [{ id: 'hh-suite', command: 'fixture', status: 'passed', evidence: 'fixture log' }] };
  writeJson(reportFile, { ...report, criteria: [{ ...report.criteria[0], id: 'replaced' }] });
  await assert.rejects(run('collect ' + task.id), /검증 누락/);
  writeJson(reportFile, { ...report, checks: [report.checks[0], report.checks[0]] });
  await assert.rejects(run('collect ' + task.id), /중복/);
  writeJson(reportFile, report);
  await assert.rejects(run('collect ' + task.id), /latest-qa.json/);
  const tap = tests => ['TAP version 13', '# tests ' + tests, '# suites 0', '# pass ' + tests, '# fail 0',
    '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 5.5', ''].join('\n');
  const saveLog = (stdout, stderr = '') => {
    const result = { argv: suiteInvocation({ binding: built }), exit: 0, run: qa.token, tree: implemented.candidate.tree,
      stdoutLength: stdout.length, tests: 1 };
    const log = [JSON.stringify(result), stdout, stderr].join('\n');
    writeFileSync(join(qa.dir, 'hh-suite.log'), log);
    return { id: 'hh-suite', state: 'passed', exit: 0, tests: 1, logDigest: adapter.hash(log) };
  };
  const receipt = { run: qa.token, version: 1, role: 'qa', stable: true, base, scope: 'changed-paths',
    tree: implemented.candidate.tree, completedAt: new Date().toISOString(), checks: [saveLog(tap(1))],
    releaseHash: built.manifestHash, terminal: qa.terminal };
  writeJson(receiptFile, { ...receipt, terminal: implementation.terminal });
  await assert.rejects(run('collect ' + task.id), /현재 QA 세션/);
  writeJson(receiptFile, { ...receipt, checks: [{ id: 'hh-suite', state: 'passed' }] });
  await assert.rejects(run('collect ' + task.id), /영수증·로그/);
  writeJson(receiptFile, { ...receipt, checks: [saveLog(tap(0))] });
  await assert.rejects(run('collect ' + task.id), /영수증·로그/);
  writeJson(receiptFile, { ...receipt, checks: [saveLog('fixture without a test summary\n', tap(1))] });
  await assert.rejects(run('collect ' + task.id), /영수증·로그/);
  writeJson(receiptFile, { ...receipt, checks: [saveLog(tap(1))] });
  writeFileSync(target, 'changed after dispatch\n');
  await assert.rejects(run('collect ' + task.id), /후보가 변경/);
  writeFileSync(target, 'candidate\n');
  assert.equal((await run('collect ' + task.id)).x_flow.phase, 'publish');
  assert.equal(sessions.get(qa.terminal).state, 'finished');
  assert.ok((await main(['--help'])).commands.includes('flow-close'));
  assert.ok((await main(['--help'])).commands.includes('cleanup-worktree'));
  await refused(() => main(['flow-close', '--evidence', 'fixture exception'], { cwd: repo, terminal: 't-lead', herdr }), /위치 인자/);
  await refused(() => main(['flow-close', task.id, task.id, '--evidence', 'x'], { cwd: repo, terminal: 't-lead', herdr }), /위치 인자/);
  await refused(() => close(task.id, 'fixture exception', 't-other'), /살아 있는 Lead/);
  assert.equal(viaLauncher('flow-close', task.id, '--evidence', 'fixture exception').status, 2);
  await refused(() => close('HH-999', 'fixture exception'), /업무 ID/);
  await refused(() => close(task.id), /--evidence/);
  await refused(() => close(task.id, '   '), /--evidence/);
  writeFileSync(target, 'changed after QA\n');
  await refused(() => close(task.id, 'fixture exception'), /QA 이후 후보/);
  writeFileSync(target, 'candidate\n');
  const verifiedLedger = readFileSync(ledgerFile, 'utf8');
  const forged = [
    [t => { t.x_flow.delivery = { pr: 7 }; }, /PR이 연결되지 않은/],
    [t => { t.x_flow.phase = 'ci'; }, /PR이 연결되지 않은/],
    [t => { t.state = 'BLOCKED'; t.x_flow.phase = 'delivery-blocked'; }, /PR이 연결되지 않은/],
    [t => { t.pending = 'qa'; }, /PR이 연결되지 않은/],
    [t => { t.x_flow.verification.verdict = 'FAIL'; }, /독립 QA PASS/],
    [t => { t.x_flow.verification.candidate = 'other'; }, /독립 QA PASS/],
    [t => { delete t.x_flow.runner; }, /독립 QA PASS/],
  ];
  for (const [change, pattern] of forged) {
    const ledger = JSON.parse(verifiedLedger);
    change(ledger.tasks[task.id]);
    writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');
    await refused(() => close(task.id, 'fixture exception'), pattern);
  }
  writeFileSync(ledgerFile, verifiedLedger);
  assert.equal(JSON.parse(viaLauncher('publisher-command', task.id).stdout).model, 'gpt-6-luna');
  const question = join(repo, '.local/question.json');
  writeJson(question, { task: task.id.toLowerCase(), question: 'Fixture decision?', source: 'isolated fixture' });
  await main(['decision','request','fixture','--file',question], { cwd: repo, terminal: 't-lead', herdr });
  await refused(() => close(task.id, 'fixture exception'), /미해소/);
  await assert.rejects(run('publish-check ' + task.id, 't-other'), /미해소/);
  const answer = join(repo, '.local/answer.json');
  writeJson(answer, { quote: 'Fixture answer', source: 'isolated fixture input' });
  await main(['decision','resolve','fixture','--file',answer,'--revision','1'], { cwd: repo, terminal: 't-lead', herdr });
  // PASS한 QA 지시서에 없던 결정이다. Lead가 계획 영향 없음을 기록하기 전에는 게시·예외 종결하지 않는다.
  await assert.rejects(run('publish-check ' + task.id, 't-other'), /QA 이후 해소된 결정의 계획 영향을 판정하지 않았다: fixture revision 2/);
  await refused(() => close(task.id, 'fixture exception'), /QA 이후 해소된 결정/);
  const reviewed = await run('flow-resume ' + task.id + ' --decision fixture --revision 2 --evidence no-plan-impact');
  assert.deepEqual([reviewed.state, reviewed.phase, reviewed.reviewed.id, reviewed.reviewed.revision], ['QA', 'publish', 'fixture', 2]);
  const allowed = await run('publish-check ' + task.id, 't-other');
  // QA runner가 이 회차의 QA 실행 영수증을 남기지 않았으면 envelope 줄을 돌려주지 않는다.
  assert.deepEqual([allowed.allowed, allowed.qaReceipt], [true, undefined]);
  git(task.worktree, 'add', '--', 'tracked.txt');
  git(task.worktree, 'commit', '-m', 'verified candidate');
  const proof = await run('publish-check ' + task.id + ' --committed', 't-other');
  assert.equal(proof.committed.tree, implemented.candidate.tree);
  git(task.worktree, 'update-index', '--chmod=+x', 'tracked.txt');
  git(task.worktree, 'commit', '-m', 'different mode');
  await assert.rejects(run('publish-check ' + task.id + ' --committed', 't-other'), /tree와 독립 QA|미커밋|mode/);
  git(task.worktree, 'reset', '--hard', base);
  writeFileSync(target, 'candidate\n');
  await refused(() => run('cleanup-worktree ' + task.id), /DONE 업무만/);
  // 정리 모듈이 없는 옛 release로 종결해도 DONE과 예외 근거는 남고, 정리 실패 사유와 재시도 명령을 돌려준다.
  const pinned = readFileSync(binding, 'utf8');
  writeJson(binding, { ...JSON.parse(pinned), ...legacyRelease(t) });
  const events = stored()[1].split('\n').length;
  // DONE 직후 자동 정리와 Lead 재시도가 공통 정리에 넘기는 내용 확인 한도를 기록한다.
  const { adapter: used } = await import(pathToFileURL(join(repo, '.agents/harness/repository.mjs')));
  const limits = [], forward = used.worktreeCleanup;
  used.worktreeCleanup = (file, input) => { limits.push(input.task.limits); return forward(file, input); };
  t.after(() => { used.worktreeCleanup = forward; });
  const closed = await close(task.id, '  사용자 승인 fixture: PR 없는 검증 업무  ');
  const saved = JSON.parse(readFileSync(ledgerFile, 'utf8')).tasks[task.id];
  const last = saved.history.at(-1);
  assert.deepEqual(closed.closure, { kind: 'policy-exception', at: last.at, terminal: 't-lead',
    evidence: '사용자 승인 fixture: PR 없는 검증 업무', previousPhase: 'publish', qaVerdict: 'PASS' });
  assert.deepEqual([saved.state, saved.pending, saved.awaiting, saved.x_flow.phase], ['DONE', null, null, 'closed']);
  assert.deepEqual([last.from, last.to, last.why], ['QA', 'DONE', '정책 예외 종결: 사용자 승인 fixture: PR 없는 검증 업무']);
  assert.deepEqual(saved.x_flow.closure, closed.closure);
  assert.deepEqual(last.closure, closed.closure);
  assert.equal(saved.x_flow.delivery ?? null, null);
  assert.equal(saved.x_flow.runner.tree, implemented.candidate.tree);
  const retry = 'node .agents/harness/launch.mjs cleanup-worktree ' + task.id;
  assert.deepEqual([closed.cleanup.status, closed.cleanup.retry, saved.x_cleanup.status], ['failed', retry, 'failed']);
  assert.match(closed.cleanup.reasons.join('\n'), /지원하지 않는다/);
  assert.ok(existsSync(task.worktree));
  assert.equal(stored()[1].split('\n').length, events + 2);
  assert.ok(archiveKeep(Object.values(fixture.ledger().tasks), new Set()).includes(task.id));
  writeFileSync(binding, pinned);
  // 수집 때 닫지 않은 구현 회차의 터미널이 살아 있으면 아무것도 지우지 않고 사유를 남긴다.
  const blocked = (await run('cleanup-worktree ' + task.id)).cleanup;
  assert.deepEqual([blocked.status, blocked.retry, fixture.ledger().tasks[task.id].x_cleanup.status], ['refused', retry, 'refused']);
  assert.match(blocked.reasons.join('\n'), new RegExp('살아 있는 위임 터미널.*' + implementation.terminal));
  assert.equal(readFileSync(target, 'utf8'), 'candidate\n');
  // 터미널 조회가 실패하면 상태를 알 수 없으므로 지우지 않는다.
  fixture.lookupFails = address => address === implementation.terminal;
  const unknown = (await run('cleanup-worktree ' + task.id)).cleanup;
  assert.equal(unknown.status, 'refused');
  assert.match(unknown.reasons.join('\n'), /확인하지 못했다.*unavailable/);
  assert.equal(readFileSync(target, 'utf8'), 'candidate\n');
  // hc가 제거된 터미널을 not_found로 알리면 없는 터미널로 본다.
  fixture.lookupFails = address => address === implementation.terminal && '{"error":{"kind":"not_found","message":"' + address + ' was removed"}}';
  // stat 정보(크기·mtime 초)가 같아 status가 숨긴 같은 길이 수정은 내용 해시로 찾아 지우지 않는다.
  const hidden = join(task.worktree, 'core/metrics.mjs'), original = readFileSync(hidden), stamp = new Date('2020-01-02T03:04:05.000Z');
  git(task.worktree, 'config', 'core.trustctime', 'false');
  git(task.worktree, 'config', 'core.checkStat', 'minimal');
  utimesSync(hidden, stamp, stamp);
  git(task.worktree, 'update-index', '-q', '--refresh');
  const changed = Buffer.from(original);
  changed[0] ^= 1;
  writeFileSync(hidden, changed);
  utimesSync(hidden, stamp, stamp);
  assert.equal(git(task.worktree, 'status', '--porcelain', '--', 'core/metrics.mjs'), '');
  const unseen = (await run('cleanup-worktree ' + task.id)).cleanup;
  assert.deepEqual([unseen.status, unseen.retry, fixture.ledger().tasks[task.id].x_cleanup.status], ['refused', retry, 'refused']);
  assert.match(unseen.reasons.join('\n'), /status에 나오지 않은 작업 사본 변경.*core\/metrics\.mjs/);
  assert.deepEqual([readFileSync(hidden), readFileSync(target, 'utf8')], [changed, 'candidate\n']);
  writeFileSync(hidden, original);
  utimesSync(hidden, stamp, stamp);
  // 재시도는 후보를 patch로 보존한 뒤 worktree를 지우고 예외 종결 브랜치는 남긴다.
  const cleaned = (await run('cleanup-worktree ' + task.id)).cleanup;
  fixture.lookupFails = null;
  sessions.get(implementation.terminal).state = 'finished';
  assert.equal(cleaned.status, 'done', cleaned.reasons.join('\n'));
  assert.equal(existsSync(task.worktree), false);
  assert.ok(refExists(repo, task.branch));
  assert.deepEqual([cleaned.branch.state, cleaned.patch.paths, cleaned.patch.tree], ['kept', ['tracked.txt'], implemented.candidate.tree]);
  assert.equal(adapter.hash(readFileSync(join(state, cleaned.patch.file))), cleaned.patch.sha256);
  assert.deepEqual(Object.keys(cleaned.preserved.files), ['target/hh-verify/latest-qa.json']);
  assert.equal(fixture.ledger().tasks[task.id].x_cleanup.status, 'done');
  assert.equal(archiveKeep(Object.values(fixture.ledger().tasks), new Set()).includes(task.id), false);
  const settled = stored();
  assert.deepEqual((await run('cleanup-worktree ' + task.id)).cleanup, cleaned);
  assert.deepEqual(stored(), settled);
  // 자동 정리는 watch-delivery 한 회(180초) 안에 들어가는 한도, Lead 재시도는 더 긴 한도다.
  assert.deepEqual(limits, [{ contentMs: 60000 }, ...Array(limits.length - 1).fill({ contentMs: 600000 })]);
  assert.equal(limits.length, 6);
  assert.equal((await run('flow-status ' + task.id, 't-other')).flow.closure.kind, 'policy-exception');
  await refused(() => close(task.id, 'fixture exception'), /게시 대기/);
  assert.equal(launches.length, 3);
  assert.equal(JSON.parse(readFileSync(binding)).project, 'herdr-harness');
});

test('수집 뒤 터미널 종료: 대장에 기록된 그 회차의 레이블이 맞는 터미널만 닫고 나머지는 사유를 남긴다', () => {
  const task = { id: 'HH-001' }, run = { terminal: 't-run', token: 'tok' }, ledger = { lead: { terminal: 't-lead' } };
  const labels = { 'harness.project': 'herdr-harness', 'harness.task': 'HH-001', 'harness.run': 'tok' };
  const calls = [];
  // kill 응답(kill)과 kill 뒤 재조회(after)를 따로 정한다. Error는 hc 실패로 던진다.
  const ctx = (session, { kill, after } = {}) => {
    let killed = false;
    return { herdr: args => {
      calls.push(args);
      const value = args[0] === 'kill' ? kill ?? { ...session, state: 'finished' } : killed ? after ?? { ...session, state: 'finished' } : session;
      killed ||= args[0] === 'kill';
      if (value instanceof Error) throw value;
      return value;
    } };
  };
  const close = (session, r = run, replies) => closeTerminal(ctx(session, replies), ledger, task, r);
  assert.deepEqual([close({ state: 'live', labels }).outcome, close({ state: 'live', labels }).after], ['killed', 'finished']);
  assert.deepEqual(calls.slice(0, 3).map(c => c.join(' ')), ['get t-run', 'kill t-run', 'get t-run']);
  // hc가 제거된 터미널을 not_found로 알리면 kill 실패여도 다시 조회해 제거를 확인한다.
  const removed = new Error('{"error":{"kind":"not_found","message":"t-run was removed"}}');
  const gone = close({ state: 'live', labels }, run, { kill: removed, after: removed });
  assert.deepEqual([gone.outcome, gone.after, gone.kill], ['killed', 'removed', removed.message]);
  assert.equal(close(removed).outcome, 'absent');
  // kill 뒤에도 살아 있거나 상태를 확인하지 못하면 killed로 보고하지 않는다.
  const stuck = close({ state: 'live', labels }, run, { kill: { state: 'live', labels }, after: { state: 'live', labels } });
  assert.equal(stuck.outcome, 'still-live');
  assert.match(stuck.reason, /살아 있다/);
  const refusedKill = close({ state: 'live', labels }, run, { kill: new Error('fixture kill refused'), after: { state: 'live', labels } });
  assert.deepEqual([refusedKill.outcome, refusedKill.kill], ['still-live', 'fixture kill refused']);
  const unknown = close({ state: 'live', labels }, run, { after: new Error('fixture hc unavailable') });
  assert.equal(unknown.outcome, 'unknown');
  assert.match(unknown.reason, /확인하지 못했다.*unavailable/);
  calls.length = 0;
  for (const [session, r, pattern] of [
    [{ state: 'live', labels }, { ...run, terminal: 't-lead' }, /Lead 터미널/],
    [{ state: 'live', labels: { ...labels, 'harness.task': 'HH-002' } }, run, /레이블/],
    [{ state: 'live', labels: { ...labels, 'harness.run': 'other' } }, run, /레이블/],
    [{ state: 'live' }, run, /레이블/],
    [new Error('fixture hc unavailable'), run, /unavailable/],
    [{ state: 'live', labels, status: { state: 'working' } }, run, /작업 중/],
    [{ state: 'live', labels }, { token: 'tok' }, /주소가 없다/],
  ]) {
    const result = close(session, r);
    assert.equal(result.outcome, 'kept');
    assert.match(result.reason, pattern);
  }
  assert.equal(calls.some(c => c[0] === 'kill'), false);
  assert.equal(close(null).outcome, 'absent');
  assert.equal(close({ state: 'finished', labels }).outcome, 'finished');
});

test('병합 증명 경로: flow-deliver --apply·flow-prove-merged 직후 공통 정리를 부르고, 증명과 다른 브랜치는 지우지 않는다', async t => {
  const fixture = await setup(t);
  const { repo, base, main, herdr, run } = fixture;
  await run('recover');
  const request = join(repo, '.local/request.txt');
  writeFileSync(request, 'Merged fixture.\n');
  const { context, candidate } = await import(pathToFileURL(join(repo, '.agents/harness/repository.mjs')));
  const ctx = context(repo, herdr);
  // 원격 GitHub 대신 QA PASS 뒤 PR이 연결된 상태를 대장 편집으로 만든다. 병합 결과는 main의 프로세스 내 주입으로만 바꾼다.
  const publish = async slug => {
    const task = await main(['add', '--title', slug, '--desc-file', request, '--workflow', 'v2', '--kind', 'feature', '--slug', slug,
      '--authorization', 'Fixture authorization'], { cwd: repo, terminal: 't-lead', herdr });
    writeFileSync(join(task.worktree, 'tracked.txt'), slug + '\n');
    git(task.worktree, 'add', '--', 'tracked.txt');
    git(task.worktree, 'commit', '-m', slug);
    const current = candidate(ctx, task);
    const anchor = { head: current.head, base, tree: current.tree };
    fixture.edit(ledger => Object.assign(ledger.tasks[task.id], { state: 'QA', pending: null, candidate: current,
      x_flow: { ...ledger.tasks[task.id].x_flow, phase: 'ci', verification: { verdict: 'PASS', candidate: current.fingerprint },
        delivery: { pr: 9, url: 'https://github.com/faysia320/herdr-harness/pull/9', ...anchor, original: anchor } } }));
    return { ...task, anchor };
  };
  const proof = (task, extra = {}) => ({ phase: 'merged', pr: 9, url: 'https://github.com/faysia320/herdr-harness/pull/9', head: task.anchor.head,
    branch: task.branch, merge: base, base, tree: task.anchor.tree, original: task.anchor, ...extra });
  // DEV-14 동기화로 PR head가 앞서도 로컬 tip이 최초 게시 anchor면 증명과 일치한다. squash 브랜치는 -d 거부 뒤 -D로 지운다.
  const a = await publish('merged-apply');
  const synced = git(repo, 'commit-tree', a.anchor.tree, '-p', a.anchor.head, '-m', 'sync main');
  const inputs = [];
  const applied = await run('flow-deliver ' + a.id + ' --apply', 't-lead', { delivery: input => { inputs.push(input); return proof(a, { head: synced }); } });
  assert.equal(inputs[0].apply, true);
  assert.deepEqual([applied.phase, applied.cleanup.status, applied.cleanup.branch.state, applied.cleanup.branch.method, applied.cleanup.branch.tip],
    ['merged', 'done', 'deleted', '-D', a.anchor.head]);
  assert.equal(existsSync(a.worktree), false);
  assert.equal(refExists(repo, a.branch), false);
  const savedA = fixture.ledger().tasks[a.id];
  assert.deepEqual([savedA.state, savedA.x_flow.delivery.branch, savedA.x_flow.delivery.head, savedA.x_cleanup.status], ['DONE', a.branch, synced, 'done']);
  // 브랜치 이름이 없는 옛 증명은 DONE을 유지하고 정리를 거부한다.
  const b = await publish('merged-proof');
  const legacy = await run('flow-prove-merged ' + b.id, 't-lead', { delivery: () => { const { branch, ...rest } = proof(b); return rest; } });
  assert.deepEqual([legacy.phase, fixture.ledger().tasks[b.id].state, legacy.cleanup.status], ['merged', 'DONE', 'refused']);
  assert.match(legacy.cleanup.reasons.join('\n'), /브랜치 이름이 없다/);
  assert.ok(existsSync(b.worktree) && refExists(repo, b.branch));
  // 증명 뒤 업무 브랜치에 다른 커밋이 생기면 -D 조건(tip=증명 head)이 깨져 worktree도 브랜치도 지우지 않는다.
  writeFileSync(join(b.worktree, 'tracked.txt'), 'after merge\n');
  git(b.worktree, 'commit', '-am', 'after merge');
  const moved = await run('flow-prove-merged ' + b.id, 't-lead', { delivery: () => proof(b) });
  assert.equal(moved.cleanup.status, 'refused');
  assert.match(moved.cleanup.reasons.join('\n'), /병합 증명의 head와 다르다/);
  assert.ok(existsSync(b.worktree) && refExists(repo, b.branch));
  assert.ok(archiveKeep(Object.values(fixture.ledger().tasks), new Set()).includes(b.id));
  git(b.worktree, 'reset', '--hard', b.anchor.head);
  const retried = (await run('cleanup-worktree ' + b.id)).cleanup;
  assert.deepEqual([retried.status, retried.branch.method, retried.branch.tip], ['done', '-D', b.anchor.head]);
  assert.equal(existsSync(b.worktree), false);
  assert.equal(refExists(repo, b.branch), false);
  assert.equal(archiveKeep(Object.values(fixture.ledger().tasks), new Set()).includes(b.id), false);
});

test('사용자 승인 병합 종결: flow-accept-merged는 Lead만 실행해 DONE·closure·정리를 남기고, 미병합·main 미포함·비Lead·재종결은 대장을 바꾸지 않는다', async t => {
  const fixture = await setup(t);
  const { repo, base, main, herdr, run, refused, sessions } = fixture;
  await run('recover');
  assert.ok((await main(['--help'])).commands.includes('flow-accept-merged'));
  const request = join(repo, '.local/request.txt');
  writeFileSync(request, 'Accepted fixture.\n');
  const add = async slug => {
    const task = await main(['add', '--title', slug, '--desc-file', request, '--workflow', 'v2', '--kind', 'feature', '--slug', slug,
      '--authorization', 'Fixture authorization'], { cwd: repo, terminal: 't-lead', herdr });
    writeFileSync(join(task.worktree, 'tracked.txt'), slug + '\n');
    git(task.worktree, 'commit', '-am', slug);
    return { ...task, head: git(task.worktree, 'rev-parse', 'HEAD') };
  };
  const quote = ['--evidence', '병합된 블록 정리해', '--source', 'Lead t244 2026-11-21'];
  // 고정 release에 기능이 없으면(HH_TEST_PINNED_RELEASE가 이전 release) 대장을 바꾸지 않고 지원하지 않음을 알린다.
  if (!existsSync(join(built.release, 'core/merged-closure.cjs'))) {
    const old = await add('accepted-legacy');
    await refused(() => main(['flow-accept-merged', old.id, '--pr', '9', ...quote], { cwd: repo, terminal: 't-lead', herdr }), /지원하지 않는다/);
    return;
  }
  // 원격 GitHub 대신 PR·main 조회만 바꾼다. DONE 기록은 build한 release의 공통 판정(accept)이 만든다.
  const api = createRequire(import.meta.url)(join(built.release, 'core/merged-closure.cjs'));
  const remote = { 9: { state: 'MERGED', onMain: true }, 10: { state: 'OPEN' }, 11: { state: 'MERGED', onMain: false } };
  const calls = [];
  const acceptMerged = input => {
    calls.push(input);
    const pr = remote[input.pr];
    if (pr.state !== 'MERGED') throw new Error(`PR #${input.pr}가 병합되지 않았다(${pr.state}).`);
    if (!pr.onMain) throw new Error(`PR #${input.pr}의 병합 커밋이 현재 원격 main에 없다.`);
    return api.accept(input.task, input, { pr: input.pr, url: 'https://github.com/faysia320/herdr-harness/pull/' + input.pr, merge: base, main: base,
      branch: 'hh/elsewhere', mergedAt: null }, { now: input.now });
  };
  const accept = (id, args, terminal = 't-lead') => main(['flow-accept-merged', id, ...args], { cwd: repo, terminal, herdr, acceptMerged });
  // a: 병합 증명이 막힌 BLOCKED 업무. 업무 브랜치가 main에 병합돼 있어 -d로 지운다.
  const a = await add('accepted-blocked');
  fixture.edit(ledger => Object.assign(ledger.tasks[a.id], { state: 'BLOCKED', pending: null, awaiting: 'flow-delivery-blocked',
    x_flow: { ...ledger.tasks[a.id].x_flow, phase: 'delivery-blocked', verification: { verdict: 'PASS' }, delivery: { pr: 9 } } }));
  git(repo, 'merge', '--no-ff', '-m', 'merge ' + a.branch, a.branch);
  // b: 최초 게시 기록 없이 repair 중 진행 회차가 있는 업무. squash로 병합돼 로컬 tip은 미병합이다.
  const b = await add('accepted-repair');
  sessions.set('stage-b', { state: 'finished', labels: {} });
  fixture.edit(ledger => Object.assign(ledger.tasks[b.id], { state: 'IMPLEMENTING', pending: null, current: { run: 0, stage: 'implement' },
    runs: [{ stage: 'implement', token: 'tok-b', terminal: 'stage-b', status: 'running', dir: join(repo, '.local/run-b') }],
    x_flow: { ...ledger.tasks[b.id].x_flow, phase: 'repair', verification: null } }));
  // 거부는 대장·사건·worktree를 바꾸지 않는다.
  await refused(() => accept(a.id, ['--pr', '9', ...quote], 't-other'), /살아 있는 Lead/);
  await refused(() => accept(a.id, ['--pr', '10', ...quote]), /병합되지 않았다\(OPEN\)/);
  await refused(() => accept(a.id, ['--pr', '11', ...quote]), /현재 원격 main에 없다/);
  await refused(() => accept(a.id, quote), /--pr/);
  await refused(() => accept(a.id, ['--pr', '9', '--evidence', '병합된 블록 정리해']), /--source/);
  // 주입 없이 CLI 경로는 고정 release의 runtime 판정을 부른다. gh 대역이 실패하면 저장 전에 거부한다(네트워크를 쓰지 않는다).
  const savedGh = process.env.HERDR_HARNESS_GH;
  process.env.HERDR_HARNESS_GH = JSON.stringify([process.execPath, '-e', 'process.exit(1)']);
  try { await refused(() => main(['flow-accept-merged', a.id, '--pr', '9', ...quote], { cwd: repo, terminal: 't-lead', herdr }), /gh pr view 9 실패/); }
  finally { if (savedGh === undefined) delete process.env.HERDR_HARNESS_GH; else process.env.HERDR_HARNESS_GH = savedGh; }
  assert.ok(existsSync(a.worktree) && refExists(repo, a.branch));
  const closedA = await accept(a.id, ['--pr', '9', ...quote]);
  assert.equal(calls.at(-1).explicit, true);
  assert.equal(calls.at(-1).terminal, 't-lead');
  assert.deepEqual([closedA.state, closedA.phase, closedA.cleanup.status, closedA.cleanup.branch.state, closedA.cleanup.branch.method], ['DONE', 'closed', 'done', 'deleted', '-d']);
  assert.equal(existsSync(a.worktree), false);
  assert.equal(refExists(repo, a.branch), false);
  const savedA = fixture.ledger().tasks[a.id];
  assert.deepEqual(savedA.x_flow.closure, { kind: 'merged-accepted', pr: 9, url: 'https://github.com/faysia320/herdr-harness/pull/9', merge: base, main: base,
    branch: 'hh/elsewhere', explicit: true, at: savedA.updated, terminal: 't-lead', evidence: { quote: '병합된 블록 정리해', source: 'Lead t244 2026-11-21' },
    previousState: 'BLOCKED', previousPhase: 'delivery-blocked' });
  assert.deepEqual([savedA.state, savedA.awaiting, savedA.history.at(-1).from, savedA.history.at(-1).to, savedA.x_cleanup.status], ['DONE', null, 'BLOCKED', 'DONE', 'done']);
  assert.deepEqual(savedA.x_flow.delivery, { pr: 9 });
  const events = readFileSync(fixture.eventsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(e => e.event === 'x_flow' && e.task === a.id && e.closure === 'merged-accepted' && e.pr === 9 && e.merge === base));
  // 재호출은 기존 종결 근거·history를 덮어쓰지 않는다.
  await refused(() => accept(a.id, ['--pr', '9', ...quote]), /이미 DONE/);
  const closedB = await accept(b.id, ['--pr', '9', ...quote]);
  assert.deepEqual([closedB.state, closedB.closure.previousState, closedB.closure.previousPhase, closedB.cleanup.status], ['DONE', 'IMPLEMENTING', 'repair', 'done']);
  assert.deepEqual([closedB.cleanup.branch.state, closedB.cleanup.branch.tip], ['kept', b.head]);
  assert.equal(existsSync(b.worktree), false);
  assert.equal(git(repo, 'rev-parse', 'refs/heads/' + b.branch), b.head);
  const savedB = fixture.ledger().tasks[b.id];
  assert.deepEqual([savedB.current, savedB.runs[0].status, savedB.runs[0].outcome], [null, 'ended', 'closed']);
  // 진행하던 회차의 늦은 수집은 DONE을 바꾸지 못한다.
  await refused(() => run('collect ' + b.id), /수집할 실행이 없다/);
});

const promptOf = run => readFileSync(join(run.dir, 'prompt.txt'), 'utf8');
// 지시서의 해소 결정 JSON 줄. 결정 주입이 없으면 null이다.
const injected = run => {
  const line = promptOf(run).split('\n').find(l => l.startsWith('해소 결정: '));
  return line ? JSON.parse(line.slice('해소 결정: '.length)) : null;
};
// 현재 QA 회차가 고정 release로 hh-suite를 통과한 것처럼 runner 로그·영수증을 쓴다.
function passSuite(fixture, task, qa, candidate) {
  const stdout = ['TAP version 13', '# tests 1', '# suites 0', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 5.5', ''].join('\n');
  const log = [JSON.stringify({ argv: suiteInvocation({ binding: built }), exit: 0, run: qa.token, tree: candidate.tree, stdoutLength: stdout.length, tests: 1 }), stdout, ''].join('\n');
  writeFileSync(join(qa.dir, 'hh-suite.log'), log);
  writeJson(join(task.worktree, 'target/hh-verify/latest-qa.json'), { run: qa.token, version: 1, role: 'qa', stable: true, base: fixture.base, scope: 'changed-paths',
    tree: candidate.tree, completedAt: new Date().toISOString(), checks: [{ id: 'hh-suite', state: 'passed', exit: 0, tests: 1, logDigest: adapter.hash(log) }],
    releaseHash: built.manifestHash, terminal: qa.terminal });
}

test('HH 검증 계획 실행 위치·해소 결정 인계: 결정 충돌 → 재조사·재동결 → 새 QA → PR 본문 남은 검증', async t => {
  // 고정 release에 기능이 없으면(HH_TEST_PINNED_RELEASE가 이전 release) 아래 기존 동작 시험이 이 경계를 확인한다.
  if (!scopedRelease) return;
  const fixture = await setup(t);
  const { repo, main, herdr, run, refused } = fixture;
  await run('recover');
  const request = join(repo, '.local/request.txt');
  writeFileSync(request, 'Copy the title exactly.\n');
  const add = slug => main(['add', '--title', slug, '--desc-file', request, '--workflow', 'v2', '--kind', 'feature', '--slug', slug,
    '--authorization', 'Fixture authorization'], { cwd: repo, terminal: 't-lead', herdr });
  const task = await add('scope'), other = await add('other');
  const lead = { cwd: repo, terminal: 't-lead', herdr };
  const ask = (key, question) => { writeJson(join(repo, '.local/q.json'), question); return main(['decision', 'request', key, '--file', join(repo, '.local/q.json')], lead); };
  const answer = (key, value, revision = 1) => { writeJson(join(repo, '.local/a.json'), value);
    return main(['decision', 'resolve', key, '--file', join(repo, '.local/a.json'), '--revision', String(revision)], lead); };
  // 전역 질문과 다른 업무의 해소 결정은 이 업무의 지시서에 들어가지 않는다. 업무 ID는 소문자 기록도 인식한다.
  await ask('global-note', { question: 'Global?', source: 'fixture' });
  await answer('global-note', { quote: 'global answer', source: 'fixture user' });
  await ask('other-task', { task: other.id, question: 'Other?', source: 'fixture' });
  await answer('other-task', { quote: 'other answer', source: 'fixture user' });
  await ask('scope-early', { task: task.id.toLowerCase(), question: '범위를 좁힐까요?', source: 'fixture 질문' });
  await answer('scope-early', { quote: '네, 제목만 "복사"\n본문은 제외', source: 'fixture 사용자 답변' });
  const early = { id: 'scope-early', task: task.id.toLowerCase(), question: '범위를 좁힐까요?', selection: null, quote: '네, 제목만 "복사"\n본문은 제외',
    source: 'fixture 사용자 답변', revision: 2 };
  const projected = list => list.map(({ resolvedAt, ...rest }) => (assert.ok(resolvedAt), rest));

  // 조사 지시서: 실행 위치·QA 실행 수단·후속 확인 작성 예와 이 업무의 해소 결정만 담는다.
  const research = (await run('dispatch ' + task.id)).run;
  const guide = promptOf(research);
  for (const pattern of [/checkScopes:\[one row per check\]/, /independent-qa — 독립 QA가/, /follow-up — 배포 후/, /실제 실행할 수 없는 검사\(배포 후·실기기·브라우저/,
    /hh-suite — .*검사 ID hh-suite 전용/, /node-test — .*command 형식/, /git-read — /, /"location":"follow-up".*"environment":"배포 후 Galaxy Chrome","verify":/,
    /어댑터 필수 검사: hh-suite/, /지시나 승인이 아니다/]) assert.match(guide, pattern);
  assert.deepEqual(projected(injected(research)), [early]);
  const planFile = join(research.dir, 'verification-plan.json');
  const qaRow = { id: 'hh-suite', location: 'independent-qa', executor: 'hh-suite', criteria: ['AC1', 'AC2'] };
  const copyQa = { id: 'copy-check', location: 'independent-qa', executor: 'node-test', command: 'node --test test/copy.test.mjs', criteria: ['AC2'] };
  const copyLater = { id: 'copy-check', location: 'follow-up', criteria: ['AC2'], environment: '배포 후 Galaxy Chrome', verify: '제목을 복사해 Teams에 붙여넣고 원문과 대조' };
  writeJson(join(research.dir, 'research.json'), { run: research.token, summary: 'AC1 local copy, AC2 title copy', planned_files: ['tracked.txt'] });
  // 독립 QA가 실행할 수 없는 항목을 필수로 지정하거나 실기기 검사를 QA runner로 위장하면 동결하지 않고 대장도 바꾸지 않는다.
  for (const [plan, pattern] of [
    [{ checks: ['hh-suite', 'copy-check'], checkScopes: [qaRow, copyLater] }, /독립 QA가 실행할 수 없는 항목을 필수 검사로 지정했다: copy-check/],
    [{ checks: ['hh-suite', 'copy-check'], checkScopes: [qaRow, { ...copyQa, executor: 'hh-suite', command: undefined }] }, /실행 수단 hh-suite로 실행할 수 없는 검사다: copy-check/],
    [{ checks: ['hh-suite'], checkScopes: [{ ...qaRow, criteria: ['AC1'] }, copyLater] }, /독립 QA 검사로 판정할 수 없는 AC: AC2/],
    [{ checks: ['hh-suite'], checkScopes: [qaRow, { ...copyLater, location: ['follow-up'] }] }, /지원하지 않는 실행 위치: copy-check/],
    // 후보를 그대로 두어야 하는 QA 수단으로 후보 파일을 쓰는 Git 명령을 필수 검사에 넣을 수 없다.
    [{ checks: ['hh-suite', 'copy-check'], checkScopes: [qaRow, { ...copyQa, executor: 'git-read', command: 'git diff --output=tracked.txt' }] },
      /실행 수단 git-read의 명령 형식과 다르다: copy-check/],
    // QA runner 전용 hh-suite 행에 배포 사이트를 여는 명령을 적으면 그 명령을 버리고 동결하지 않는다.
    [{ checks: ['hh-suite'], checkScopes: [{ ...qaRow, command: 'chrome https://example.com/deployed/mobile-copy' }, copyLater] },
      /ID 전용 실행 수단 hh-suite에는 command를 적지 않는다.*: hh-suite/],
    // 후속 확인 방법이 빈 링크의 title에만 있으면 PR 화면에 보이지 않는다. 마크다운·HTML 문법 없는 일반 문장만 동결한다.
    [{ checks: ['hh-suite'], checkScopes: [qaRow, { ...copyLater, verify: '[](https://example.com "Copy the title and compare it against the clipboard")' }] },
      /후속 확인 verify에 링크·이미지 대괄호.*일반 문장만 받는다.*: copy-check/],
  ]) {
    writeJson(planFile, { run: research.token, version: 2, criteria: ['AC1', 'AC2'], ...plan });
    const runs = readdirSync(join(fixture.state, 'tasks', task.id, 'runs')).length;
    await refused(() => run('collect ' + task.id), pattern);
    assert.equal(readdirSync(join(fixture.state, 'tasks', task.id, 'runs')).length, runs);
  }
  writeJson(planFile, { run: research.token, version: 2, criteria: ['AC1', 'AC2'], checks: ['hh-suite', 'copy-check'], checkScopes: [qaRow, copyQa] });
  assert.equal((await run('collect ' + task.id)).state, 'READY_TO_IMPLEMENT');
  assert.deepEqual(fixture.ledger().tasks[task.id].x_flow.plan,
    { version: 2, criteria: ['AC1', 'AC2'], checks: ['hh-suite', 'copy-check'], checkScopes: [qaRow, copyQa] });

  const implement = async decisions => {
    const implementation = (await run('dispatch ' + task.id)).run;
    assert.deepEqual(projected(injected(implementation)).map(d => d.id), decisions);
    writeFileSync(join(task.worktree, 'tracked.txt'), 'title copy\n');
    writeJson(join(implementation.dir, 'implement.json'), { run: implementation.token, verdict: 'DONE', summary: 'copy title', checks: [{ command: 'node --test test/copy.test.mjs', exit: 0 }] });
    return run('collect ' + task.id);
  };
  await implement(['scope-early']);
  // 열린 결정이 있으면 QA를 위임하지 않는다. 해소 뒤 위임한 QA 지시서에는 선택·답변 원문·출처·revision이 그대로 들어간다.
  await ask('browser-check', { task: task.id, question: '제목 복사 브라우저 확인은 언제 할까요?', source: 'QA BLOCKED 보고',
    options: [{ label: '배포 후 실기기 확인', impact: 'QA PASS를 막지 않고 PR 남은 검증으로 넘긴다' }, { label: 'QA에서 브라우저 실행', impact: '' }] });
  const runsBefore = readdirSync(join(fixture.state, 'tasks', task.id, 'runs')).length;
  await refused(() => run('dispatch ' + task.id), /미해소/);
  assert.equal(readdirSync(join(fixture.state, 'tasks', task.id, 'runs')).length, runsBefore);
  await assert.rejects(answer('browser-check', { quote: 'x', source: 'fixture', selection: '추측한 선택' }), /selection/);
  const said = '[사용자 결정 · Herdr 하네스 모드] 질문 browser-check(revision 1)의 답: "배포 후 실기기 확인"';
  await answer('browser-check', { quote: said, source: 'Herdr 하네스 모드 사용자 선택', selection: '배포 후 실기기 확인' });
  const browser = { id: 'browser-check', task: task.id, question: '제목 복사 브라우저 확인은 언제 할까요?', selection: '배포 후 실기기 확인', quote: said,
    source: 'Herdr 하네스 모드 사용자 선택', revision: 2 };
  const qa1 = (await run('dispatch ' + task.id)).run;
  assert.deepEqual(projected(injected(qa1)), [browser, early]);
  assert.match(promptOf(qa1), /충돌한 필수 검사를 blocked로 적고 kind=decision finding/);
  const candidate = fixture.ledger().tasks[task.id].candidate;
  const verdict = (verdict, checks, findings = []) => ({ version: 2, verdict, candidate: candidate.fingerprint, findings,
    criteria: [{ id: 'AC1', status: 'passed', evidence: 'local copy' }, { id: 'AC2', status: verdict === 'PASS' ? 'passed' : 'unverified', evidence: 'title copy' }],
    checks: checks.map(([id, status]) => ({ id, command: id === 'hh-suite' ? 'QA runner' : 'node --test test/copy.test.mjs', status, evidence: 'fixture log' })) });
  const conflict = { id: 'D1', kind: 'decision', signature: 'browser-check-r2', evidence: '결정 browser-check revision 2가 copy-check를 배포 후 실기기 확인으로 옮긴다',
    next: '재조사로 copy-check를 후속 확인으로 옮겨 다시 동결한다' };
  writeJson(join(qa1.dir, 'verification.json'), { ...verdict('BLOCKED', [['hh-suite', 'passed'], ['copy-check', 'blocked']], [conflict]), run: qa1.token });
  assert.equal((await run('collect ' + task.id)).state, 'BLOCKED');

  // 결정 근거로 재조사한다. 기존 회차·계획 파일은 남고, 새 조사 지시서에 두 결정이 들어간다.
  const resumed = await run('flow-resume ' + task.id + ' --stage research --evidence browser-check-r2:copy-check-after-deploy');
  assert.deepEqual([resumed.state, resumed.pending, fixture.ledger().tasks[task.id].x_flow.plan], ['RESEARCHING', 'research', null]);
  assert.ok(existsSync(planFile));
  const research2 = (await run('dispatch ' + task.id)).run;
  assert.deepEqual(projected(injected(research2)), [browser, early]);
  assert.match(promptOf(research2), /조사는 결정을 계획에 반영/);
  writeJson(join(research2.dir, 'research.json'), { run: research2.token, summary: 'browser-check r2: copy-check → follow-up', planned_files: ['tracked.txt'] });
  writeJson(join(research2.dir, 'verification-plan.json'), { run: research2.token, version: 2, criteria: ['AC1', 'AC2'], checks: ['hh-suite'], checkScopes: [qaRow, copyLater] });
  assert.equal((await run('collect ' + task.id)).state, 'READY_TO_IMPLEMENT');
  assert.deepEqual(fixture.ledger().tasks[task.id].x_flow.plan.checkScopes, [qaRow, copyLater]);
  await implement(['browser-check', 'scope-early']);

  // 새 QA는 후속 확인을 실행·기록하지 않는다. 보고에 넣으면 상태와 무관하게 수집을 거부한다.
  const qa2 = (await run('dispatch ' + task.id)).run;
  assert.match(promptOf(qa2), /후속 확인 항목은 실행하지도 checks에 적지도 않는다: copy-check/);
  assert.deepEqual(projected(injected(qa2)), [browser, early]);
  passSuite(fixture, task, qa2, candidate);
  for (const status of ['passed', 'blocked']) {
    writeJson(join(qa2.dir, 'verification.json'), { ...verdict(status === 'passed' ? 'PASS' : 'BLOCKED', [['hh-suite', 'passed'], ['copy-check', status]],
      status === 'passed' ? [] : [conflict]), run: qa2.token });
    await refused(() => run('collect ' + task.id), /후속 확인은 QA가 실행하거나 checks에 기록하지 않는다: copy-check/);
  }
  writeJson(join(qa2.dir, 'verification.json'), { ...verdict('PASS', [['hh-suite', 'passed']]), run: qa2.token });
  const passed = await run('collect ' + task.id);
  assert.equal(passed.x_flow.phase, 'publish');
  assert.match(passed.runs.at(-1).note, /남은 검증 1건/);

  // 게시 인계: publish-check와 flow-status가 남은 검증 줄과 이 업무의 결정을 돌려준다.
  const line = 'copy-check (AC2) | 환경: 배포 후 Galaxy Chrome | 확인: 제목을 복사해 Teams에 붙여넣고 원문과 대조';
  const remainingItem = { id: 'copy-check', criteria: ['AC2'], environment: '배포 후 Galaxy Chrome', verify: '제목을 복사해 Teams에 붙여넣고 원문과 대조', line };
  // QA runner가 같은 회차에 남긴 QA 실행 영수증 줄(무시 경로)을 게시자에게 그대로 넘긴다.
  const envelope = '<!-- herdr-qa-receipt:v2 ' + Buffer.from('{"kind":"herdr-qa-receipt"}').toString('base64url') + ' -->';
  const envelopeFile = join(task.worktree, 'target/hh-verify/receipts', qa2.token, 'envelope.txt');
  mkdirSync(dirname(envelopeFile), { recursive: true });
  writeFileSync(envelopeFile, envelope + '\n');
  const check = await run('publish-check ' + task.id, 't-other');
  assert.deepEqual(check.qaReceipt, { file: envelopeFile, line: envelope });
  assert.deepEqual(check.remainingVerification, [remainingItem]);
  assert.deepEqual(projected(check.decisions), [browser, early]);
  assert.deepEqual((await run('flow-status ' + task.id, 't-other')).remainingVerification, [remainingItem]);
  const published = readFileSync(fixture.ledgerFile, 'utf8');

  // PR 연결: 실제 PR 조회 본문에 남은 검증 줄이 모두 있어야 한다. 환경·방법 하나라도 빠지면 대장을 바꾸지 않고 빠진 줄을 알려 준다.
  git(task.worktree, 'add', '--', 'tracked.txt');
  git(task.worktree, 'commit', '-m', 'verified candidate');
  const head = git(task.worktree, 'rev-parse', 'HEAD');
  const pr = body => () => ({ number: 5, url: 'https://github.com/faysia320/herdr-harness/pull/5', state: 'OPEN', isCrossRepository: false, isDraft: false,
    headRefName: task.branch, headRefOid: head, baseRefName: 'main', body });
  const attach = body => main(['flow-attach-pr', task.id, '--pr', '5'], { ...lead, prView: pr(body) });
  for (const body of [null, '', '## 남은 검증\n- copy-check (AC2) | 확인: 제목을 복사해 Teams에 붙여넣고 원문과 대조',
    '## 남은 검증\n- copy-check (AC2) | 환경: 배포 후 Galaxy Chrome', 'mobile-copy-check copy-check',
    // 정상 후속 확인을 지우고 템플릿 HTML 주석의 예시만 남긴 본문은 PR 화면에 남은 검증이 보이지 않는다.
    '## 남은 검증\n<!-- 예시:\n- [ ] copy-check (AC2) | 환경: 배포 후 Galaxy Chrome | 확인: 제목을 복사해 Teams에 붙여넣고 원문과 대조\n-->\n',
    // HTML 속성 안에만 있는 줄도 화면에 보이지 않는다.
    '## 남은 검증\n<div title="internal fixture\n- [ ] ' + line + '\n">Template</div>\n'])
    await refused(() => attach(body), new RegExp('남은 검증.*' + line.replace(/[|()]/g, '\\$&') + '.*목록 항목'));
  // 정상 게시 예: 인라인 코드의 리터럴 주석 표식은 주석이 아니므로 뒤의 목록 줄이 그대로 보인다.
  // 남은 검증 목록 뒤 줄 맨 앞의 QA 실행 영수증 주석은 목록 판정을 바꾸지 않는다.
  const attached = await attach('## 검증\r\nQA PASS. 템플릿 표식 `<!--`는 지웠다.\r\n\r\n## 남은 검증\r\n- [ ] copy-check (AC2) | 환경: 배포 후  Galaxy Chrome | 확인: 제목을 복사해 Teams에 붙여넣고 원문과 대조\r\n\r\n' + envelope + '\r\n');
  assert.deepEqual([attached.phase, attached.pr], ['ci', 5]);
  // 병합 판정에는 동결 계획이 그대로 넘어가 공통 delivery가 병합 직전 본문을 다시 대조한다.
  const inputs = [];
  await run('flow-deliver ' + task.id, 't-lead', { delivery: input => { inputs.push(input); return { phase: 'ci', ready: false, reasons: ['fixture'] }; } });
  assert.deepEqual(inputs[0].flow.plan.checkScopes, [qaRow, copyLater]);

  // PR 없이 예외 종결하면 남은 검증이 종결 기록에 남는다.
  writeFileSync(fixture.ledgerFile, published);
  git(task.worktree, 'reset', '--hard', fixture.base);
  writeFileSync(join(task.worktree, 'tracked.txt'), 'title copy\n');
  const closed = await fixture.close(task.id, 'fixture: PR 없는 검증 업무');
  assert.deepEqual(closed.closure.remainingVerification, [remainingItem]);
  assert.deepEqual(fixture.ledger().tasks[task.id].x_flow.closure.remainingVerification, [remainingItem]);
});

test('HH 게시 대기 중 계획 변경 결정: QA·게시 허가 철회 → 재조사·재동결 → 새 QA → 게시 인계', async t => {
  if (!scopedRelease) return;
  const fixture = await setup(t);
  const { repo, main, herdr, run, refused } = fixture;
  const lead = { cwd: repo, terminal: 't-lead', herdr };
  await run('recover');
  const request = join(repo, '.local/request.txt');
  writeFileSync(request, 'Check title copy in the correct environment.\n');
  const add = slug => main(['add', '--title', slug, '--desc-file', request, '--workflow', 'v2', '--kind', 'feature', '--slug', slug,
    '--authorization', 'fixture'], lead);
  const task = await add('late-decision'), other = await add('other');
  const ask = (key, question) => { writeJson(join(repo, '.local/q.json'), question); return main(['decision', 'request', key, '--file', join(repo, '.local/q.json')], lead); };
  const answer = (key, value) => { writeJson(join(repo, '.local/a.json'), value);
    return main(['decision', 'resolve', key, '--file', join(repo, '.local/a.json'), '--revision', '1'], lead); };
  const suiteRow = { id: 'hh-suite', location: 'independent-qa', executor: 'hh-suite', criteria: ['AC1'] };
  const copyQa = { id: 'copy-check', location: 'independent-qa', executor: 'git-read', command: 'git diff -- tracked.txt', criteria: ['AC1'] };
  const copyLater = { id: 'copy-check', location: 'follow-up', criteria: ['AC1'], environment: 'On device after deployment', verify: 'Copy the title and compare with the source' };
  // 조사 → 구현 → 독립 QA PASS 한 바퀴. QA는 동결 계획의 독립 QA 검사만 보고한다.
  const cycle = async checkScopes => {
    const research = (await run('dispatch ' + task.id)).run;
    const checks = checkScopes.filter(r => r.location === 'independent-qa').map(r => r.id);
    writeJson(join(research.dir, 'research.json'), { run: research.token, summary: 'title copy plan', planned_files: ['tracked.txt'] });
    writeJson(join(research.dir, 'verification-plan.json'), { run: research.token, version: 2, criteria: ['AC1'], checks, checkScopes });
    await run('collect ' + task.id);
    const implementation = (await run('dispatch ' + task.id)).run;
    writeFileSync(join(task.worktree, 'tracked.txt'), 'copied title\n');
    writeJson(join(implementation.dir, 'implement.json'), { run: implementation.token, verdict: 'DONE', summary: 'updated title',
      checks: [{ command: 'git diff -- tracked.txt', exit: 0 }] });
    const implemented = await run('collect ' + task.id);
    const qa = (await run('dispatch ' + task.id)).run;
    passSuite(fixture, task, qa, implemented.candidate);
    writeJson(join(qa.dir, 'verification.json'), { run: qa.token, version: 2, candidate: implemented.candidate.fingerprint, verdict: 'PASS',
      criteria: [{ id: 'AC1', status: 'passed', evidence: 'fixture evidence' }], findings: [],
      checks: checks.map(id => ({ id, command: id === 'hh-suite' ? 'QA runner' : 'git diff -- tracked.txt', status: 'passed', evidence: 'fixture evidence' })) });
    assert.equal((await run('collect ' + task.id)).x_flow.phase, 'publish');
    return { research, qa };
  };
  await cycle([suiteRow, copyQa]);
  assert.equal((await run('publish-check ' + task.id, 't-other')).allowed, true);

  // QA PASS 뒤 계획을 바꾸는 결정이 생겼다. 열린 동안은 물론 해소한 뒤에도 Lead가 판정하기 전에는 게시하지 않는다.
  await ask('copy-timing', { task: task.id, question: 'When to check copy?', source: 'publisher report',
    options: [{ label: 'On device after deployment', impact: 'follow-up' }, { label: 'In QA', impact: '' }] });
  await assert.rejects(run('publish-check ' + task.id, 't-other'), /미해소/);
  const quote = 'Move copy-check from required QA to follow-up on device after deployment.';
  await answer('copy-timing', { selection: 'On device after deployment', quote, source: 'fixture user' });
  // 다른 업무의 결정은 이 업무의 게시를 막지 않는다.
  await ask('other-late', { task: other.id, question: 'Other?', source: 'fixture' });
  await answer('other-late', { quote: 'other answer', source: 'fixture user' });
  await assert.rejects(run('publish-check ' + task.id, 't-other'), /QA 이후 해소된 결정의 계획 영향을 판정하지 않았다: copy-timing revision 2\. /);
  await refused(() => fixture.close(task.id, 'fixture exception'), /QA 이후 해소된 결정/);
  for (const [args, pattern] of [
    ['--stage research --evidence copy-timing-r2', /게시 대기 업무는 해소 결정/],
    ['--stage implement --decision copy-timing --revision 2 --evidence x', /게시 대기 업무는 해소 결정/],
    ['--stage research --decision copy-timing --revision 1 --evidence x', /copy-timing의 현재 revision은 2이다/],
    ['--stage research --decision other-late --revision 2 --evidence x', /이 업무에 연결된 해소 결정이 아니다: other-late/],
    ['--stage research --decision copy-timing --evidence x', /--revision이 함께 필요하다/],
    ['--stage research --revision 2 --evidence x', /--revision은 --decision과 함께/],
    ['--stage research --decision copy-timing --revision 2', /근거/],
  ]) await refused(() => run('flow-resume ' + task.id + ' ' + args), pattern);

  // 결정 ID·revision·변경 근거로 게시 허가를 철회하고 재조사로 되돌린다. 이전 QA·게시 허가는 남지 않는다.
  const verified = fixture.ledger().tasks[task.id].x_flow.verification.digest;
  const resumed = await run('flow-resume ' + task.id + ' --stage research --decision copy-timing --revision 2 --evidence copy-check-to-follow-up');
  assert.deepEqual([resumed.state, resumed.pending, resumed.phase], ['RESEARCHING', 'research', 'work']);
  const withdrawn = fixture.ledger().tasks[task.id];
  assert.deepEqual([withdrawn.x_flow.plan, withdrawn.x_flow.verification, withdrawn.x_flow.delivery, withdrawn.x_flow.runner], [null, null, null, undefined]);
  assert.deepEqual([withdrawn.x_flow.recovery.decision, withdrawn.x_flow.recovery.withdrawn, withdrawn.x_flow.recovery.evidence],
    [{ id: 'copy-timing', revision: 2 }, { phase: 'publish', verification: verified, pr: null }, 'copy-check-to-follow-up']);
  assert.deepEqual(withdrawn.history.slice(-2).map(h => [h.from, h.to]), [['QA', 'BLOCKED'], ['BLOCKED', 'RESEARCHING']]);
  assert.match(withdrawn.history.at(-2).why, /결정 copy-timing revision 2로 게시 대기 QA·게시 허가 철회/);
  await assert.rejects(run('publish-check ' + task.id, 't-other'), /게시 대기 업무만/);
  await refused(() => fixture.close(task.id, 'fixture exception'), /PR이 연결되지 않은/);

  // 재조사·재동결·새 QA의 지시서에 결정이 들어가고, 옮긴 검사는 QA가 실행하지 않는 후속 확인이 된다.
  const second = await cycle([suiteRow, copyLater]);
  const decision = { id: 'copy-timing', task: task.id, question: 'When to check copy?', selection: 'On device after deployment', quote, source: 'fixture user', revision: 2 };
  const projected = list => list.map(({ resolvedAt, ...rest }) => rest);
  for (const stage of [second.research, second.qa]) assert.deepEqual(projected(injected(stage)), [decision]);
  assert.match(promptOf(second.qa), /후속 확인 항목은 실행하지도 checks에 적지도 않는다: copy-check/);
  assert.deepEqual(fixture.ledger().tasks[task.id].x_flow.plan.checkScopes, [suiteRow, copyLater]);
  const line = 'copy-check (AC1) | 환경: On device after deployment | 확인: Copy the title and compare with the source';
  const handoff = await run('publish-check ' + task.id, 't-other');
  assert.equal(handoff.allowed, true);
  assert.deepEqual(projected(handoff.decisions), [decision]);
  assert.deepEqual(handoff.remainingVerification, [{ id: 'copy-check', criteria: ['AC1'], environment: 'On device after deployment',
    verify: 'Copy the title and compare with the source', line }]);

  // CI 대기 중(PR 연결 뒤)의 결정도 병합 판정 전에 막고, 철회 기록에 연결했던 PR을 남긴다.
  git(task.worktree, 'add', '--', 'tracked.txt');
  git(task.worktree, 'commit', '-m', 'verified candidate');
  const head = git(task.worktree, 'rev-parse', 'HEAD');
  let views = 0;
  const prView = () => (views++, { number: 9, url: 'https://github.com/faysia320/herdr-harness/pull/9', state: 'OPEN', isCrossRepository: false, isDraft: false,
    headRefName: task.branch, headRefOid: head, baseRefName: 'main', body: '## 남은 검증\n- [ ] ' + line + '\n' });
  assert.equal((await main(['flow-attach-pr', task.id, '--pr', '9'], { ...lead, prView })).phase, 'ci');
  await ask('ci-late', { task: task.id, question: 'Also check on tablet?', source: 'fixture' });
  await answer('ci-late', { quote: 'Yes, add a tablet follow-up.', source: 'fixture user' });
  const delivery = () => assert.fail('결정 판정 전에는 병합 판정을 부르지 않는다.');
  await refused(() => run('flow-deliver ' + task.id + ' --apply', 't-lead', { delivery }), /QA 이후 해소된 결정의 계획 영향을 판정하지 않았다: ci-late revision 2/);
  // 연결된 PR을 먼저 조회해 아직 열려 있을 때만 QA·게시 근거를 철회한다.
  views = 0;
  const fromCi = await run('flow-resume ' + task.id + ' --stage research --decision ci-late --revision 2 --evidence add-tablet-follow-up', 't-lead', { prView });
  assert.deepEqual([fromCi.state, views], ['RESEARCHING', 1]);
  const reset = fixture.ledger().tasks[task.id].x_flow;
  assert.deepEqual([reset.delivery, reset.recovery.withdrawn.phase, reset.recovery.withdrawn.pr], [null, 'ci', 9]);
});

test('HH CI 대기 중 결정 재조사: 연결 PR이 이미 병합됐거나 상태를 확정할 수 없으면 대장을 그대로 두고 병합 증명으로 안내한다', async t => {
  if (!scopedRelease) return;
  const fixture = await setup(t);
  const { repo, base, main, herdr, run, refused } = fixture;
  const lead = { cwd: repo, terminal: 't-lead', herdr };
  await run('recover');
  const request = join(repo, '.local/request.txt');
  writeFileSync(request, 'Check copy in the correct environment.\n');
  const task = await main(['add', '--title', 'Merge pending proof', '--desc-file', request, '--workflow', 'v2', '--kind', 'feature',
    '--slug', 'pending-proof', '--authorization', 'fixture'], lead);
  writeFileSync(join(task.worktree, 'tracked.txt'), 'copied title\n');
  git(task.worktree, 'add', '--', 'tracked.txt');
  git(task.worktree, 'commit', '-m', 'QA candidate');
  const { context, candidate } = await import(pathToFileURL(join(repo, '.agents/harness/repository.mjs')));
  const current = candidate(context(repo, herdr), task);
  const anchor = { head: current.head, base, tree: current.tree };
  const url = 'https://github.com/faysia320/herdr-harness/pull/9';
  // 병합을 요청한 뒤 증명이 대장에 닿기 전: 대장은 CI 대기(ci)지만 서버의 PR은 이미 MERGED다.
  fixture.edit(ledger => Object.assign(ledger.tasks[task.id], { state: 'QA', pending: null, candidate: current,
    x_flow: { ...ledger.tasks[task.id].x_flow, phase: 'ci', verification: { verdict: 'PASS', candidate: current.fingerprint, digest: 'fixture-qa' },
      delivery: { pr: 9, url, ...anchor, original: anchor } } }));
  writeJson(join(repo, '.local/q.json'), { task: task.id, question: 'Add a device check?', source: 'fixture' });
  await main(['decision', 'request', 'late', '--file', join(repo, '.local/q.json')], lead);
  writeJson(join(repo, '.local/a.json'), { quote: 'Add a device check after deployment.', source: 'fixture user' });
  await main(['decision', 'resolve', 'late', '--file', join(repo, '.local/a.json'), '--revision', '1'], lead);
  const merged = { number: 9, url, state: 'MERGED', isDraft: false, isCrossRepository: false, headRefName: task.branch, headRefOid: current.head,
    baseRefName: 'main', mergeCommit: { oid: current.head }, mergedAt: new Date().toISOString() };
  const resume = prView => main(['flow-resume', task.id, '--stage', 'research', '--decision', 'late', '--revision', '2', '--evidence', 'new device check'],
    { ...lead, prView });
  const next = ' QA·게시 근거는 그대로 둔다\\. 병합됐으면 flow-prove-merged ' + task.id + '로 증명하고 결정 late은 후속 업무로 다룬다\\.';
  const before = fixture.ledger().tasks[task.id];
  let views = 0;
  // 재조사 전에 연결된 PR을 조회한다. 병합됐거나 조회 실패·다른 PR·상태 없음이면 QA·게시 anchor·delivery를 지우지 않는다.
  for (const [view, pattern] of [
    [() => (views++, merged), new RegExp('연결된 PR #9이 이미 병합돼 재조사하지 않는다\\.' + next)],
    [() => { views++; throw new Error('gh: network unreachable'); }, new RegExp('연결된 PR #9의 상태를 확정할 수 없어 재조사하지 않는다\\(gh: network unreachable\\)\\.' + next)],
    [() => (views++, { ...merged, number: 10 }), new RegExp('연결된 PR #9의 상태를 확정할 수 없어 재조사하지 않는다\\.' + next)],
    [() => (views++, { ...merged, state: undefined }), /연결된 PR #9의 상태를 확정할 수 없어/],
  ]) await refused(() => resume(view), pattern);
  assert.equal(views, 4);
  assert.deepEqual(fixture.ledger().tasks[task.id], before);
  // 대장이 그대로이므로 안내대로 병합 증명을 수집할 수 있다.
  const proved = await run('flow-prove-merged ' + task.id, 't-lead', { delivery: () => ({ phase: 'merged', pr: 9, url, head: anchor.head,
    branch: task.branch, merge: base, base, tree: anchor.tree, original: anchor }) });
  assert.deepEqual([proved.phase, fixture.ledger().tasks[task.id].state], ['merged', 'DONE']);
});

test('HH git-read 실행 수단은 조회 옵션만 받고 파일 출력·외부 명령 옵션과 셸 확장을 동결에서 거부한다', () => {
  if (!scopedRelease) return;
  const { freezePlan } = createRequire(import.meta.url)(join(built.release, 'core/workflow.cjs'));
  const { qa_executors: executors } = JSON.parse(readFileSync(join(root, '.agents/harness/config.json'), 'utf8'));
  const freeze = command => freezePlan({ version: 2, criteria: ['AC1'], checks: ['hh-suite', 'docs'], checkScopes: [
    { id: 'hh-suite', location: 'independent-qa', executor: 'hh-suite', criteria: ['AC1'] },
    { id: 'docs', location: 'independent-qa', executor: 'git-read', command, criteria: ['AC1'] }] }, { executors, required: ['hh-suite'] });
  for (const command of ['git diff --name-only 2451c13adaf5e201e3b3d8712d16035ff11addc9', 'git ls-files --others --exclude-standard',
    'git diff --check 2451c13', 'git diff 2451c13 -- README.md .agents/harness/README.md', 'git show HEAD:README.md',
    'git log --oneline -5 origin/main..HEAD', 'git grep -n planScopeVersion -- core', 'git log --format=%H -n 1', 'git diff --diff-filter=AM --name-status main'])
    assert.equal(freeze(command).checkScopes[1].command, command);
  for (const command of ['git diff --output=README.md', 'git diff --output README.md', 'git log --output=x', 'git show --output=x HEAD',
    'git grep -O cat x', 'git grep -Ocat x', 'git grep --open-files-in-pager=cat x', 'git diff --ext-diff', 'git diff --textconv', 'git diff --no-index a b',
    "git diff '--output=README.md'", 'git diff "--output"=README.md', 'git diff {--output=README.md,x}', 'git diff [-]-output=README.md',
    'git diff x,--output=README.md', 'git diff $(x)', 'git diff a; rm b', 'git diff \\--output=x'])
    assert.throws(() => freeze(command), /실행 수단 git-read의 명령 형식과 다르다: docs/, command);
});

test('HH 이전 release: 기존 계획 형식·지시서를 유지하고 결정 주입·새 조회를 부르지 않는다', async t => {
  const fixture = await setup(t);
  const { repo, binding, main, herdr, run } = fixture;
  const legacy = preScopeRelease(t);
  writeJson(binding, { ...JSON.parse(readFileSync(binding, 'utf8')), ...legacy });
  await run('recover');
  const request = join(repo, '.local/request.txt');
  writeFileSync(request, 'Legacy fixture.\n');
  const lead = { cwd: repo, terminal: 't-lead', herdr };
  const task = await main(['add', '--title', 'Legacy', '--desc-file', request, '--workflow', 'v2', '--kind', 'feature', '--slug', 'legacy',
    '--authorization', 'Fixture authorization'], lead);
  writeJson(join(repo, '.local/q.json'), { task: task.id, question: 'Legacy?', source: 'fixture' });
  await main(['decision', 'request', 'legacy', '--file', join(repo, '.local/q.json')], lead);
  writeJson(join(repo, '.local/a.json'), { quote: 'LEGACY_DECISION_QUOTE', source: 'fixture user' });
  await main(['decision', 'resolve', 'legacy', '--file', join(repo, '.local/a.json'), '--revision', '1'], lead);
  // 이 release의 결정함은 새 조회를 거부한다. 아래 위임이 성공하면 어댑터가 새 조회를 부르지 않은 것이다.
  const stateDir = fixture.state, ledger = fixture.ledger();
  assert.throws(() => adapter.bridge(binding, { project: 'herdr-harness', stateDir, ledger, action: 'resolved-for-task', task: task.id }), /Lead 세션만/);
  const research = (await run('dispatch ' + task.id)).run;
  const guide = promptOf(research);
  assert.match(guide, /Write verification-plan\.json with \{run, version:2, criteria:\[IDs\], checks:\[IDs including hh-suite\]\}\./);
  assert.match(guide, /"checks":\["필수 검사 식별자"\]\}\./);
  assert.doesNotMatch(guide, /checkScopes|해소 결정|LEGACY_DECISION_QUOTE/);
  writeJson(join(research.dir, 'research.json'), { run: research.token, summary: 'legacy plan', planned_files: ['tracked.txt'] });
  writeJson(join(research.dir, 'verification-plan.json'), { run: research.token, version: 2, criteria: ['AC1'], checks: ['hh-suite', 'browser'] });
  assert.equal((await run('collect ' + task.id)).state, 'READY_TO_IMPLEMENT');
  assert.deepEqual(fixture.ledger().tasks[task.id].x_flow.plan, { version: 2, criteria: ['AC1'], checks: ['hh-suite', 'browser'] });
  const implementation = (await run('dispatch ' + task.id)).run;
  assert.doesNotMatch(promptOf(implementation), /해소 결정|LEGACY_DECISION_QUOTE/);
  const status = await run('flow-status ' + task.id, 't-other');
  assert.equal(Object.hasOwn(status, 'remainingVerification'), false);
});
