import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomic, readLedger, taskById } from './ledger.mjs';
import { adapter, candidate, check, configPath, context, now, project, samePath } from './repository.mjs';
import { activeRun, receiptPath } from './stages.mjs';
import { suiteEnvironment, suiteInvocation, suiteTestCount } from './suite.mjs';

try {
  const [file, id] = process.argv.slice(2);
  check(file && id && process.argv.length === 4, '사용법: verify.mjs BINDING ID');
  const ctx = context(dirname(configPath));
  check(resolve(file) === resolve(ctx.file), 'QA runner의 binding이 다르다. 등록된 원본 checkout에서 실행한다.');
  const task = taskById(await readLedger(ctx), id);
  check([ctx.root, task.worktree].some(cwd => samePath(cwd, process.cwd())), '해당 업무 작업공간에서 QA runner를 실행한다.');
  const run = activeRun(task);
  const me = process.env.HC_TERMINAL_ID;
  const terminal = me && ctx.herdr(['get', me]);
  check(run?.stage === 'qa' && terminal?.state === 'live' && terminal.labels?.['harness.project'] === project &&
    terminal.labels?.['harness.run'] === run.token && run.x_execution_policy.release === ctx.binding.manifestHash,
    '현재 위임된 독립 QA 터미널의 고정 릴리스가 필요하다.');
  const before = candidate(ctx, task);
  check(before.fingerprint === task.candidate?.fingerprint, '현재 작업공간과 QA 후보가 다르다.');
  const log = join(run.dir, 'hh-suite.log');
  const argv = suiteInvocation(ctx);
  const { runTree } = await import(pathToFileURL(join(ctx.binding.release, 'core/process.js')).href);
  // 재실행을 시작하면 같은 회차의 이전 영수증은 로그 지문이 맞지 않아 수집되지 않는다.
  atomic(log, JSON.stringify({ argv, run: run.token, tree: before.tree, status: 'running' }) + '\n');
  const result = await runTree(argv[0], argv.slice(1), {
    cwd: task.worktree, timeout: 45 * 60 * 1000, env: suiteEnvironment(process.env),
  });
  const tests = suiteTestCount(result.stdout);
  const summary = { argv, exit: result.code, run: run.token, tree: before.tree, stdoutLength: result.stdout.length, tests };
  const contents = [JSON.stringify(summary), result.stdout, result.stderr].join('\n');
  atomic(log, contents);
  check(result.code === 0, '필수 검사 실패 또는 미완료: ' + log);
  check(tests, '실제로 실행하고 통과한 필수 시험 건수를 확인할 수 없다: ' + log);
  const after = candidate(ctx, task);
  check(before.fingerprint === after.fingerprint, '검사 도중 후보가 바뀌었다.');
  const receipt = { version: 1, role: 'qa', run: run.token, terminal: me, releaseHash: ctx.binding.manifestHash,
    stable: true, base: task.base, scope: 'changed-paths', tree: after.tree, completedAt: now(),
    checks: [{ id: 'hh-suite', state: 'passed', exit: 0, tests, log, logDigest: adapter.hash(contents) }] };
  atomic(join(task.worktree, receiptPath), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 2; }
