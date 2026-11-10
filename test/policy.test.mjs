import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../scripts/build.mjs';
import { run } from '../core/process.js';
const require = createRequire(import.meta.url);
const { configure, resolve } = require('../core/execution-policy.cjs');
const { executionPolicy } = require('../adapters/runtime.cjs');
const local = () => ({ roles: Object.fromEntries(['research', 'architect', 'implement', 'qa'].map((s) => [s, { skill: `skills/${s}`, invoke: s }])), execution_overrides: {} });

test('프로젝트가 달라도 같은 단계·프로필·재작업 회차의 실제 실행 옵션이 같다', () => {
  const a = local(), b = local(); b.roles.qa.skill = 'other-qa'; b.roles.qa.invoke = '/other-qa';
  b.profile_metadata = { normal: { label: '다른 표시명', focus: ['ui'] } };
  for (const profile of Object.keys(configure(a).routing)) for (const stage of Object.keys(a.roles)) for (const rework of [0, 1, 2, 7]) {
    const x = resolve(a, { profile, rework }, stage), y = resolve(b, { profile, rework }, stage);
    assert.deepEqual(x.argv, y.argv); assert.deepEqual(x.policy, y.policy);
    assert.equal(x.fast, false);
    assert.ok(x.argv.includes(x.cli === 'codex' ? 'service_tier="default"' : '{"fastMode":false}'));
  }
  assert.deepEqual(configure(a).limits, configure(b).limits);
});

test('실행 Fast·권한은 상속에 맡기지 않고 명시하며 QA도 별도 모델을 사용한다', () => {
  const impl = resolve(local(), {}, 'implement'), qa = resolve(local(), {}, 'qa'), research = resolve(local(), {}, 'research');
  assert.equal(impl.model, 'claude-opus-5-5'); assert.ok(impl.argv.includes('{"fastMode":false}'));
  assert.ok(research.argv.includes('service_tier="default"'));
  assert.equal(qa.model, 'gpt-6.1-sol'); assert.ok(qa.argv.includes('model_reasoning_effort="xhigh"'));
  assert.ok(qa.argv.includes('service_tier="default"'));
  assert.ok(qa.argv.includes('windows.sandbox="unelevated"') && research.argv.includes('windows.sandbox="unelevated"'));
  assert.ok(qa.argv.includes('workspace-write')); assert.ok(impl.argv.includes('auto'));
  assert.equal(qa.argv.includes('bypassPermissions'), false);
});

test('기존 프로필 별칭은 모든 프로젝트에서 같은 단계 구성으로 해석한다', () => {
  const c = configure(local());
  for (const name of ['high', 'architecture', 'token', 'high-risk']) assert.deepEqual(c.routing[name].stages, ['research', 'architect', 'implement', 'qa']);
  assert.equal(resolve(local(), { profile: 'ui-simple' }, 'research').effort, 'high');
  assert.equal(resolve(local(), { profile: 'shared-component' }, 'implement').effort, 'xhigh');
  assert.throws(() => resolve(local(), { profile: 'typo' }, 'implement'), /프로필/);
  const metadata = { 'high-risk': { focus: ['tokens', 'consumers'] } };
  assert.deepEqual(configure({ ...local(), profile_metadata: metadata }).routing.high.focus, metadata['high-risk'].focus);
});

test('재작업 상향은 max에서 멈추고 명시적 업무 예외는 자동 상향보다 우선한다', () => {
  assert.deepEqual([0, 1, 2, 3].map((rework) => resolve(local(), { rework }, 'implement').effort), ['high', 'xhigh', 'max', 'max']);
  const task = { rework: 3, overrides: { implement: { effort: 'high', reason: '이번 수정은 작은 후속 조치' } } };
  assert.equal(resolve(local(), task, 'implement').effort, 'high');
  assert.equal(resolve(local(), { rework: 3 }, 'qa').effort, 'xhigh');
  assert.throws(() => resolve(local(), { overrides: { qa: { model: 'opus' } } }, 'qa'), /사유/);
});

test('중앙 정책의 재작업 상향 폭 변경이 resolver에 적용된다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-escalation-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'core')); mkdirSync(join(root, 'policy'));
  copyFileSync(new URL('../core/execution-policy.cjs', import.meta.url), join(root, 'core/execution-policy.cjs'));
  const policy = JSON.parse(readFileSync(new URL('../policy/execution.json', import.meta.url)));
  policy.escalation.implement_step_per_rework = 2;
  writeFileSync(join(root, 'policy/execution.json'), JSON.stringify(policy));
  assert.equal(require(join(root, 'core/execution-policy.cjs')).resolve(local(), { rework: 1 }, 'implement').effort, 'max');
});

test('프로젝트별 변경은 사유를 가진 실행 예외만 허용하고 기존 중복 설정은 거부한다', () => {
  const c = local(); c.execution_overrides = { reason: '명시적 비용 예외', roles: { implement: { fast: false, effort: 'medium' } } };
  assert.equal(resolve(c, {}, 'implement').fast, false);
  assert.equal(resolve(c, {}, 'implement').policy.override_reason, '명시적 비용 예외');
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


test('사용자 지정 모델 배치와 조사 high·QA xhigh는 모든 프로필에서 유지된다', () => {
  for (const profile of Object.keys(configure(local()).routing)) {
    for (const [stage, cli, model, effort] of [
      ['research', 'codex', 'gpt-6-astra', 'high'],
      ['architect', 'claude', 'claude-fable-5-2', 'high'],
      ['qa', 'codex', 'gpt-6.1-sol', 'xhigh'],
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
