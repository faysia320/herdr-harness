import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { artifact, save, transition, withoutDecision } from './ledger.mjs';
import { adapter, candidate, check, config, git, now, project } from './repository.mjs';

export const receiptPath = 'target/hh-verify/latest-qa.json';
export const suiteCommand = ['node', 'scripts/build.mjs', '&&', 'node', '--test', 'test/*.test.mjs', 'mod/harness/*.test.mjs'];
export const suiteInvocation = ctx => [process.execPath, join(ctx.binding.release, 'bin/heavy.mjs'), '--', ...suiteCommand];
const stateForStage = { research: 'RESEARCHING', architect: 'RESEARCHING', implement: 'IMPLEMENTING', qa: 'QA' };
const allowedDispatch = { research: ['QUEUED', 'RESEARCHING'], architect: ['RESEARCHING'], implement: ['READY_TO_IMPLEMENT'], qa: ['QA'] };
const isText = s => typeof s === 'string' && s.trim().length > 0;
const validId = s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s);
const identifiers = items => Array.isArray(items) && items.length && items.every(validId) && new Set(items).size === items.length;
const relative = p => isText(p) && !/[\\:*?[\]\x00-\x1f]/.test(p) &&
  p.replace(/\/$/, '').split('/').every(part => part && part !== '.' && part !== '..') && !/^(\.local|target|\.git)(\/|$)/.test(p);
const includesPath = (scope, path) => scope.endsWith('/') ? path.startsWith(scope) : path === scope;
export const activeRun = task => task.current ? task.runs[task.current.run] : null;

function prompt(ctx, ledger, task, run) {
  const stage = run.stage, release = ctx.binding.release;
  const file = join(run.dir, stage === 'qa' ? 'verification.json' : stage + '.json');
  const shape = {
    research: 'Write research.json with {run, summary, planned_files: [literal paths or directory paths ending in /]}. Write verification-plan.json with {run, version:2, criteria:[IDs], checks:[IDs including hh-suite]}. Describe what each ID verifies in summary. Inspect the request and baseline. Keep the source tree unchanged.',
    architect: 'Independently review the frozen plan, including boundary and failure cases. Write architect.json with {run, verdict:"PASS"|"BLOCKED", reason}. Keep the source tree unchanged.',
    implement: 'Implement within planned_files and report implement.json as {run, verdict:"DONE"|"BLOCKED", summary, checks:[{command,exit}]}. Use the actual exit code for an executed check and null for a check you did not run. Keep changes in the worktree. Finish background processes before reporting.',
    qa: 'Evaluate the original request and the frozen plan independently. Read the implementation report as context. Leave the candidate unchanged. Run the QA command below before a PASS. In verification.json include run plus all common verification fields and the evidence for every frozen ID. Finish background processes before reporting.',
  }[stage];
  const qa = [process.execPath, join(ctx.root, '.agents/harness/verify.mjs'), ctx.file, task.id].map(s => JSON.stringify(s.replaceAll('\\', '/'))).join(' ');
  return [
    '[' + task.id + ' ' + stage + '] ' + task.title,
    'Original request: ' + task.description,
    'Worktree: ' + task.worktree,
    'Base: ' + task.base,
    'Run token: ' + run.token,
    'Write the result last to ' + file,
    'Use this token as the run field. Keep all reports beside this prompt. ' + shape,
    'Frozen plan: ' + JSON.stringify(task.x_flow.plan ?? null),
    'Planned files: ' + JSON.stringify(task.planned_files ?? []),
    'Prior run directories: ' + task.runs.filter(r => r.token !== run.token).map(r => r.dir).join(', '),
    ctx.flow({ action: 'instructions', flow: task.x_flow, stage, candidate: task.candidate?.fingerprint }),
    stage === 'qa' ? 'QA runner: ' + qa : '',
    'Pinned release: ' + release,
    'Do not change the ledger, binding, baseline release, remote Git state or other tasks. When finished, send the result to the Lead: hc send ' +
      ledger.lead.terminal + ' "' + task.id + ' ' + stage + ' complete; report: ' + file + '"',
  ].filter(Boolean).join('\n') + '\n';
}

export async function dispatch(ctx, ledger, task) {
  const stage = task.pending;
  check(allowedDispatch[stage]?.includes(task.state) && !activeRun(task) && ['work', 'repair'].includes(task.x_flow.phase),
    '위임 가능한 다음 단계가 없다.');
  withoutDecision(ctx, ledger, task);
  check(task.depends.every(id => ledger.tasks[id]?.state === 'DONE'), '선행 업무가 완료되지 않았다.');
  const policy = ctx.execution({ action: 'config' });
  const running = Object.values(ledger.tasks).filter(activeRun);
  const exclusive = t => policy.routing[t.profile]?.exclusive;
  check(running.length < policy.limits.max_parallel && !running.some(exclusive) && !(exclusive(task) && running.length),
    '동시 실행 한도 또는 고위험 업무 단독 실행 조건이 적용된다.');
  if (stage === 'implement') {
    for (const other of Object.values(ledger.tasks)) {
      if (other.id === task.id || !['IMPLEMENTING', 'QA'].includes(other.state)) continue;
      const paths = [...(other.planned_files ?? []), ...(other.candidate?.paths ?? []).map(p => p.path)];
      check(!task.planned_files.some(p => paths.some(q => includesPath(p, q) || includesPath(q, p))), '진행 중인 업무와 수정 예정 경로가 겹친다: ' + other.id);
    }
  }
  const before = candidate(ctx, task);
  if (stage === 'qa') check(before.fingerprint === task.candidate?.fingerprint, '구현 수집 뒤 후보가 바뀌었다.');
  const role = ctx.execution({ action: 'resolve', task, stage });
  const round = task.runs.filter(r => r.stage === stage).length + 1;
  const name = (config.project.terminal_prefix + task.id.split('-').at(-1) + '-' + stage + '-' + round).toLowerCase();
  const token = randomUUID();
  const dir = join(ctx.stateDir, 'tasks', task.id, 'runs', token);
  mkdirSync(dir, { recursive: true });
  const run = { token, dir, name, stage, round, started: now(), status: 'running', before: before.fingerprint,
    cli: role.cli, model: role.model, effort: role.effort, x_execution_policy: { ...role.policy, release: role.releaseHash, fast: role.fast } };
  task.current = { run: task.runs.length, stage };
  task.stage = stage;
  task.runs.push(run);
  await transition(ctx, task, stateForStage[stage], stage + ' 위임');
  const file = join(dir, 'prompt.txt');
  writeFileSync(file, prompt(ctx, ledger, task, run), { flag: 'wx' });
  save(ctx, ledger, { task: task.id, event: 'dispatch', stage, round });
  const text = '[' + task.id + ' ' + stage + '] Read "' + file + '" first and follow it.';
  const extra = role.cli === 'codex' ? ['-C', task.worktree, '--add-dir', dir, text] : ['--add-dir', dir, '--', text];
  const labels = ['--label', 'harness.project=' + project, '--label', 'harness.task=' + task.id, '--label', 'harness.run=' + token];
  const space = ctx.herdr(['get', ledger.lead.terminal])?.labels?.['herdr.space'];
  if (space) labels.push('--label', 'herdr.space=' + space);
  const launched = ctx.herdr(['run', '--json', '--bg', '--outlive-parent', '--parent', ledger.lead.terminal, '--name', name, '--cwd', task.worktree, ...labels, '--', ...role.argv, ...extra]);
  check(launched?.address, 'Herdr 위임 주소를 확인할 수 없다. 해당 이름을 확인한 뒤 수집한다.');
  run.terminal = launched.address;
  save(ctx, ledger);
  return { id: task.id, run };
}

function freezePlan(plan, report) {
  check(plan.version === 2 && identifiers(plan.criteria) && identifiers(plan.checks) && plan.checks.includes('hh-suite'), '유효한 AC·필수 검사 ID와 hh-suite가 필요하다.');
  check(isText(report.summary) && Array.isArray(report.planned_files) && report.planned_files.length &&
    report.planned_files.every(relative) && new Set(report.planned_files).size === report.planned_files.length, '조사 결과·수정 예정 경로가 필요하다.');
  return { version: 2, criteria: plan.criteria, checks: plan.checks };
}

function finish(run, task, verdict, note) {
  run.ended = now();
  run.status = 'ended';
  run.outcome = verdict;
  run.note = note;
  task.current = null;
}

export async function collect(ctx, ledger, task) {
  const run = activeRun(task);
  check(run, '수집할 실행이 없다.');
  const file = join(run.dir, run.stage === 'qa' ? 'verification.json' : run.stage + '.json');
  const terminal = ctx.herdr(['get', run.terminal ?? run.name]);
  if (terminal) check(terminal.labels?.['harness.run'] === run.token && terminal.labels?.['harness.project'] === project,
    '현재 실행의 Herdr 터미널과 다르다.');
  if (!existsSync(file)) {
    check(terminal?.state !== 'live', '아직 실행 중이다. 산출물이 도착하면 다시 수집한다.');
    finish(run, task, 'no-result', '터미널 종료 후 산출물이 없다.');
    task.x_flow.phase = 'blocked';
    await transition(ctx, task, 'BLOCKED', run.note, 'flow-blocked');
    save(ctx, ledger, { task: task.id, event: 'collect', stage: run.stage, outcome: run.outcome });
    return task;
  }
  check(run.x_execution_policy.release === ctx.binding.manifestHash, '실행을 위임한 release와 현재 binding이 다르다.');
  const report = artifact(file, run);
  const current = candidate(ctx, task);
  const stage = run.stage;
  if (stage !== 'implement') check(current.fingerprint === run.before, '현재 단계에서 후보가 변경됐다.');
  let verdict, note, to, awaiting;
  if (stage === 'research') {
    task.x_flow.plan = freezePlan(artifact(join(run.dir, 'verification-plan.json'), run), report);
    task.planned_files = report.planned_files;
    verdict = 'ok';
    note = report.summary;
    task.pending = ctx.execution({ action: 'config' }).routing[task.profile].architect ? 'architect' : 'implement';
    to = task.pending === 'architect' ? 'RESEARCHING' : 'READY_TO_IMPLEMENT';
  } else if (stage === 'architect' || stage === 'implement') {
    const success = stage === 'architect' ? 'PASS' : 'DONE';
    note = stage === 'architect' ? report.reason : report.summary;
    check([success, 'BLOCKED'].includes(report.verdict) && isText(note), '단계 결과의 판정·근거가 필요하다.');
    if (stage === 'implement') {
      check(current.paths.every(p => task.planned_files.some(scope => includesPath(scope, p.path))), '수정 예정 경로 밖의 후보 변경이 있다.');
      check(report.verdict !== success || (current.paths.length && Array.isArray(report.checks) &&
        report.checks.every(c => isText(c?.command) && (c.exit === null || Number.isInteger(c.exit))) &&
        report.checks.some(c => Number.isInteger(c.exit))),
        '후보 변경과 구현 실행 검사 근거가 필요하다.');
      if (report.verdict === success) task.candidate = current;
    }
    verdict = report.verdict === success ? 'ok' : 'BLOCKED';
    if (verdict === 'ok') {
      task.pending = stage === 'architect' ? 'implement' : 'qa';
      to = stage === 'architect' ? 'READY_TO_IMPLEMENT' : 'QA';
    } else {
      task.x_flow.phase = 'blocked';
      to = 'BLOCKED';
      awaiting = 'flow-blocked';
    }
  } else {
    check(task.candidate?.fingerprint === current.fingerprint, '독립 QA 대상 후보가 다르다.');
    const { run: token, ...verification } = report;
    check(identifiers(verification.checks?.map(c => c?.id)), '검증 보고서의 검사 ID가 없거나 중복된다.');
    const result = ctx.flow({ action: 'collect', flow: task.x_flow, report: verification, candidate: current.fingerprint });
    if (report.verdict === 'PASS') {
      const receipt = ctx.flow({ action: 'verify-receipt', cwd: task.worktree, since: run.started, base: task.base, receipt: receiptPath });
      const raw = artifact(join(task.worktree, receiptPath), run);
      const log = readFileSync(join(run.dir, 'hh-suite.log'), 'utf8');
      const resultLine = JSON.parse(log.split('\n', 1)[0]);
      const suite = receipt.checks[0];
      check(raw.terminal === (terminal?.address ?? run.terminal) && raw.releaseHash === ctx.binding.manifestHash &&
        receipt.checks.length === 1 && suite.id === 'hh-suite' && suite.state === 'passed' && suite.exit === 0 &&
        suite.logDigest === adapter.hash(log) && resultLine.exit === 0 && resultLine.run === run.token && resultLine.tree === current.tree &&
        JSON.stringify(resultLine.argv) === JSON.stringify(suiteInvocation(ctx)), '현재 QA 세션이 고정 release로 실행한 필수 검사 영수증·로그가 필요하다.');
      result.flow.runner = receipt;
    }
    task.x_flow = result.flow;
    task.pending = result.pending;
    verdict = report.verdict;
    note = result.reason;
    to = result.state;
    awaiting = result.awaiting;
  }
  finish(run, task, verdict, note);
  await transition(ctx, task, to, note, awaiting);
  save(ctx, ledger, { task: task.id, event: 'collect', stage, outcome: verdict });
  return task;
}

export function createWorktree(ctx, id, slug, base) {
  const branch = 'hh/' + id.toLowerCase() + '-' + slug;
  const worktree = join(ctx.root, config.project.worktree_dir, id.toLowerCase() + '-' + slug);
  mkdirSync(join(ctx.root, config.project.worktree_dir), { recursive: true });
  git(ctx.root, 'worktree', 'add', '-b', branch, worktree, base);
  return { branch, worktree };
}
