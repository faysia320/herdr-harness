import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from '../scripts/build.mjs';
import { run } from '../core/process.js';
const require = createRequire(import.meta.url);
const { configure, resolve } = require('../core/execution-policy.cjs');
const { executionPolicy } = require('../adapters/runtime.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const claudeSettings = (role) => JSON.parse(role.argv[role.argv.indexOf('--settings') + 1]);
const local = () => ({ roles: Object.fromEntries(['research', 'architect', 'implement', 'qa'].map((s) => [s, { skill: `skills/${s}`, invoke: s }])), execution_overrides: {} });

test('프로젝트가 달라도 같은 단계·프로필·재작업 회차의 실제 실행 옵션이 같다', () => {
  const a = local(), b = local(); b.roles.qa.skill = 'other-qa'; b.roles.qa.invoke = '/other-qa';
  b.profile_metadata = { normal: { label: '다른 표시명', focus: ['ui'] } };
  for (const profile of Object.keys(configure(a).routing)) for (const stage of Object.keys(a.roles)) for (const rework of [0, 1, 2, 7]) {
    const x = resolve(a, { profile, rework }, stage), y = resolve(b, { profile, rework }, stage);
    assert.deepEqual(x.argv, y.argv); assert.deepEqual(x.policy, y.policy);
    assert.equal(x.fast, stage === 'qa');
    if (x.cli === 'codex') assert.ok(x.argv.includes(`service_tier="${x.fast ? 'fast' : 'default'}"`));
    else assert.equal(claudeSettings(x).fastMode, false);
  }
  assert.deepEqual(configure(a).limits, configure(b).limits);
});

test('실행 Fast·권한은 상속에 맡기지 않고 명시하며 QA도 별도 모델을 사용한다', () => {
  const impl = resolve(local(), {}, 'implement'), qa = resolve(local(), {}, 'qa'), research = resolve(local(), {}, 'research');
  assert.equal(impl.model, 'claude-opus-5-5');
  assert.deepEqual({ ...claudeSettings(impl), env: undefined }, { fastMode: false, statusLine: { type: 'command', command: '' }, env: undefined });
  assert.ok(research.argv.includes('service_tier="default"'));
  assert.equal(qa.model, 'gpt-6.2-sol'); assert.ok(qa.argv.includes('model_reasoning_effort="high"'));
  assert.ok(qa.argv.includes('service_tier="fast"'));
  assert.ok(qa.argv.includes('danger-full-access') && research.argv.includes('danger-full-access')); assert.ok(impl.argv.includes('auto'));
  assert.equal(qa.argv.includes('bypassPermissions'), false);
});

test('기존 프로필 별칭은 모든 프로젝트에서 같은 단계 구성으로 해석한다', () => {
  const c = configure(local());
  for (const name of ['high', 'architecture', 'token', 'high-risk']) assert.deepEqual(c.routing[name].stages, ['research', 'architect', 'implement', 'qa']);
  assert.equal(resolve(local(), { profile: 'ui-simple' }, 'research').effort, 'high');
  assert.equal(resolve(local(), { profile: 'shared-component' }, 'implement').effort, 'high');
  assert.throws(() => resolve(local(), { profile: 'typo' }, 'implement'), /프로필/);
  const metadata = { 'high-risk': { focus: ['tokens', 'consumers'] } };
  assert.deepEqual(configure({ ...local(), profile_metadata: metadata }).routing.high.focus, metadata['high-risk'].focus);
});

test('x_flow 없는 조회 입력도 v2 정책으로 해석하고 업무 예외는 사유를 요구한다', () => {
  for (const profile of Object.keys(configure(local()).routing)) for (const stage of ['research', 'architect', 'implement', 'qa']) for (const rework of [0, 3])
    assert.deepEqual(resolve(local(), { profile, rework }, stage), resolve(local(), { profile, rework, x_flow: { version: 2 } }, stage));
  const config = configure(local());
  for (const stage of ['research', 'architect', 'implement', 'qa']) {
    const role = resolve(local(), {}, stage);
    assert.deepEqual([role.model, role.effort], [config.roles[stage].model, config.roles[stage].effort]);
  }
  // SW swh·VDP vdh의 set --effort가 읽는 허용 목록만 남는다.
  assert.deepEqual(config.escalation, { effort_ladder: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.equal(resolve(local(), { rework: 3, overrides: { implement: { effort: 'max', reason: '이번 업무 예외' } } }, 'implement').effort, 'max');
  assert.throws(() => resolve(local(), { overrides: { qa: { model: 'opus' } } }, 'qa'), /사유/);
});

test('v2는 재작업으로 모델 노력을 올리지 않고 고위험 별칭을 같은 정책으로 해석한다', () => {
  for (const stage of ['research', 'qa']) {
    const expected = stage === 'research' ? 'gpt-6.2-astra' : 'gpt-6.2-sol';
    const role = resolve(local(), { x_flow: { version: 2 } }, stage);
    assert.equal(role.model, expected);
    assert.deepEqual(role.argv.slice(0, 4), ['codex', '--no-daemon', '-m', expected]);
    assert.equal(role.effort, 'high');
  }
  for (const profile of ['high', 'architecture', 'token', 'high-risk']) {
    assert.equal(resolve(local(), { profile, rework: 3, x_flow: { version: 2 } }, 'implement').effort, 'xhigh');
  }
  for (const rework of [0, 1, 2, 3]) {
    assert.equal(resolve(local(), { rework, x_flow: { version: 2 } }, 'implement').effort, 'high');
    assert.equal(resolve(local(), { rework, x_flow: { version: 2 } }, 'qa').effort, 'high');
  }
});

test('v2는 workflow 기본 → 저장소 예외 → 업무 예외 순서로 model·effort를 정한다', () => {
  const c = local(), task = { x_flow: { version: 2 } };
  c.execution_overrides = { reason: 'CLI 교체', roles: { implement: { cli: 'codex', model: 'gpt-6.2-sol', effort: 'medium', sandbox: 'workspace-write' }, qa: { effort: 'low' } } };
  const pick = (stage, extra) => { const r = resolve(c, { ...task, ...extra }, stage); return [r.cli, r.model, r.effort]; };
  assert.deepEqual(pick('implement'), ['codex', 'gpt-6.2-sol', 'medium']);
  assert.deepEqual(pick('implement', { profile: 'high-risk' }), ['codex', 'gpt-6.2-sol', 'medium']);
  assert.deepEqual(resolve(c, task, 'implement').argv.slice(0, 6), ['codex', '--no-daemon', '-m', 'gpt-6.2-sol', '-c', 'model_reasoning_effort="medium"']);
  assert.deepEqual(pick('qa'), ['codex', 'gpt-6.2-sol', 'low']);
  assert.deepEqual(pick('research'), ['codex', 'gpt-6.2-astra', 'high']);
  assert.deepEqual(pick('implement', { overrides: { implement: { effort: 'high', reason: '업무 예외' } } }), ['codex', 'gpt-6.2-sol', 'high']);
  assert.throws(() => pick('implement', { overrides: { implement: { model: 'claude-opus-5-5', reason: '업무 예외' } } }), /제공자/);
});

test('프로젝트별 변경은 사유를 가진 실행 예외만 허용하고 기존 중복 설정은 거부한다', () => {
  const c = local(); c.execution_overrides = { reason: '명시적 비용 예외', roles: { implement: { fast: false, effort: 'medium' } } };
  assert.equal(resolve(c, {}, 'implement').fast, false);
  assert.equal(resolve(c, {}, 'implement').policy.override_reason, '명시적 비용 예외');
  assert.equal(resolve(c, { profile: 'high-risk', x_flow: { version: 2 } }, 'implement').effort, 'medium');
  assert.notEqual(configure(c).execution_policy.overrides_sha256, configure(local()).execution_policy.overrides_sha256);
  for (const patch of [{ roles: { implement: { fast: false } } }, { reason: 'x', roles: { typo: {} } }, { reason: 'x', roles: { implement: { args: ['-m', 'other'] } } }]) {
    assert.throws(() => configure({ ...local(), execution_overrides: patch }));
  }
  const legacy = local(); legacy.roles.implement.model = 'old'; assert.throws(() => configure(legacy), /공통 정책/);
  for (const [stage, model] of [['implement', 'gpt-6.1-sol'], ['qa', 'claude-opus-5-5'], ['qa', 'opus']]) {
    assert.throws(() => resolve(local(), { overrides: { [stage]: { model, reason: '과거 정책의 모델 예외' } } }, stage), /제공자/);
  }
  assert.throws(() => resolve(local(), { rework: -1 }, 'implement'), /재작업/);
});

test('binding으로 고정한 정책은 Node·Python용 JSON 진입점에서 동일하고 경계 변조를 거부한다', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'herdr-policy-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const built = build(), file = join(stateDir, 'harness-binding.json');
  writeFileSync(file, JSON.stringify({ version: 1, project: 'fixture', release: built.release, manifestHash: built.manifestHash }));
  const input = { action: 'resolve', project: 'fixture', stateDir, config: local(), task: { profile: 'complex', rework: 1 }, stage: 'implement' };
  const direct = executionPolicy(file, input);
  const r = run(process.execPath, ['adapters/runtime.cjs', file, 'policy'], { input: JSON.stringify(input) });
  assert.equal(r.code, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), direct);
  assert.equal(direct.releaseHash, built.manifestHash);
  assert.throws(() => executionPolicy(file, { ...input, project: 'other' }), /경계/);
  assert.throws(() => executionPolicy(file, { ...input, stateDir: join(stateDir, 'other') }), /경계/);
  const b = JSON.parse(readFileSync(file, 'utf8')); b.manifestHash = 'invalid'; writeFileSync(file, JSON.stringify(b));
  assert.throws(() => executionPolicy(file, input), /지문/);
});


test('사용자 지정 모델 배치와 조사·QA high는 모든 프로필에서 유지된다', () => {
  for (const profile of Object.keys(configure(local()).routing)) {
    for (const [stage, cli, model, effort] of [
      ['research', 'codex', 'gpt-6.2-astra', 'high'],
      ['architect', 'claude', 'claude-fable-5-2', 'high'],
      ['qa', 'codex', 'gpt-6.2-sol', 'high'],
    ]) {
      const role = resolve(local(), { profile }, stage);
      assert.deepEqual([role.cli, role.model, role.effort], [cli, model, effort]);
    }
    assert.equal(resolve(local(), { profile }, 'implement').model, 'claude-opus-5-5');
  }
});

test('CLI 교체 시 스킬의 이름·인자를 보존하고 해당 제공자의 경로·호출법을 사용한다', () => {
  const config = local();
  config.roles.implement = { skill: '.agents/skills/implement/SKILL.md', invoke: '$implement --worker' };
  config.roles.qa = { skill: '.claude/skills/qa/SKILL.md', invoke: '/qa' };
  const impl = resolve(config, {}, 'implement'), qa = resolve(config, {}, 'qa');
  assert.equal(impl.skill, '.claude/skills/implement/SKILL.md'); assert.equal(impl.invoke, '/implement --worker');
  assert.equal(qa.skill, '.agents/skills/qa/SKILL.md'); assert.equal(qa.invoke, '$qa');
  config.execution_overrides = { reason: 'CLI 복귀 호환 시험', roles: { implement: { cli: 'codex', model: 'gpt-6.1-sol', sandbox: 'workspace-write' } } };
  assert.equal(resolve(config, {}, 'implement').invoke, '$implement --worker');
  config.roles.implement.skill = 'custom/skill.md';
  assert.equal(resolve(config, {}, 'implement').skill, 'custom/skill.md');
});

test('모든 단계에 병렬도 상한과 무거운 작업 슬롯 규칙을, QA에는 무관 실패·반복 금지·완료 보고 규칙을 CLI 자체 옵션으로 전달한다', () => {
  const { resources } = JSON.parse(readFileSync(new URL('../policy/execution.json', import.meta.url)));
  const heavy = join(root, 'bin/heavy.mjs').replaceAll('\\', '/');
  for (const stage of ['research', 'architect', 'implement', 'qa']) {
    const role = resolve(local(), {}, stage);
    const rules = role.cli === 'codex'
      ? JSON.parse(role.argv.find((a) => a.startsWith('developer_instructions=')).slice('developer_instructions='.length))
      : role.argv[role.argv.indexOf('--append-system-prompt') + 1];
    if (role.cli === 'codex') for (const [key, value] of Object.entries(resources.env)) assert.ok(role.argv.includes(`shell_environment_policy.set.${key}="${value}"`));
    else assert.deepEqual(claudeSettings(role).env, resources.env);
    assert.ok(rules.includes(`node ${heavy} -- <명령>`) && rules.includes(`동시 ${resources.heavy_slots}개`));
    assert.doesNotMatch(rules, /\{(?:heavy|slots|env)\}|"/);
    assert.equal(/후보와 무관한 실패/.test(rules) && /같은 조건 반복 금지/.test(rules) && /완료 보고 명령을 반드시 실행한다/.test(rules) && /herdr-proof-\*/.test(rules), stage === 'qa');
  }
});
