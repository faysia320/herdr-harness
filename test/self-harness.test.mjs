import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { build, root } from '../scripts/build.mjs';
import { adapter, git, samePath } from '../.agents/harness/repository.mjs';
import { suiteInvocation } from '../.agents/harness/suite.mjs';

const frozenRelease = process.env.HH_TEST_PINNED_RELEASE;
const built = frozenRelease ? { release: frozenRelease, manifestHash: frozenRelease.split(/[\\/]/).at(-1) } : build();
const prefix = ['.agents/harness', 'adapters/runtime.cjs', '.gitignore', 'package.json', 'bin/harness.mjs',
  'core/process.js', 'core/preparation.mjs', 'core/metrics.mjs'];
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

test('HH fixture: launcher, Lead ownership, stage collection, frozen QA, commit and decision gates', async t => {
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
  let lookupFails = false;
  const launches = [];
  function herdr(cwd, args) {
    assert.ok(samePath(cwd, repo));
    if (args[0] === 'get') {
      if (lookupFails && args[1] === 't-lead') throw new Error('fixture hc unavailable');
      return sessions.get(args[1]) ?? null;
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
  const run = (args, terminal = 't-lead') => main(args.split(' '), { cwd: repo, terminal, herdr });
  const launcher = join(repo, '.agents/harness/launch.mjs');
  const viaLauncher = (...args) => spawnSync(process.execPath, [launcher, '--binding', binding, ...args],
    { cwd: repo, encoding: 'utf8', windowsHide: true });
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
  lookupFails = true;
  await assert.rejects(run('recover', 't-other'), /unavailable/);
  lookupFails = false;
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
  const implementation = (await run('dispatch ' + task.id)).run;
  assert.equal(implementation.model, 'claude-opus-5-5');
  const target = join(task.worktree, 'tracked.txt');
  writeFileSync(target, 'candidate\n');
  writeFileSync(join(task.worktree, 'outside.txt'), 'out of scope\n');
  writeJson(join(implementation.dir, 'implement.json'), { run: implementation.token, verdict: 'DONE', summary: 'fixture implementation',
    checks: [{ command: 'fixture validation', exit: 0 }, { command: 'for QA', exit: null }] });
  await assert.rejects(run('collect ' + task.id), /예정 경로 밖/);
  rmSync(join(task.worktree, 'outside.txt'));
  const implemented = await run('collect ' + task.id);
  writeJson(join(research.dir, 'verification-plan.json'), { ...plan, criteria: ['replaced'] });
  const qa = (await run('dispatch ' + task.id)).run;
  assert.equal(qa.model, 'gpt-6.2-sol');
  assert.notEqual(qa.terminal, implementation.terminal);
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
  assert.equal(JSON.parse(viaLauncher('publisher-command', task.id).stdout).model, 'gpt-6-luna');
  const question = join(repo, '.local/question.json');
  writeJson(question, { task: task.id.toLowerCase(), question: 'Fixture decision?', source: 'isolated fixture' });
  await main(['decision','request','fixture','--file',question], { cwd: repo, terminal: 't-lead', herdr });
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
  assert.equal(launches.length, 3);
  assert.equal(JSON.parse(readFileSync(binding)).project, 'herdr-harness');
});
