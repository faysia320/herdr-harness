// v2는 v1 업무를 이동시키지 않는다. 프로젝트 writer가 잠금 안에서 이 판정을 적용한다.
const policy = require('../policy/workflow.json');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
function create(kind, authorization) {
  if (!Object.hasOwn(policy.playbooks, kind)) fail('지원하지 않는 workflow 종류');
  if (!text(authorization)) fail('자동 게시·병합 권한의 사용자 근거가 필요하다.');
  return { version: 2, kind, phase: 'work', authorization, failures: [], repairs: 0, verification: null, delivery: null };
}
function validateReport(report, candidate) {
  if (report?.version !== 2 || report.candidate !== candidate || !/^[a-f0-9]{64}$/.test(candidate)) fail('검증 보고서의 후보 지문이 다르다.');
  if (!['PASS', 'FAIL', 'BLOCKED'].includes(report.verdict)) fail('검증 판정이 올바르지 않다.');
  if (!Array.isArray(report.criteria) || !report.criteria.length || !Array.isArray(report.findings) || !Array.isArray(report.checks) || !report.checks.length) fail('AC·검사·결함 목록이 필요하다.');
  for (const c of report.criteria) if (!text(c.id) || !['passed','failed','unverified'].includes(c.status) || !text(c.evidence)) fail('AC별 상태·증거가 필요하다.');
  if (new Set(report.criteria.map(c=>c.id)).size !== report.criteria.length) fail('중복 AC');
  for (const c of report.checks) if (!text(c.id) || !text(c.command) || !text(c.evidence) || !['passed','failed','blocked'].includes(c.status)) fail('검사별 명령·결과·증거가 필요하다.');
  for (const f of report.findings) {
    if (!text(f.id) || !text(f.signature) || !text(f.evidence) || !text(f.next) || !['code','environment','test','verification','decision'].includes(f.kind)) fail('결함은 종류·원인 식별자·근거·다음 조치가 필요하다.');
  }
  if (report.verdict === 'PASS' && (report.findings.length || report.criteria.some(c=>c.status!=='passed') || report.checks.some(c=>c.status!=='passed'))) fail('미검증·실패·미해소 결함을 PASS로 만들 수 없다.');
  if (report.verdict !== 'PASS' && !report.findings.length) fail('실패·보류의 원인 분류가 필요하다.');
  if (report.verdict === 'FAIL' && !report.findings.some(f=>f.kind==='code')) fail('후보 코드 결함 없는 실패는 BLOCKED로 분류한다.');
  return report;
}
function collect(flow, report, candidate) {
  if (flow?.version !== 2) fail('v2 업무가 아니다.');
  validateReport(report, candidate);
  if (!flow.plan?.criteria?.length || !flow.plan?.checks?.length) fail('구현 전에 확정한 검증 계획이 없다.');
  for (const id of flow.plan.criteria) if (!report.criteria.some(c=>c.id===id)) fail(`AC 검증 누락: ${id}`);
  for (const id of flow.plan.checks) if (!report.checks.some(c=>c.id===id)) fail(`필수 검사 누락: ${id}`);
  const next = structuredClone(flow);
  next.verification = { ...report, digest: hash(report) };
  if (report.verdict === 'PASS') { next.phase = 'publish'; next.delivery = null; return { flow: next, state: 'QA', pending: null, awaiting: null, reason: '검증 통과 · 게시·자동 병합 대기' }; }
  for (const f of new Map(report.findings.map(f=>[f.signature,f])).values()) next.failures.push({ signature: f.signature, kind: f.kind, candidate });
  const repeated = report.findings.some(f=>next.failures.filter(x=>x.signature===f.signature).length>=policy.max_same_failure);
  const code = report.findings.some(f=>f.kind==='code');
  if (code) next.repairs++;
  next.phase = repeated || next.repairs > policy.max_repairs ? 'diagnose' : code ? 'repair' : 'blocked';
  const pending = next.phase==='repair' ? 'implement' : 'qa';
  return { flow: next, state: next.phase==='repair' ? 'READY_TO_IMPLEMENT' : 'BLOCKED', pending,
    awaiting: next.phase==='repair' ? null : `flow-${next.phase}`, reason: report.findings.map(f=>`${f.kind}: ${f.next}`).join('; ') };
}
function instructions(flow, stage, candidate) {
  if (flow?.version !== 2) return '';
  const role = policy.roles[stage];
  return `[하네스 v2 ${flow.kind}] ${policy.playbooks[flow.kind]}\n` +
    `역할 ${stage}, 진단 점검 시점 ${role.minutes}분. 이 시간은 강제 종료나 통과 기준이 아니다. 넘으면 실제 실행·자원 대기·인계 시간을 구분하고 계속할 근거를 남긴다.\n` +
    '동일 원인 반복은 effort 상향으로 대신하지 않는다. 실패 명령·기대/실제 결과·수정 범위를 전달하고 실패 검사부터 확인한다. 환경 실패는 제품 재작업으로 세지 않는다.\n' +
    (stage==='research' ? '업무 폴더에 verification-plan.json을 작성한다. {"version":2,"criteria":["원래 요구사항의 AC 식별자"],"checks":["필수 검사 식별자"]}. 실제 재현 명령·기대 결과·환경 준비는 조사 문서에 남긴다. 큰 작업은 독립 결과 단위로 Lead에게 분해를 제안한다.\n' : '') +
    (stage==='qa' ? `기존 독립 QA와 함께 업무 폴더에 verification.json을 쓴다. version=2, candidate=${candidate}, verdict=PASS|FAIL|BLOCKED. criteria=[{id,status:passed|failed|unverified,evidence}], checks=[{id,command,status:passed|failed|blocked,evidence}], findings=[{id,kind:code|environment|test|verification|decision,signature:반복원인식별자,evidence,next}]. 원래 AC를 빠짐없이 대조한다. PASS에는 실패·미검증·미해소 finding이 없어야 한다. 환경만 막혔으면 BLOCKED. 같은 후보의 독립 QA 검사 기록은 검증 runner의 --resume-qa로만 재사용하고 보고 자체를 통과 근거로 쓰지 않는다.\n` : '') +
    (flow.verification?.findings?.length ? `직전 결함과 재개 조건: ${JSON.stringify(flow.verification.findings)}\n` : '');
}
function mergeGate(flow, pr, required) {
  const reasons = [];
  let blocked = false;
  if (flow?.version !== 2 || !text(flow.authorization) || flow.verification?.verdict !== 'PASS' || !['publish','ci','merged'].includes(flow.phase)) reasons.push('유효한 검증·권한 없음');
  if (!flow.delivery || flow.delivery.head !== pr.headRefOid || flow.delivery.base !== pr.baseRefOid) reasons.push('검증 후 head/base 변경');
  if (pr.state !== 'OPEN' || pr.isDraft || pr.baseRefName !== policy.delivery.base || pr.isCrossRepository) reasons.push('PR 대상·상태 불일치');
  if (pr.mergeable !== 'MERGEABLE' || pr.mergeStateStatus !== 'CLEAN') reasons.push('병합 상태 미확정·차단');
  if (['CHANGES_REQUESTED','REVIEW_REQUIRED'].includes(pr.reviewDecision)) reasons.push('필수 리뷰 미충족');
  if (!Array.isArray(required) || !required.length || required.some(c=>c.bucket!=='pass')) reasons.push('필수 CI 미완료·실패·없음');
  const checks = pr.statusCheckRollup ?? [];
  if (!checks.length || checks.some(c=>c.__typename==='StatusContext' ? c.state!=='SUCCESS' : c.status!=='COMPLETED' || !['SUCCESS','NEUTRAL','SKIPPED'].includes(c.conclusion))) reasons.push('PR 검사 미완료·실패');
  // 아직 실행 중인 CI만 폴링한다. 실패·누락·사람의 조치가 필요한 상태는 즉시 Lead로 돌린다.
  const pending = (Array.isArray(required) && required.some(c=>c.bucket==='pending')) || checks.some(c=>c.__typename==='StatusContext' ? c.state==='PENDING' : ['QUEUED','IN_PROGRESS','PENDING','WAITING'].includes(c.status));
  blocked = reasons.length > 0 && (
    flow?.version!==2 || !text(flow.authorization) || flow.verification?.verdict!=='PASS' ||
    !['publish','ci','merged'].includes(flow.phase) ||
    !flow.delivery || flow.delivery.head!==pr.headRefOid || flow.delivery.base!==pr.baseRefOid ||
    pr.state!=='OPEN' || pr.isDraft || pr.isCrossRepository || pr.baseRefName!==policy.delivery.base ||
    pr.mergeable==='CONFLICTING' || ['DIRTY','DRAFT'].includes(pr.mergeStateStatus) ||
    (!pending && !['CLEAN','UNKNOWN'].includes(pr.mergeStateStatus)) ||
    ['CHANGES_REQUESTED','REVIEW_REQUIRED'].includes(pr.reviewDecision) ||
    !Array.isArray(required) || !required.length || required.some(c=>!['pass','pending'].includes(c.bucket)) ||
    !checks.length || checks.some(c=>c.__typename==='StatusContext' ? ['FAILURE','ERROR'].includes(c.state) : c.status==='COMPLETED' && !['SUCCESS','NEUTRAL','SKIPPED'].includes(c.conclusion))
  );
  return { ready: !reasons.length, reasons, blocked };
}
module.exports = { policy, create, validateReport, collect, instructions, mergeGate };
