import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendEvent, artifact, save, transition, withoutDecision } from './ledger.mjs';
import { candidate, check, config, git, now, project } from './repository.mjs';
import { closeTerminal, reclaimTerminals } from './terminals.mjs';

const stateForStage = { research: 'RESEARCHING', architect: 'RESEARCHING', implement: 'IMPLEMENTING', qa: 'QA' };
const allowedDispatch = { research: ['QUEUED', 'RESEARCHING'], architect: ['RESEARCHING'], implement: ['READY_TO_IMPLEMENT'], qa: ['QA'] };
const isText = s => typeof s === 'string' && s.trim().length > 0;
const validId = s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s);
const identifiers = items => Array.isArray(items) && items.length && items.every(validId) && new Set(items).size === items.length;
const relative = p => isText(p) && !/[\\:*?[\]\x00-\x1f]/.test(p) &&
  p.replace(/\/$/, '').split('/').every(part => part && part !== '.' && part !== '..') && !/^(\.local|target|\.git)(\/|$)/.test(p);
const includesPath = (scope, path) => scope.endsWith('/') ? path.startsWith(scope) : path === scope;
export const activeRun = task => task.current ? task.runs[task.current.run] : null;
// 고정 release가 검증 계획 실행 위치 분류·해소 결정 주입을 지원하는지. 없으면 기존 계획 형식·지시서로 동작하고 새 동작을 호출하지 않는다.
export const scoped = ctx => ctx.release('workflow.cjs').planScopeVersion === 1;
// HH 자체 QA는 바뀐 모듈에 대응하는 시험 파일(node-test)과 Git 대조(git-read)만 쓴다. 전체 suite·QA 실행 영수증을 필수로 두지 않는다.
const scopeOptions = () => ({ executors: config.qa_executors });
// 시험 선택 규칙. 조사(동결)·구현·수리·QA 지시서가 같은 기준을 쓴다.
const changedTests = 'Test scope is changed-file tests only: run node --test with the literal test files that cover the changed modules ' +
  "(the module's own test file, integration tests that import or exercise it, and changed test files themselves; e.g. .agents/harness/stages.mjs is covered by test/self-harness.test.mjs). " +
  'Never run the full suite, a wildcard, heavy.mjs, Docker or the QA receipt issuer. If no test covers the change, run a Git read command (for example git diff --stat <Base>) instead.';

// 결정 조회와 공통 지시서 작성은 run 폴더·대장 변경 전에 한다. 조회 실패를 결정 0건으로 바꾸지 않고 위임을 멈춘다.
function guide(ctx, ledger, task, stage) {
  const input = { action: 'instructions', flow: task.x_flow, stage, candidate: task.candidate?.fingerprint };
  if (!scoped(ctx)) return ctx.flow(input);
  const decisions = ctx.decisions({ ledger, action: 'resolved-for-task', task: task.id });
  return ctx.flow({ ...input, options: { decisions, ...(stage === 'research' ? { scopes: scopeOptions() } : {}) } });
}

// 완료 보고 명령. 고정 release에 보정 전송 도구가 있으면 그것을 쓴다(Codex Lead의 입력창 미제출 보정). 이전 release는 hc send.
function notifyCommand(release, lead) {
  const tool = join(release, 'bin/send.mjs');
  if (!existsSync(tool)) return 'hc send ' + lead;
  // 첫 토큰을 node로 둬 bash·PowerShell 모두 그대로 실행한다.
  return 'node ' + JSON.stringify(tool.replaceAll('\\', '/')) + ' ' + lead;
}

function prompt(ctx, ledger, task, run, instructions) {
  const stage = run.stage, release = ctx.binding.release;
  const plan = (scoped(ctx) ? 'Write verification-plan.json with {run, version:2, criteria:[IDs], checks:[IDs], checkScopes:[one row per check]} following the plan rules below. ' +
    'Freeze one node-test row listing the covering test files, or only a git-read row when no test covers the change.' :
    'Write verification-plan.json with {run, version:2, criteria:[IDs], checks:[IDs]}. In summary name the exact node --test files (or the Git read command when no test covers the change) for each check ID.') +
    ' ' + changedTests;
  const file = join(run.dir, stage === 'qa' ? 'verification.json' : stage + '.json');
  const shape = {
    research: 'Write research.json with {run, summary, planned_files: [literal paths or directory paths ending in /]}. ' + plan + ' Describe what each ID verifies in summary. Inspect the request and baseline. Keep the source tree unchanged.',
    architect: 'Independently review the frozen plan, including boundary and failure cases. Write architect.json with {run, verdict:"PASS"|"BLOCKED", reason}. Keep the source tree unchanged.',
    implement: 'Implement within planned_files and report implement.json as {run, verdict:"DONE"|"BLOCKED", summary, checks:[{command,exit}]}. Use the actual exit code for an executed check and null for a check you did not run. Keep changes in the worktree. Finish background processes before reporting. ' + changedTests,
    qa: 'Evaluate the original request and the frozen plan independently. Read the implementation report as context. Leave the candidate unchanged. ' +
      'Before a PASS, run every frozen independent-QA command exactly as written in the candidate worktree on this Windows host and compare the frozen test files with the actual changed paths (git diff --name-only <Base>). ' +
      'No QA receipt, hh-suite log or Docker Linux run is required. In verification.json include run plus all common verification fields and the evidence for every frozen ID with the command and its actual result. Finish background processes before reporting. ' + changedTests,
  }[stage];
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
    instructions,
    'Pinned release: ' + release,
    'Do not change the ledger, binding, baseline release, remote Git state or other tasks. When finished, send the result to the Lead: ' +
      notifyCommand(release, ledger.lead.terminal) + ' "' + task.id + ' ' + stage + ' complete; report: ' + file + '"',
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
  const instructions = guide(ctx, ledger, task, stage);
  // 새 회차를 만들기 전에 이 업무의 이전 회차에서 남겨 둔 위임 터미널을 다시 닫는다.
  reclaimTerminals(ctx, ledger, task);
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
  writeFileSync(file, prompt(ctx, ledger, task, run, instructions), { flag: 'wx' });
  const event = { task: task.id, event: 'dispatch', stage, round };
  const text = '[' + task.id + ' ' + stage + '] Read "' + file + '" first and follow it.';
  const extra = role.cli === 'codex' ? ['-C', task.worktree, '--add-dir', dir, text] : ['--add-dir', dir, '--', text];
  const labels = ['--label', 'harness.project=' + project, '--label', 'harness.task=' + task.id, '--label', 'harness.run=' + token];
  const space = ctx.herdr(['get', ledger.lead.terminal])?.labels?.['herdr.space'];
  if (space) labels.push('--label', 'herdr.space=' + space);
  const launched = ctx.herdr(['run', '--json', '--bg', '--outlive-parent', '--parent', ledger.lead.terminal, '--name', name, '--cwd', task.worktree, ...labels, '--', ...role.argv, ...extra]);
  if (!launched?.address) {
    // 주소 없이 떠 있을 수 있는 터미널을 이름으로 수집하도록 회차는 남긴다(기존 동작).
    save(ctx, ledger, event);
    check(false, 'Herdr 위임 주소를 확인할 수 없다. 해당 이름을 확인한 뒤 수집한다.');
  }
  run.terminal = launched.address;
  // 대장은 터미널 주소까지 담아 한 번만 교체한다. 교체가 끝내 실패하면 디스크의 대장·이벤트는 위임 전 그대로이므로
  // 방금 띄운 터미널(레이블 project·task·run 확인)을 닫고 지운 뒤 원래 오류로 끝낸다. 이벤트는 교체 뒤에만 남긴다.
  try { save(ctx, ledger); }
  catch (error) {
    const closed = closeTerminal(ctx, ledger, task, run, { reclaim: true });
    error.message = '대장 저장에 실패해 위임을 되돌렸다. 위임 터미널 정리: ' + JSON.stringify(closed) + ' — ' + error.message;
    throw error;
  }
  appendEvent(ctx, event);
  return { id: task.id, run };
}

// 새 release는 공통 freeze가 실행 위치 분류·QA 실행 수단을 검사한 정규화 계획을 저장한다. 이전 release는 기존 ID 배열 계획을 쓴다.
function freezePlan(ctx, plan, report) {
  const frozen = scoped(ctx) ? ctx.flow({ action: 'freeze', plan, options: scopeOptions() }) : null;
  if (!frozen) check(plan.version === 2 && identifiers(plan.criteria) && identifiers(plan.checks), '유효한 AC·필수 검사 ID가 필요하다.');
  check(isText(report.summary) && Array.isArray(report.planned_files) && report.planned_files.length &&
    report.planned_files.every(relative) && new Set(report.planned_files).size === report.planned_files.length, '조사 결과·수정 예정 경로가 필요하다.');
  return frozen ?? { version: 2, criteria: plan.criteria, checks: plan.checks };
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
  const stage = run.stage;
  // revalidate 재구현이 병합한 main이 있으면 그 기준으로 후보를 검사한다. 기준은 아래 DONE 판정에서만 저장한다. 이전 release는 기존 기준을 쓴다.
  const moved = stage === 'implement' && ctx.release('workflow.cjs').mergedBase ? ctx.flow({ action: 'merged-base', task }) : null;
  const current = candidate(ctx, moved ? { ...task, base: moved.to } : task);
  if (stage !== 'implement') check(current.fingerprint === run.before, '현재 단계에서 후보가 변경됐다.');
  let verdict, note, to, awaiting;
  if (stage === 'research') {
    task.x_flow.plan = freezePlan(ctx, artifact(join(run.dir, 'verification-plan.json'), run), report);
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
      if (report.verdict === success) {
        task.candidate = current;
        if (moved) task.base = moved.to;
        delete task.x_flow.recovery?.revalidate;
      }
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
    task.x_flow = result.flow;
    task.pending = result.pending;
    verdict = report.verdict;
    note = result.reason;
    to = result.state;
    awaiting = result.awaiting;
  }
  finish(run, task, verdict, note);
  await transition(ctx, task, to, note, awaiting);
  // 기준을 옮겼으면 이전·새 기준을 history와 event에 남긴다.
  const base = moved && verdict === 'ok' ? { base: moved } : {};
  if (base.base) Object.assign(task.history.at(-1), base);
  save(ctx, ledger, { task: task.id, event: 'collect', stage, outcome: verdict, ...base });
  // 수집을 저장한 뒤 그 회차의 위임 터미널을 닫는다. 실패해도 수집 결과는 그대로 두고 사유를 회차에 남긴다.
  run.x_terminal = closeTerminal(ctx, ledger, task, run);
  save(ctx, ledger);
  return task;
}

export function createWorktree(ctx, id, slug, base) {
  const branch = 'hh/' + id.toLowerCase() + '-' + slug;
  const worktree = join(ctx.root, config.project.worktree_dir, id.toLowerCase() + '-' + slug);
  mkdirSync(join(ctx.root, config.project.worktree_dir), { recursive: true });
  git(ctx.root, 'worktree', 'add', '-b', branch, worktree, base);
  return { branch, worktree };
}
