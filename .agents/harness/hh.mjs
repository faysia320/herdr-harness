import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { activeRun, collect, createWorktree, dispatch } from './stages.mjs';
import { atomic, lock, readLedger, requireLead, save, taskById, transition, withoutDecision } from './ledger.mjs';
import { adapter, candidate, check, command, config, context, git, now, project, readJson, repository, samePath, verifyCommit } from './repository.mjs';

const cli = fileURLToPath(import.meta.url);
const prFields = 'number,url,state,isCrossRepository,isDraft,headRefName,headRefOid,baseRefName';
const optionsByCommand = {
  whoami: {}, recover: {}, ls: { all: 'boolean' }, show: {}, policy: { stage: 'string', profile: 'string' },
  add: { title: 'string', 'desc-file': 'string', slug: 'string', workflow: 'string', kind: 'string', authorization: 'string', profile: 'string', depends: 'string' },
  next: { go: 'boolean' }, dispatch: {}, collect: {}, decision: { file: 'string', revision: 'string', all: 'boolean' },
  'flow-status': {}, 'flow-resume': { evidence: 'string', stage: 'string' },
  'publish-check': { committed: 'boolean' }, 'flow-attach-pr': { pr: 'string' }, 'flow-deliver': { apply: 'boolean' }, 'flow-prove-merged': {},
  'archive-tasks': { apply: 'boolean' },
};

function viewPr(ctx, n) {
  return JSON.parse(command(ctx.root, 'gh', ['pr', 'view', String(n), '--repo', repository, '--json', prFields]));
}

function assertBinding(ctx) {
  check(JSON.stringify(adapter.binding(ctx.file)) === JSON.stringify(ctx.binding), '실행 중 binding이 바뀌었다. 고정 릴리스로 다시 실행한다.');
}

async function update(ctx, terminal, handler, { recover = false } = {}) {
  return lock(ctx, async () => {
    assertBinding(ctx);
    const ledger = await readLedger(ctx);
    if (!recover) requireLead(ctx, ledger, terminal);
    return handler(ledger);
  });
}

export async function main(argv, { cwd = process.cwd(), terminal = process.env.HC_TERMINAL_ID, herdr, bindingFile } = {}) {
  const [name, ...args] = argv;
  if (name === '--help' || !name) return { commands: Object.keys(optionsByCommand) };
  check(Object.hasOwn(optionsByCommand, name), '알 수 없는 명령: ' + name);
  const optionSpec = Object.fromEntries(Object.entries(optionsByCommand[name]).map(([k, type]) => [k, { type }]));
  const { values: a, positionals: p } = parseArgs({ args, options: optionSpec, allowPositionals: true });
  const hasId = ['show', 'dispatch', 'collect', 'flow-status', 'publish-check', 'flow-attach-pr', 'flow-deliver', 'flow-prove-merged', 'flow-resume'].includes(name);
  if (name !== 'decision') check(p.length === Number(hasId), '명령의 위치 인자가 올바르지 않다.');
  const ctx = context(cwd, herdr);
  if (bindingFile !== undefined) check(bindingFile && samePath(bindingFile, ctx.file), '자체 launch.mjs로 현재 checkout의 binding을 전달해야 한다.');
  const mutate = handler => update(ctx, terminal, handler);
  if (name === 'recover') return update(ctx, terminal, ledger => {
    check(terminal && ctx.herdr(['get', terminal])?.state === 'live', '현재 살아 있는 Herdr 터미널에서 recover를 실행한다.');
    const previous = ledger.lead?.terminal ?? null;
    if (previous !== null && previous !== terminal) {
      const owner = ctx.herdr(['get', previous]);
      check(owner === null || owner.state === 'finished', '기존 Lead 상태를 확인하거나 종료하기 전에는 교체할 수 없다.');
    }
    const initialized = ledger.x_hh_decisions_initialized;
    if (!initialized) {
      const inbox = join(ctx.stateDir, 'decisions.json');
      if (!existsSync(inbox)) atomic(inbox, JSON.stringify({ version: 1, project, requests: {} }) + '\n');
      ctx.decisions({ ledger, action: 'list' });
      ledger.x_hh_decisions_initialized = true;
    }
    if (!initialized || previous !== terminal) {
      ledger.lead = { terminal, attached_at: now(), previous };
      save(ctx, ledger, { event: 'recover', terminal });
    }
    return { lead: ledger.lead, active: Object.values(ledger.tasks).filter(activeRun).map(t => ({ id: t.id, run: activeRun(t) })) };
  }, { recover: true });
  if (name === 'whoami') {
    const ledger = await readLedger(ctx);
    return { project, root: ctx.root, stateDir: ctx.stateDir, terminal, lead: ledger.lead, releaseHash: ctx.binding.manifestHash };
  }
  if (name === 'policy')
    return a.stage ? ctx.execution({ action: 'resolve', task: { profile: a.profile, x_flow: { version: 2 } }, stage: a.stage }) :
      { execution: ctx.execution({ action: 'config' }), workflow: ctx.release('workflow.cjs').policy, releaseHash: ctx.binding.manifestHash };
  if (name === 'add') return mutate(async ledger => {
    check(a.workflow === 'v2' && a.title?.trim() && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.slug ?? '') && a.slug.length <= 48,
      'add --workflow v2 --kind 종류 --authorization 원문 --title 제목 --desc-file 요청 --slug 영문 형식이 필요하다.');
    const description = readFileSync(a['desc-file'], 'utf8').trim();
    check(description.length > 0, '원래 요청 내용이 필요하다.');
    const flow = ctx.flow({ action: 'create', kind: a.kind, authorization: a.authorization });
    const policy = ctx.execution({ action: 'config' });
    const profile = a.profile ?? policy.default_profile;
    check(Object.hasOwn(policy.routing, profile), '알 수 없는 업무 프로필이다.');
    check(!Object.values(ledger.tasks).some(t => t.slug === a.slug && !['DONE', 'FAILED'].includes(t.state)), '이미 진행 중인 같은 업무 slug가 있다.');
    const depends = a.depends ? [...new Set(a.depends.split(','))] : [];
    for (const id of depends) taskById(ledger, id);
    const base = git(ctx.root, 'rev-parse', 'refs/remotes/origin/main^{commit}');
    const seq = ledger.seq + 1;
    const id = 'HH-' + String(seq).padStart(3, '0');
    const checkout = createWorktree(ctx, id, a.slug, base);
    const time = now();
    const task = { id, project, ...checkout, base, title: a.title.trim(), description, slug: a.slug, profile, depends,
      state: 'QUEUED', pending: 'research', stage: null, awaiting: null, created: time, updated: time, runs: [], current: null, history: [], x_flow: flow };
    ledger.seq = seq;
    ledger.tasks[id] = task;
    save(ctx, ledger, { event: 'add', task: id, state: task.state });
    return task;
  });
  if (name === 'decision') {
    const [action, id] = p;
    if (action === 'list') {
      check(p.length === 1 && !a.file && !a.revision, '사용법: decision list [--all]');
      return ctx.decisions({ ledger: await readLedger(ctx), action, all: a.all });
    }
    check(['request', 'resolve'].includes(action) && p.length === 2 && a.file && !a.all &&
      (a.revision === undefined || /^[1-9][0-9]*$/.test(a.revision)) && (action !== 'resolve' || a.revision),
      '사용법: decision request|resolve KEY --file JSON [--revision N]');
    return mutate(ledger => ctx.decisions({ ledger, action, id, input: readJson(a.file), by: terminal, revision: a.revision && Number(a.revision) }));
  }
  if (name === 'ls' || name === 'show' || name === 'flow-status' || (name === 'next' && !a.go)) {
    const ledger = await readLedger(ctx);
    if (name === 'ls') return Object.values(ledger.tasks).filter(t => a.all || !['DONE', 'FAILED'].includes(t.state));
    if (name === 'next') return Object.values(ledger.tasks).filter(t => !activeRun(t) && t.state !== 'BLOCKED' && t.pending)
      .map(t => ({ id: t.id, stage: t.pending, dependenciesReady: t.depends.every(id => ledger.tasks[id]?.state === 'DONE') }));
    const task = taskById(ledger, p[0]);
    if (name === 'flow-status') return { id: task.id, state: task.state, pending: task.pending, flow: task.x_flow };
    if (!task.x_archive) return task;
    return adapter.ledgerArchive(ctx.file, { action: 'restore', project, stateDir: ctx.stateDir, ledger, id: task.id });
  }
  if (name === 'archive-tasks') {
    const archive = (ledger, apply) => {
      const decisions = new Set(ctx.decisions({ ledger, action: 'list' }).map(d => d.task?.toUpperCase()));
      const keep = Object.values(ledger.tasks).filter(t => (t.worktree && existsSync(t.worktree)) ||
        decisions.has(t.id)).map(t => t.id);
      return adapter.ledgerArchive(ctx.file, { action: apply ? 'archive' : 'plan', project, stateDir: ctx.stateDir, ledger, options: { keep } });
    };
    if (!a.apply) return archive(await readLedger(ctx), false);
    return mutate(ledger => {
      const result = archive(ledger, true);
      save(ctx, result.ledger, { event: 'archive' });
      return result;
    });
  }
  if (name === 'next') return mutate(ledger => {
    const task = Object.values(ledger.tasks).find(t => !activeRun(t) && t.state !== 'BLOCKED' && t.pending &&
      t.depends.every(id => ledger.tasks[id]?.state === 'DONE'));
    check(task, '위임할 업무가 없다.');
    return dispatch(ctx, ledger, task);
  });
  if (name === 'publish-check') return publicationCheck(ctx, await readLedger(ctx), p[0], a.committed);
  return mutate(async ledger => {
    const task = taskById(ledger, p[0]);
    if (name === 'dispatch') return dispatch(ctx, ledger, task);
    if (name === 'collect') return collect(ctx, ledger, task);
    if (name === 'flow-resume') return resume(ctx, ledger, task, a);
    withoutDecision(ctx, ledger, task);
    if (name === 'flow-attach-pr') {
      const { committed: anchor } = publicationCheck(ctx, ledger, task.id, true);
      const number = Number(a.pr);
      check(Number.isSafeInteger(number) && number > 0 && /^[1-9][0-9]*$/.test(a.pr), '--pr에 PR 번호가 필요하다.');
      const pr = viewPr(ctx, number);
      check(pr.number === number && pr.state === 'OPEN' && pr.isCrossRepository === false && !pr.isDraft &&
        pr.headRefName === task.branch && pr.headRefOid === anchor.head && pr.baseRefName === 'main', '원격 PR이 최초 게시 후보와 다르다.');
      task.x_flow.delivery = { pr: number, url: pr.url, ...anchor, original: anchor };
      task.x_flow.phase = 'ci';
      task.updated = now();
      save(ctx, ledger, { event: 'x_flow', task: task.id, phase: 'ci', pr: number });
      return { id: task.id, phase: 'ci', ...task.x_flow.delivery };
    }
    return deliver(ctx, ledger, task, name, a);
  });
}

function publicationCheck(ctx, ledger, id, committed) {
  const task = taskById(ledger, id);
  withoutDecision(ctx, ledger, task);
  check(task.state === 'QA' && !activeRun(task) && task.x_flow.phase === 'publish' && task.x_flow.verification?.verdict === 'PASS',
    '독립 QA를 통과한 게시 대기 업무만 허용한다.');
  const anchor = committed ? verifyCommit(ctx, task) : null;
  if (!anchor) {
    const current = candidate(ctx, task);
    check(current.fingerprint === task.candidate.fingerprint && current.tree === task.candidate.tree, 'QA 이후 후보가 바뀌었다.');
  }
  return { allowed: true, id, branch: task.branch, candidate: task.candidate, committed: anchor };
}

async function deliver(ctx, ledger, task, name, a) {
  const flow = task.x_flow;
  const proofOnly = name === 'flow-prove-merged';
  check(flow?.version === 2 && flow.verification?.verdict === 'PASS' && flow.delivery && task.candidate &&
    (proofOnly ? ['ci', 'delivery-blocked', 'merged'] : ['ci']).includes(flow.phase),
  'QA 후보와 최초 게시 근거가 있는 업무가 필요하다.');
  check(ctx.release('delivery.cjs').dev14Version === 1, '고정 릴리스가 DEV-14 병합 증명을 지원하지 않는다.');
  const cwd = proofOnly ? ctx.root : task.worktree;
  if (!proofOnly) verifyCommit(ctx, task);
  assertBinding(ctx);
  const result = ctx.flow({ action: 'delivery', cwd, flow, branch: task.branch,
    ...(proofOnly ? { proofOnly: true } : { apply: Boolean(a.apply) }),
    dev14: { candidate: task.candidate, mergeAuthorized: Boolean(a.apply), sensitivePaths: config.sensitive_paths },
  });
  if ((proofOnly || a.apply) && result.phase === 'merged') {
    task.x_flow.phase = 'merged';
    task.x_flow.delivery = { ...flow.delivery, ...result, original: flow.delivery.original };
    task.pending = null;
    await transition(ctx, task, 'DONE', '병합 SHA 확인: ' + result.merge);
  } else if (a.apply && ['blocked', 'proof-blocked', 'revalidate'].includes(result.phase)) {
    task.x_flow.phase = 'delivery-blocked';
    task.x_flow.blocked_delivery = result;
    await transition(ctx, task, 'BLOCKED', result.reasons?.join(' / ') ?? '병합 조건 확인 필요', 'flow-delivery-blocked');
  } else return { id: task.id, ...result };
  save(ctx, ledger, { event: 'x_flow', task: task.id, phase: task.x_flow.phase, pr: flow.delivery.pr, merge: result.merge });
  return { id: task.id, ...result };
}

async function resume(ctx, ledger, task, a) {
  const flow = task.x_flow;
  check(task.state === 'BLOCKED' && ['blocked', 'diagnose', 'delivery-blocked'].includes(flow.phase) &&
    a.evidence?.trim() && [undefined, 'research', 'implement'].includes(a.stage),
  '차단 업무, 달라진 조건의 근거와 유효한 복구 단계가 필요하다.');
  withoutDecision(ctx, ledger, task);
  const originalStage = task.pending;
  let pending, phase;
  if (a.stage === 'research') {
    pending = 'research';
    phase = 'work';
    flow.plan = null;
  } else if (a.stage === 'implement') {
    check(flow.plan && task.planned_files?.length, '수정 범위와 검증 계획을 먼저 확정한다.');
    pending = 'implement';
    phase = 'repair';
  } else if (flow.phase === 'delivery-blocked') {
    verifyCommit(ctx, task);
    pending = null;
    phase = 'ci';
  } else {
    const repair = originalStage === 'qa' && (
      flow.verification?.findings.some(f => f.kind === 'code') ||
      candidate(ctx, task).fingerprint !== task.candidate?.fingerprint);
    pending = repair ? 'implement' : originalStage;
    phase = repair ? 'repair' : 'work';
  }
  if (['research', 'implement'].includes(pending)) {
    flow.delivery = null;
    flow.verification = null;
  }
  flow.recovery = { at: now(), evidence: a.evidence };
  task.pending = pending;
  flow.phase = phase;
  const to = pending === 'research' || pending === 'architect' ? 'RESEARCHING' : pending === 'implement' ? 'READY_TO_IMPLEMENT' : 'QA';
  await transition(ctx, task, to, a.evidence);
  save(ctx, ledger, { event: 'x_flow', task: task.id, phase });
  return { id: task.id, state: task.state, pending, phase };
}

if (process.argv[1] && resolve(process.argv[1]) === cli) {
  try {
    const bindingFile = process.env.HERDR_HARNESS_ENTRY_PID === String(process.ppid) ? process.env.HERDR_HARNESS_ENTRY_BINDING ?? '' : '';
    console.log(JSON.stringify(await main(process.argv.slice(2), { bindingFile }), null, 2));
  }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
