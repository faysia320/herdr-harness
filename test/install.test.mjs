import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from '../scripts/install.mjs';
import { verifyInstall } from '../scripts/verify-install.mjs';
import { rollback } from '../scripts/rollback.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modPath = join(root, 'mod'), state = join(root, 'state');
  mkdirSync(modPath); mkdirSync(state);
  writeFileSync(join(modPath, 'projects.json'), '{"projects":[{"name":"kept"}]}');
  writeFileSync(join(modPath, 'main.js'), 'old source');
  writeFileSync(join(state, 'ledger.json'), 'ledger bytes'); writeFileSync(join(state, 'decisions.json'), 'decision bytes');
  return { root, state, modPath, plan: { store: join(root, 'store'), modPath, bindings: [{ project: 'fixture', file: join(state, 'harness-binding.json'), cwd: root, command: ['node', 'adapter.mjs'] }] } };
}
test('설치 지문·업데이트·rollback은 개인 설정과 업무 자료를 보존한다', (t) => {
  const f = fixture(t), options = { check: () => {} };
  const first = install({ ...f.plan, modPath: f.plan.modPath.replaceAll('\\', '/') }, options); verifyInstall(f.plan.store);
  assert.ok(existsSync(join(f.root, 'harness-auto/main.js')));
  writeFileSync(join(f.modPath, 'projects.json'), 'changed personal config');
  install(f.plan, options); rollback(f.plan.store); verifyInstall(f.plan.store);
  rollback(f.plan.store);
  assert.equal(readFileSync(join(f.modPath, 'main.js'), 'utf8'), 'old source');
  assert.equal(readFileSync(join(f.modPath, 'projects.json'), 'utf8'), 'changed personal config');
  assert.equal(readFileSync(join(f.state, 'ledger.json'), 'utf8'), 'ledger bytes');
  assert.equal(readFileSync(join(f.state, 'decisions.json'), 'utf8'), 'decision bytes');
  assert.equal(existsSync(join(f.state, 'harness-binding.json')), false);
  assert.equal(existsSync(join(f.root, 'harness-auto/main.js')), false);
  assert.ok(first.manifestHash);
});
test('검사 실패·설치 후 변조를 감지하고 이전 파일을 보존한다', (t) => {
  const f = fixture(t);
  assert.throws(() => install(f.plan, { check: () => { throw new Error('native failure'); } }), /native failure/);
  assert.equal(readFileSync(join(f.modPath, 'main.js'), 'utf8'), 'old source');
  let checks = 0;
  assert.throws(() => install(f.plan, { check: () => { if (++checks === 3) throw new Error('after failure'); } }), /after failure/);
  assert.equal(readFileSync(join(f.modPath, 'main.js'), 'utf8'), 'old source');
  const installed = install(f.plan, { check: () => {} });
  writeFileSync(join(installed.release, 'core/decisions.js'), 'tampered');
  assert.throws(() => verifyInstall(f.plan.store), /지문 불일치/);
  assert.throws(() => rollback(f.plan.store), /지문 불일치/);
});
test('잘못된 연결 경로가 대장·결정함·개인 설정을 덮어쓰지 못한다', (t) => {
  const f = fixture(t);
  for (const file of [join(f.state, 'ledger.json'), join(f.state, 'decisions.json'), join(f.modPath, 'projects.json')]) {
    const before = readFileSync(file);
    const plan = { ...f.plan, bindings: [{ ...f.plan.bindings[0], file }] };
    assert.throws(() => install(plan, { check: () => {} }), /harness-binding.json/);
    assert.deepEqual(readFileSync(file), before);
  }
  assert.throws(() => install({ ...f.plan, bindings: [...f.plan.bindings, ...f.plan.bindings] }, { check: () => {} }), /중복/);
});
test('설치 중 다른 설치·복구는 거부하고 실패 복원 뒤 잠금을 해제한다', (t) => {
  const f = fixture(t);
  install(f.plan, { check: () => {} });
  const original = readFileSync(join(f.modPath, 'main.js'));
  let checked = 0;
  assert.throws(() => install(f.plan, { check: () => {
    assert.throws(() => install(f.plan, { check: () => {} }), /진행 중/);
    assert.throws(() => rollback(f.plan.store), /진행 중/);
    if (++checked === 3) throw new Error('second native failure');
  } }), /second native failure/);
  assert.equal(checked, 3);
  assert.deepEqual(readFileSync(join(f.modPath, 'main.js')), original);
  verifyInstall(f.plan.store);
  rollback(f.plan.store);
  assert.equal(readFileSync(join(f.modPath, 'main.js'), 'utf8'), 'old source');
});
