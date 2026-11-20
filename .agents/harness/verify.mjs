import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomic, readLedger, taskById } from './ledger.mjs';
import { adapter, candidate, check, configPath, context, now, project, samePath } from './repository.mjs';
import { activeRun, policyPath, receiptPath } from './stages.mjs';
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
  // 저장소 정책(policy/qa-receipt.json)의 OS별 필수 검사를 공통 발급기로 실행해 QA 실행 영수증 v2(PR 본문 envelope)를 만든다.
  // 발급기는 이 checkout의 파일이다. 고정 release에 없어도 된다.
  const { issueReceipt } = await import(pathToFileURL(join(ctx.root, 'core/qa-receipt-runner.mjs')).href);
  // 재실행을 시작하면 같은 회차의 이전 영수증은 로그 지문이 맞지 않아 수집되지 않는다.
  atomic(log, JSON.stringify({ argv, run: run.token, tree: before.tree, status: 'running' }) + '\n');
  // 정책 파일이 없는 이전 기준의 업무는 원본 checkout의 정책을 쓴다.
  const policyFile = join(existsSync(join(task.worktree, policyPath)) ? task.worktree : ctx.root, policyPath);
  const issued = await issueReceipt({ worktree: task.worktree, base: task.base, run: run.token, round: run.round, policyFile,
    heavy: argv[1], release: ctx.binding.manifestHash, env: suiteEnvironment(process.env) });
  // 기존 수집기는 Windows hh-suite 실행을 같은 명령·로그 형식으로 다시 확인한다.
  const result = issued.outputs.find(o => o.platform === 'windows' && o.check === 'hh-suite');
  check(!result || JSON.stringify(result.argv) === JSON.stringify(argv), 'QA 정책의 Windows hh-suite 명령이 기존 QA runner 명령과 다르다.');
  const stdout = result?.stdout ?? '', tests = suiteTestCount(stdout);
  const summary = { argv, exit: result?.code ?? null, run: run.token, tree: before.tree, stdoutLength: stdout.length, tests };
  const contents = [JSON.stringify(summary), stdout, result?.stderr ?? ''].join('\n');
  atomic(log, contents);
  check(issued.status === 'PASS', 'QA 실행 영수증 ' + issued.status + ': ' + issued.reasons.join(' / ') + ' (' + join(issued.out, 'result.json') + ')');
  check(result?.code === 0 && tests, '실제로 실행하고 통과한 필수 시험 건수를 확인할 수 없다: ' + log);
  const after = candidate(ctx, task);
  check(before.fingerprint === after.fingerprint, '검사 도중 후보가 바뀌었다.');
  const receipt = { version: 1, role: 'qa', run: run.token, terminal: me, releaseHash: ctx.binding.manifestHash,
    stable: true, base: task.base, scope: 'changed-paths', tree: after.tree, completedAt: now(),
    checks: [{ id: 'hh-suite', state: 'passed', exit: 0, tests, log, logDigest: adapter.hash(contents) }] };
  atomic(join(task.worktree, receiptPath), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ ...receipt, qaReceipt: join(issued.out, 'envelope.txt') }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 2; }
