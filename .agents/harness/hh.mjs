import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { activeRun, collect, createWorktree, dispatch, scoped } from './stages.mjs';
import { archiveKeep, cleanupWorktree } from './cleanup.mjs';
import { reclaimTerminals } from './terminals.mjs';
import { atomic, lock, readLedger, requireLead, save, taskById, transition, withoutDecision } from './ledger.mjs';
import { adapter, candidate, check, command, context, git, now, project, readJson, repository, samePath, verifyCommit } from './repository.mjs';

const cli = fileURLToPath(import.meta.url);
const prFields = 'number,url,state,isCrossRepository,isDraft,headRefName,headRefOid,baseRefName,body';
const optionsByCommand = {
  whoami: {}, recover: {}, ls: { all: 'boolean' }, show: {}, policy: { stage: 'string', profile: 'string' },
  add: { title: 'string', 'desc-file': 'string', slug: 'string', workflow: 'string', kind: 'string', authorization: 'string', profile: 'string', depends: 'string' },
  next: { go: 'boolean' }, dispatch: {}, collect: {}, decision: { file: 'string', revision: 'string', all: 'boolean' },
  'flow-status': {}, 'flow-resume': { evidence: 'string', stage: 'string', decision: 'string', revision: 'string' },
  'publish-check': { committed: 'boolean' }, 'direct-publish': { title: 'string' }, 'flow-attach-pr': { pr: 'string' }, 'flow-deliver': { apply: 'boolean' }, 'flow-prove-merged': {},
  'flow-close': { evidence: 'string' }, 'flow-close-local': { evidence: 'string' }, 'flow-accept-merged': { pr: 'string', evidence: 'string', source: 'string' },
  'cleanup-worktree': {}, 'archive-tasks': { apply: 'boolean' },
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
    const result = await handler(ledger);
    // FAILED로 끝난 업무의 남은 위임 터미널을 다시 닫는다. DONE은 정리(cleanupWorktree)가 활동 조회 전에 닫는다.
    // 처리기가 새 대장 객체를 저장할 수 있으므로(archive-tasks) 저장된 대장을 다시 읽어 그 위에 회수 결과를 남긴다.
    const saved = await readLedger(ctx);
    for (const task of Object.values(saved.tasks)) if (task.state === 'FAILED') reclaimTerminals(ctx, saved, task);
    return result;
  });
}

// 동결 계획의 후속 확인과 QA가 남긴 한계(limitations) 목록. 이전 release에는 이 기능이 없으므로 호출하지 않는다.
const remaining = (ctx, flow) => scoped(ctx) ? ctx.flow({ action: 'remaining', plan: flow?.plan, verification: flow?.verification ?? undefined }) : null;

// delivery·prView는 시험에서 병합 증명·PR 조회 결과만 바꾸는 프로세스 내 주입 지점이다. CLI 실행은 항상 고정 release의 delivery와 gh를 쓴다.
// acceptMerged와 publishExec(게시의 git·gh 실행)도 같은 시험용 주입 지점이다(임시 저장소에 GitHub 원격이 없다). CLI는 고정 release의 accept-merged 판정을 쓴다.
export async function main(argv, { cwd = process.cwd(), terminal = process.env.HC_TERMINAL_ID, herdr, bindingFile, delivery, prView, acceptMerged, publishExec } = {}) {
  const [name, ...args] = argv;
  if (name === '--help' || !name) return { commands: Object.keys(optionsByCommand) };
  check(Object.hasOwn(optionsByCommand, name), '알 수 없는 명령: ' + name);
  const optionSpec = Object.fromEntries(Object.entries(optionsByCommand[name]).map(([k, type]) => [k, { type }]));
  const { values: a, positionals: p } = parseArgs({ args, options: optionSpec, allowPositionals: true });
  const hasId = ['show', 'dispatch', 'collect', 'flow-status', 'publish-check', 'direct-publish', 'flow-attach-pr', 'flow-deliver', 'flow-prove-merged', 'flow-resume', 'flow-close',
    'flow-close-local', 'flow-accept-merged', 'cleanup-worktree'].includes(name);
  if (name !== 'decision') check(p.length === Number(hasId), '명령의 위치 인자가 올바르지 않다.');
  const ctx = context(cwd, herdr);
  ctx.delivery = delivery ?? ctx.flow;
  ctx.viewPr = prView ?? (n => viewPr(ctx, n));
  ctx.acceptMerged = acceptMerged ?? ctx.flow;
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
      'add --workflow v2 --kind 종류 [--authorization 원문] --title 제목 --desc-file 요청 --slug 영문 형식이 필요하다.');
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
    if (name === 'flow-status') {
      const left = remaining(ctx, task.x_flow);
      return { id: task.id, state: task.state, pending: task.pending, flow: task.x_flow, ...(left ? { remainingVerification: left } : {}) };
    }
    if (!task.x_archive) return task;
    return adapter.ledgerArchive(ctx.file, { action: 'restore', project, stateDir: ctx.stateDir, ledger, id: task.id });
  }
  if (name === 'archive-tasks') {
    const archive = (ledger, apply) => {
      const decisions = new Set(ctx.decisions({ ledger, action: 'list' }).map(d => d.task?.toUpperCase()));
      const keep = archiveKeep(Object.values(ledger.tasks), decisions);
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
  if (name === 'publish-check') {
    // 게시자는 remainingVerification의 line을 PR 본문 «남은 검증»에 그대로 넣고, decisions를 근거 자료로 읽는다.
    const ledger = await readLedger(ctx);
    const result = publicationCheck(ctx, ledger, p[0], a.committed);
    return scoped(ctx) ? { ...result, decisions: ctx.decisions({ ledger, action: 'resolved-for-task', task: result.id }) } : result;
  }
  return mutate(async ledger => {
    const task = taskById(ledger, p[0]);
    if (name === 'dispatch') return dispatch(ctx, ledger, task);
    if (name === 'collect') return collect(ctx, ledger, task);
    if (name === 'flow-resume') return resume(ctx, ledger, task, a);
    if (name === 'flow-close') return close(ctx, ledger, task, a, terminal);
    if (name === 'flow-close-local') return closeLocal(ctx, ledger, task, a, terminal);
    if (name === 'flow-accept-merged') return closeMerged(ctx, ledger, task, a, terminal);
    withoutDecision(ctx, ledger, task);
    if (name === 'cleanup-worktree') {
      check(!task.x_archive, '보관된 업무는 요약만 남아 정리 근거를 확인할 수 없다. show로 보관본을 확인한 뒤 Lead가 직접 처리한다.');
      check(task.state === 'DONE', 'DONE 업무만 정리한다.');
      return { id: task.id, cleanup: cleanupWorktree(ctx, ledger, task, { retry: true }) };
    }
    if (name === 'flow-attach-pr') return attachPr(ctx, ledger, task, a.pr);
    if (name === 'direct-publish') return directPublish(ctx, ledger, task, publishExec, a.title);
    return deliver(ctx, ledger, task, name, a);
  });
}

// PASS한 QA 회차를 위임한 뒤 해소된 이 업무의 결정은 그 QA 지시서에 없었다. Lead가 flow-resume으로 계획 영향을 판정해
// 재조사로 되돌리거나 영향 없음을 기록하기 전에는 게시·연결·종결·병합하지 않는다.
function requireDecisionReview(ctx, ledger, task) {
  const since = task.runs.filter(r => r.stage === 'qa' && r.outcome === 'PASS').at(-1)?.started ?? '';
  const reviewed = task.x_flow.decisionReviews ?? [];
  const late = ctx.decisions({ ledger, action: 'list', all: true }).filter(r => r.status === 'resolved' && typeof r.task === 'string' &&
    r.task.toUpperCase() === task.id && !(r.resolution?.at < since) && !reviewed.some(v => v.id === r.id && v.revision === r.revision));
  check(!late.length, 'QA 이후 해소된 결정의 계획 영향을 판정하지 않았다: ' + late.map(r => r.id + ' revision ' + r.revision).join(', ') +
    '. 계획을 바꾸면 flow-resume ' + task.id + ' --stage research --decision KEY --revision N --evidence "변경 근거", 바꾸지 않으면 같은 명령에서 --stage 없이 판정 근거를 기록한다.');
}

// 게시와 로컬 종결이 함께 쓰는 QA PASS·결정 검사.
function qaPassed(ctx, ledger, task) {
  withoutDecision(ctx, ledger, task);
  check(task.state === 'QA' && !activeRun(task) && task.x_flow.phase === 'publish' && task.x_flow.verification?.verdict === 'PASS',
    '독립 QA를 통과한 게시 대기 업무만 허용한다.');
  requireDecisionReview(ctx, ledger, task);
}

function publishable(ctx, ledger, task) {
  qaPassed(ctx, ledger, task);
  check(task.x_flow.authorization != null, '게시·병합 권한이 없는 로컬 업무다. 게시하지 않고 flow-close-local로 종결한다.');
}

function sameCandidate(ctx, task) {
  const current = candidate(ctx, task);
  check(current.fingerprint === task.candidate.fingerprint && current.tree === task.candidate.tree, 'QA 이후 후보가 바뀌었다.');
}

function publicationCheck(ctx, ledger, id, committed) {
  const task = taskById(ledger, id);
  publishable(ctx, ledger, task);
  const anchor = committed ? verifyCommit(ctx, task) : null;
  if (!anchor) sameCandidate(ctx, task);
  const left = remaining(ctx, task.x_flow);
  // HH는 QA 실행 영수증을 쓰지 않는다. PR 본문에는 남은 검증 줄만 넣는다.
  return { allowed: true, id, branch: task.branch, candidate: task.candidate, committed: anchor, ...(left ? { remainingVerification: left } : {}) };
}

function attachPr(ctx, ledger, task, text) {
  const { committed: anchor } = publicationCheck(ctx, ledger, task.id, true);
  const number = Number(text);
  check(Number.isSafeInteger(number) && number > 0 && /^[1-9][0-9]*$/.test(text), '--pr에 PR 번호가 필요하다.');
  const pr = ctx.viewPr(number);
  check(pr.number === number && pr.state === 'OPEN' && pr.isCrossRepository === false && !pr.isDraft &&
    pr.headRefName === task.branch && pr.headRefOid === anchor.head && pr.baseRefName === 'main', '원격 PR이 최초 게시 후보와 다르다.');
  // 후속 확인 0건·기존 계획은 본문을 요구하지 않는다. 연결 뒤 본문을 지우면 병합 직전 게이트(core/delivery.cjs)가 다시 막는다.
  const missing = scoped(ctx) ? ctx.flow({ action: 'pr-remaining', plan: task.x_flow.plan, body: pr.body ?? null, verification: task.x_flow.verification ?? undefined }) : [];
  check(!missing.length, 'PR 본문 «남은 검증»에 publish-check의 remainingVerification 줄이 빠졌다: ' + missing.map(m => m.line).join(' / ') +
    ' (각 line을 HTML·코드 블록보다 앞에 "- [ ] " 목록 항목으로 적는다)');
  task.x_flow.delivery = { pr: number, url: pr.url, ...anchor, original: anchor };
  task.x_flow.phase = 'ci';
  task.updated = now();
  save(ctx, ledger, { event: 'x_flow', task: task.id, phase: 'ci', pr: number });
  return { id: task.id, phase: 'ci', ...task.x_flow.delivery };
}

// 게시 에이전트 없이 커밋·push·PR 생성·연결까지 한 번에 한다. 공통 게시 모듈에 이 어댑터의 게시 검사와 연결 처리기를 넘기며 같은 Lead 잠금 안에서 끝낸다.
// HH는 과정 문서 보관·QA 봉투·본문 보강을 쓰지 않는다.
function directPublish(ctx, ledger, task, exec, title) {
  check(existsSync(join(ctx.binding.release, 'core/direct-publish.cjs')), '고정 release가 direct-publish를 지원하지 않는다. 새 release를 설치한 뒤 다시 실행한다.');
  publishable(ctx, ledger, task);
  assertBinding(ctx);
  return ctx.release('direct-publish.cjs').publish(task, { repository, envelope: 'none', ...(title?.trim() ? { title } : {}) }, {
    checkCandidate: () => publicationCheck(ctx, ledger, task.id, false),
    checkCommitted: () => publicationCheck(ctx, ledger, task.id, true),
    attach: number => attachPr(ctx, ledger, task, String(number)),
  }, exec);
}

async function deliver(ctx, ledger, task, name, a) {
  const flow = task.x_flow;
  const proofOnly = name === 'flow-prove-merged';
  check(flow?.version === 2 && flow.verification?.verdict === 'PASS' && flow.delivery && task.candidate &&
    (proofOnly ? ['ci', 'delivery-blocked', 'merged'] : ['ci']).includes(flow.phase),
  'QA 후보와 최초 게시 근거가 있는 업무가 필요하다.');
  check(ctx.release('delivery.cjs').dev14Version === 1, '고정 릴리스가 DEV-14 병합 증명을 지원하지 않는다.');
  const cwd = proofOnly ? ctx.root : task.worktree;
  // 이미 병합된 PR의 증명은 막지 않는다.
  if (!proofOnly) requireDecisionReview(ctx, ledger, task);
  if (!proofOnly) verifyCommit(ctx, task);
  assertBinding(ctx);
  const result = ctx.delivery({ action: 'delivery', cwd, flow, branch: task.branch,
    ...(proofOnly ? { proofOnly: true } : { apply: Boolean(a.apply) }),
    dev14: { candidate: task.candidate, mergeAuthorized: Boolean(a.apply) },
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
  return { id: task.id, ...result, ...(task.state === 'DONE' ? { cleanup: cleanupWorktree(ctx, ledger, task) } : {}) };
}

// PR 없이 독립 QA PASS 후보를 정책 예외로 종결한다. 병합 증명(phase=merged, delivery.merge)과 구분되도록 phase=closed와 closure를 남긴다.
async function close(ctx, ledger, task, a, terminal) {
  const flow = task.x_flow;
  const evidence = a.evidence?.trim();
  check(evidence, '--evidence에 정책 예외 승인 출처와 적용 이유가 필요하다.');
  check(flow?.version === 2 && task.state === 'QA' && !task.current && task.pending === null &&
    flow.phase === 'publish' && !flow.delivery, 'PR이 연결되지 않은 게시 대기 업무만 예외 종결한다.');
  // 현재 후보(tree 포함)와 저장 후보의 대조는 아래 publicationCheck가 한다.
  check(flow.verification?.verdict === 'PASS' && task.candidate?.fingerprint && task.candidate.tree &&
    flow.verification.candidate === task.candidate.fingerprint, '독립 QA PASS가 저장 후보와 일치해야 한다.');
  // PR이 없으면 후속 확인이 드러날 곳이 없으므로 종결 기록에 남긴다.
  const left = publicationCheck(ctx, ledger, task.id, false).remainingVerification ?? [];
  const previousPhase = flow.phase;
  task.pending = null;
  flow.phase = 'closed';
  await transition(ctx, task, 'DONE', '정책 예외 종결: ' + evidence);
  const entry = task.history.at(-1);
  const closure = { kind: 'policy-exception', at: entry.at, terminal, evidence, previousPhase, qaVerdict: flow.verification.verdict,
    ...(left.length ? { remainingVerification: left } : {}) };
  flow.closure = closure;
  entry.closure = { ...closure };
  save(ctx, ledger, { event: 'x_flow', task: task.id, phase: 'closed', closure: closure.kind });
  return { id: task.id, state: task.state, phase: flow.phase, closure, cleanup: cleanupWorktree(ctx, ledger, task) };
}

// 게시 권한 없는 업무를 독립 QA PASS로 종결한다. 판정과 DONE 기록은 고정 release(core/workflow.cjs closeLocal)가 만든다.
async function closeLocal(ctx, ledger, task, a, terminal) {
  check(a.evidence?.trim(), '--evidence에 로컬 종결 근거가 필요하다.');
  check(!task.x_archive, '보관된 업무는 요약만 남아 종결할 수 없다.');
  const result = ctx.flow({ action: 'close-local', task, evidence: a.evidence, terminal, now: now() });
  qaPassed(ctx, ledger, task);
  sameCandidate(ctx, task);
  check(result.task?.id === task.id && result.task.state === 'DONE', '공통 판정 결과가 이 업무의 종결이 아니다.');
  const { at: _, project: __, ...event } = result.event;
  ledger.tasks[task.id] = result.task;
  save(ctx, ledger, event);
  return { id: task.id, state: 'DONE', phase: result.task.x_flow.phase, closure: result.task.x_flow.closure, cleanup: cleanupWorktree(ctx, ledger, result.task) };
}

// 이미 main에 병합된 PR의 업무를 사용자 승인으로 종결한다. PR·원격 main 확인과 DONE 기록은 고정 release가 만들고(core/merged-closure.cjs),
// 이 어댑터는 Lead 잠금 안에서 저장하고 정리를 부른다. Lead가 PR 번호를 직접 지정하므로 PR 브랜치가 업무 브랜치와 달라도 받는다.
async function closeMerged(ctx, ledger, task, a, terminal) {
  check(/^[1-9][0-9]*$/.test(a.pr ?? ''), '--pr에 병합된 PR 번호가 필요하다.');
  check(a.evidence?.trim() && a.source?.trim(), '--evidence에 사용자 승인 원문, --source에 그 출처가 필요하다.');
  check(!task.x_archive, '보관된 업무는 요약만 남아 종결할 수 없다.');
  assertBinding(ctx);
  const result = ctx.acceptMerged({ action: 'accept-merged', task, pr: Number(a.pr), explicit: true,
    evidence: { quote: a.evidence, source: a.source }, terminal, now: now() });
  check(result.task?.id === task.id && result.task.state === 'DONE', '공통 판정 결과가 이 업무의 종결이 아니다.');
  const { at: _, project: __, ...event } = result.event;
  ledger.tasks[task.id] = result.task;
  save(ctx, ledger, event);
  const done = ledger.tasks[task.id];
  return { id: done.id, state: done.state, phase: done.x_flow.phase, closure: done.x_flow.closure, cleanup: cleanupWorktree(ctx, ledger, done) };
}

// 복구 근거로 남길 해소 결정. 이 업무에 연결돼 있고 지정한 revision이 현재 해소 기록과 같아야 한다.
// 이전 release에도 있는 결정함 list --all로 확인하므로 고정 release의 기능 표지와 무관하다.
function resolvedDecision(ctx, ledger, task, id, revision) {
  check(/^[1-9][0-9]*$/.test(revision ?? ''), '--decision에는 해소 결정의 현재 --revision이 함께 필요하다.');
  const found = ctx.decisions({ ledger, action: 'list', all: true }).find(r => r.id === id);
  check(found?.status === 'resolved' && typeof found.task === 'string' && found.task.toUpperCase() === task.id,
    '이 업무에 연결된 해소 결정이 아니다: ' + id);
  check(found.revision === Number(revision), '결정 ' + id + '의 현재 revision은 ' + found.revision + '이다.');
  return { id, revision: found.revision };
}

// 재조사는 QA·게시 근거(delivery anchor)를 지운다. 연결된 PR이 대장 갱신 전에 이미 병합됐으면 병합 증명을 모을 수 없게 되므로,
// 먼저 PR을 조회해 병합됐거나 상태를 확정할 수 없으면 대장을 그대로 두고 거부한다.
function requireUnmergedPr(ctx, task, decision) {
  const number = task.x_flow.delivery.pr;
  const next = ' QA·게시 근거는 그대로 둔다. 병합됐으면 flow-prove-merged ' + task.id + '로 증명하고 결정 ' + decision.id + '은 후속 업무로 다룬다.';
  let pr;
  try { pr = ctx.viewPr(number); } catch (error) { check(false, '연결된 PR #' + number + '의 상태를 확정할 수 없어 재조사하지 않는다(' + error.message + ').' + next); }
  check(pr?.number === number && ['OPEN', 'CLOSED', 'MERGED'].includes(pr.state), '연결된 PR #' + number + '의 상태를 확정할 수 없어 재조사하지 않는다.' + next);
  check(pr.state !== 'MERGED', '연결된 PR #' + number + '이 이미 병합돼 재조사하지 않는다.' + next);
}

async function resume(ctx, ledger, task, a) {
  const flow = task.x_flow;
  // QA PASS 뒤 게시·CI 대기 중인 업무는 계획을 바꾸는 해소 결정을 근거로 재조사에만 되돌린다. 병합·종결된 업무는 대상이 아니다.
  const publishing = flow?.version === 2 && task.state === 'QA' && !activeRun(task) && ['publish', 'ci'].includes(flow.phase) &&
    flow.verification?.verdict === 'PASS';
  check((publishing || task.state === 'BLOCKED' && ['blocked', 'diagnose', 'delivery-blocked'].includes(flow.phase)) &&
    a.evidence?.trim() && [undefined, 'research', 'implement'].includes(a.stage),
  '차단 업무 또는 게시 대기 업무, 달라진 조건의 근거와 유효한 복구 단계가 필요하다.');
  check(a.revision === undefined || a.decision !== undefined, '--revision은 --decision과 함께 지정한다.');
  check(!publishing || (a.decision !== undefined && [undefined, 'research'].includes(a.stage)),
    '게시 대기 업무는 해소 결정(--decision KEY --revision N)을 근거로 재조사(--stage research)로 되돌리거나 계획 영향 없음(--stage 없음)을 기록한다.');
  withoutDecision(ctx, ledger, task);
  const decision = a.decision === undefined ? null : resolvedDecision(ctx, ledger, task, a.decision, a.revision);
  if (publishing && a.stage === undefined) {
    // 계획을 바꾸지 않는 결정: 판정 근거만 남기고 게시 대기·CI 대기와 QA 판정은 그대로 둔다.
    flow.decisionReviews = [...(flow.decisionReviews ?? []).filter(v => v.id !== decision.id), { ...decision, at: now(), evidence: a.evidence }];
    task.updated = now();
    save(ctx, ledger, { event: 'x_flow', task: task.id, phase: flow.phase, decision: decision.id });
    return { id: task.id, state: task.state, pending: task.pending, phase: flow.phase, reviewed: flow.decisionReviews.at(-1) };
  }
  if (publishing && flow.delivery) requireUnmergedPr(ctx, task, decision);
  // 철회하는 QA 보고 지문과 연결된 PR을 남긴다. 열린 PR은 새 QA 뒤 다시 연결해야 병합 판정에 쓰인다.
  const withdrawn = publishing ? { phase: flow.phase, verification: flow.verification.digest ?? null, pr: flow.delivery?.pr ?? null } : null;
  // 계약상 QA에서 조사로 바로 갈 수 없으므로 게시 철회(BLOCKED)를 기록한 뒤 재조사로 보낸다. 이전 QA·게시 허가는 아래에서 지운다.
  if (publishing) await transition(ctx, task, 'BLOCKED', '결정 ' + decision.id + ' revision ' + decision.revision + '로 게시 대기 QA·게시 허가 철회', 'flow-blocked');
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
    delete flow.runner;
    delete flow.decisionReviews;
  }
  // main 이동(revalidate)에서 되돌린 업무는 재구현 DONE 수집까지 표지를 잇는다. 이미 끝난 병합 시도의 blocked_delivery만으로는 켜지 않는다.
  const revalidate = pending !== null && (flow.phase === 'delivery-blocked' ? flow.blocked_delivery?.phase === 'revalidate' : flow.recovery?.revalidate === true);
  flow.recovery = { at: now(), evidence: a.evidence, ...(revalidate ? { revalidate } : {}), ...(decision ? { decision } : {}), ...(withdrawn ? { withdrawn } : {}) };
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
    const result = await main(process.argv.slice(2), { bindingFile });
    console.log(JSON.stringify(result, null, 2));
    // 재시도 명령은 정리가 끝나지 않았으면 nonzero로 끝낸다. DONE 전이 명령의 종료 코드는 정리 결과로 바꾸지 않는다.
    if (process.argv[2] === 'cleanup-worktree' && result.cleanup?.status !== 'done') process.exitCode = 1;
  }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
