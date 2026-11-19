// 세 CLI가 공유하는 위임 정책. 업무 대장·스킬·승인 판정은 변경하지 않는다.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const raw = fs.readFileSync(path.join(__dirname, '../policy/execution.json'));
const defaults = JSON.parse(raw);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const stages = ['research', 'architect', 'implement', 'qa'];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const roleKeys = ['cli', 'model', 'effort', 'fast', 'sandbox', 'permission_mode'];
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (message) => { throw new Error(message); };

function roleCheck(role) {
  if (!['codex', 'claude'].includes(role.cli) || typeof role.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(role.model)
    || !efforts.includes(role.effort) || typeof role.fast !== 'boolean') fail('지원하지 않는 모델·effort·Fast 설정이다.');
  if (role.cli === 'codex' && !['read-only', 'workspace-write', 'danger-full-access'].includes(role.sandbox)) fail('지원하지 않는 Codex sandbox다.');
  if (role.cli === 'claude' && role.permission_mode !== 'auto') fail('Claude 권한 모드는 auto여야 한다.');
  if ((role.cli === 'claude' && /^(?:gpt-|o\d)/i.test(role.model))
    || (role.cli === 'codex' && /^(?:claude-|(?:opus|fable|sonnet|haiku)(?:$|[-.]))/i.test(role.model))) fail('모델과 CLI 제공자가 다르다. 기존 모델 예외를 해제하거나 현재 CLI에 맞게 갱신한다.');
}

function configure(local) {
  if (!object(local) || !object(local.roles) || defaults.version !== 1) fail('공통 실행 정책 설정 형식이 올바르지 않다.');
  const extra = local.execution_overrides ?? {};
  if (!object(extra) || Object.keys(extra).some((k) => !['reason', 'roles', 'limits'].includes(k))) fail('execution_overrides에는 reason·roles·limits만 사용할 수 있다.');
  if (Object.keys(extra).length && (typeof extra.reason !== 'string' || !extra.reason.trim()
    || (extra.roles !== undefined && !object(extra.roles)) || (extra.limits !== undefined && !object(extra.limits)))) fail('프로젝트 실행 예외에는 reason과 올바른 roles·limits가 필요하다.');
  for (const key of ['routing', 'profiles', 'default_profile', 'escalation']) if (local[key] !== undefined) fail(`${key}는 공통 정책에서 관리한다.`);
  for (const key of [...Object.keys(defaults.limits), 'max_parallel_tasks', 'escalate_after_rework']) if (local.limits?.[key] !== undefined) fail(`${key} 변경은 execution_overrides.limits에서 사유와 함께 지정한다.`);
  for (const [key, value] of Object.entries(extra.limits ?? {})) if (!Object.hasOwn(defaults.limits, key) || !Number.isInteger(value) || value < (key === 'max_parallel' ? 1 : 0)) fail(`지원하지 않는 실행 한도 예외: ${key}`);
  for (const stage of Object.keys(extra.roles ?? {})) if (!stages.includes(stage)) fail(`알 수 없는 예외 단계: ${stage}`);
  const roles = {};
  for (const stage of stages) {
    const adapter = local.roles[stage], patch = extra.roles?.[stage] ?? {};
    if (!object(adapter) || Object.keys(adapter).some((k) => !['skill', 'invoke'].includes(k))) fail(`${stage}: 모델·effort·실행 옵션은 공통 정책 또는 명시적 execution_overrides에서만 설정한다.`);
    if (!object(patch) || Object.keys(patch).some((k) => !roleKeys.includes(k))) fail(`${stage}: 지원하지 않는 실행 예외 필드다.`);
    roles[stage] = { ...defaults.roles[stage], ...patch, ...adapter };
    roleCheck(roles[stage]);
    // 표준 스킬 경로와 명시 호출 접두사는 선택한 CLI에 맞춘다.
    // 프로젝트별 스킬 이름·인자와 표준 경로 밖의 사용자 지정 경로는 보존한다.
    const role = roles[stage], provider = role.cli === 'codex' ? '.agents' : '.claude';
    if (typeof role.skill === 'string') role.skill = role.skill.replace(/^\.(?:agents|claude)\/skills\//, `${provider}/skills/`);
    if (typeof role.invoke === 'string') role.invoke = role.invoke.replace(/^[$/]/, role.cli === 'codex' ? '$' : '/');
  }
  // 과거 업무의 profile 이름은 모든 프로젝트에서 동일한 별칭으로 해석한다.
  const routing = {};
  for (const name of [...Object.keys(defaults.profiles), ...Object.keys(defaults.aliases)]) {
    const canonical = defaults.aliases[name] ?? name;
    const profile = defaults.profiles[canonical];
    const metadata = local.profile_metadata?.[name] ?? local.profile_metadata?.[canonical] ?? {};
    routing[name] = { ...profile, label: metadata.label ?? canonical, focus: metadata.focus ?? [], architect: profile.stages.includes('architect'), canonical };
  }
  const limits = { ...local.limits, ...defaults.limits, ...extra.limits, escalate_after_rework: 1 };
  limits.max_parallel_tasks = limits.max_parallel;
  return { ...local, roles, routing, profiles: routing, default_profile: defaults.default_profile, limits,
    escalation: defaults.escalation,
    execution_policy: { version: defaults.version, sha256: digest(raw), overrides_sha256: digest(JSON.stringify(extra)), override_reason: extra.reason ?? null } };
}

function resolve(local, task, stage) {
  const config = configure(local);
  if (!stages.includes(stage)) fail(`알 수 없는 단계: ${stage}`);
  const profile = task.profile ?? config.default_profile, route = config.routing[profile];
  if (!route) fail(`알 수 없는 실행 프로필: ${profile}`);
  if (!Number.isInteger(task.rework ?? 0) || (task.rework ?? 0) < 0) fail('재작업 횟수가 올바르지 않다.');
  const override = task.overrides?.[stage] ?? {};
  if (!object(override) || Object.keys(override).some((k) => !['model', 'effort', 'reason'].includes(k))) fail('업무별 예외 형식이 올바르지 않다.');
  if ((override.model != null || override.effort != null) && (typeof override.reason !== 'string' || !override.reason.trim())) fail('업무별 모델·effort 변경에는 사유가 필요하다.');
  const role = { ...config.roles[stage], effort: route.effort[stage] ?? config.roles[stage].effort };
  if (task.x_flow?.version === 2) {
    const selected = require('../policy/workflow.json').roles[stage];
    role.model = selected.model;
    role.effort = route.canonical === 'high-risk' && stage === 'implement' ? 'xhigh' : selected.effort;
  } else if (stage === 'implement') {
    const ladder = config.escalation.effort_ladder;
    role.effort = ladder[Math.min(ladder.indexOf(role.effort) + (task.rework ?? 0) * config.escalation.implement_step_per_rework, ladder.length - 1)];
  }
  // 명시적 업무 예외는 자동 상향보다 우선한다. 선택한 effort를 다시 올리지 않는다.
  if (override.model != null) role.model = override.model;
  if (override.effort != null) role.effort = override.effort;
  roleCheck(role);
  return { ...role, argv: launchArgs(role, stage), policy: { ...config.execution_policy, profile: route.canonical, rework: task.rework ?? 0, task_override: override } };
}

// 게시는 독립 QA가 끝난 뒤 Lead가 위임한다. 일반 작업 단계와 별개이므로 v1 프로필에 추가하지 않는다.
function publisherCommand(task, project, id) {
  if (task?.project !== project || task?.id !== id) fail('조회된 게시 업무의 프로젝트 또는 ID가 다르다.');
  const flow = task.x_flow;
  if (task.archived || task.state !== 'QA' || flow?.version !== 2 || flow.phase !== 'publish'
    || flow.verification?.verdict !== 'PASS' || typeof flow.authorization !== 'string' || !flow.authorization.trim())
    fail('독립 QA를 통과한 v2 게시 대기 업무가 필요하다.');
  if (typeof task.worktree !== 'string' || !path.isAbsolute(task.worktree)) fail('게시 worktree의 절대 경로가 필요하다.');
  const role = require('../policy/workflow.json').delivery.publisher;
  roleCheck(role);
  return { id, worktree: task.worktree, ...role, argv: launchArgs(role, 'publish') };
}

function launchArgs(role, stage) {
  // 여러 저장소의 에이전트가 한 PC를 나눠 쓴다. 병렬도 상한은 에이전트가 실행하는 명령의 환경으로, 무거운 작업 슬롯과 단계 규칙은 각 CLI의 지시로 전달한다.
  // 프로젝트 CLI는 argv를 그대로 실행하므로 회사 저장소를 고치지 않아도 같은 규칙이 적용된다.
  const { env, heavy_slots: slots } = defaults.resources;
  const rules = [...defaults.instructions.all, ...(defaults.instructions[stage] ?? [])].join('\n')
    .replaceAll('{heavy}', path.join(__dirname, '../bin/heavy.mjs').replaceAll('\\', '/'))
    .replaceAll('{slots}', String(slots)).replaceAll('{env}', Object.keys(env).join('·'));
  // 하위 에이전트 화면은 사람이 보지 않는다. 사용자 statusline(Git Bash)이 짧은 실행이 끝날 때 고아로 남아 쌓이므로 빈 명령으로 끈다.
  return role.cli === 'codex'
    ? ['codex', '--no-daemon', '-m', role.model, '-c', `model_reasoning_effort="${role.effort}"`, '-c', `service_tier="${role.fast ? 'fast' : 'default'}"`, '-s', role.sandbox,
      ...Object.entries(env).flatMap(([key, value]) => ['-c', `shell_environment_policy.set.${key}="${value}"`]), '-c', `developer_instructions=${JSON.stringify(rules)}`]
    : ['claude', '--model', role.model, '--effort', role.effort, '--permission-mode', role.permission_mode,
      '--settings', JSON.stringify({ fastMode: role.fast, statusLine: { type: 'command', command: '' }, env }), '--append-system-prompt', rules];
}

module.exports = { configure, resolve, publisherCommand };
