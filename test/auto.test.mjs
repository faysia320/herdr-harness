import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('일반·원격 공간에서도 열고 같은 공간의 수동 토글은 보존한다', () => {
  const source = readFileSync(new URL('../mod/harness-auto/main.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export default class HarnessAuto', 'class HarnessAuto');
  let space = { id: 'one', name: 'smart-workspace', active: true, machine: null, tabs: [{ id: 'tab' }] };
  let cwd = 'D:/repositories/smart-workspace';
  const calls = [];
  const Auto = new Function('View', 'div', 'spaces', 'panes', 'run', 'checking', `${source}; return HarnessAuto;`)(
    class {}, () => ({ size() {} }), () => space ? [space] : [], () => [{ tab: 'tab', cwd }], (...args) => calls.push(args), () => false);
  const view = new Auto(); view.projects = [{ name: 'smart-workspace', root: cwd }];
  view.render(); view.render();
  assert.equal(calls.length, 1); assert.equal(calls.at(-1)[0], 'layout.show');
  cwd = 'd:\\REPOSITORIES\\smart-workspace\\src'; view.render();
  assert.equal(calls.length, 1);
  cwd = 'D:/repositories/herdr-harness'; view.render(); view.render();
  assert.equal(calls.length, 1); assert.equal(calls.at(-1)[0], 'layout.show');
  space = { ...space, id: 'two' }; view.render();
  assert.equal(calls.length, 2); assert.equal(calls.at(-1)[0], 'layout.show');
  cwd = 'D:/repositories/smart-workspace-other'; view.render();
  assert.equal(calls.length, 2);
  cwd = 'D:/repositories/smart-workspace'; view.render();
  assert.equal(calls.at(-1)[0], 'layout.show');
  space = { ...space, machine: 'remote' }; view.render();
  assert.equal(calls.at(-1)[0], 'layout.show');
  space = null; view.render();
  assert.deepEqual(calls.at(-1), ['layout.hide', { id: 'harness' }]);
});
