import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
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
  'core/process.js', 'core/preparation.mjs', 'core/metrics.mjs'];
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

// 정리 모듈이 없는 release(현재 고정 설치본과 같은 상태). manifest를 다시 만들어 binding 검증은 통과한다.
function legacyRelease(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  cpSync(built.release, dir, { recursive: true });
  rmSync(join(dir, 'core/worktree-cleanup.cjs'), { force: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  delete manifest.files['core/worktree-cleanup.cjs'];
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(dir, 'manifest.json'), raw);
  return { release: dir, manifestHash: adapter.hash(raw) };
}
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
  const plan = { run: research.token, version: 2, criteria: ['AC1'], checks: ['hh-suite'] };
  writeJson(join(research.dir, 'verification-plan.json'), { ...plan, checks: ['hh-suite','hh-suite'] });
  await assert.rejects(run('collect ' + task.id), /필수 검사 ID/);
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
  assert.equal((await run('publish-check ' + task.id, 't-other')).allowed, true);
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
