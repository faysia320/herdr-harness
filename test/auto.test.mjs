import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('공간 전환 때 일반 저장소도 열고 같은 공간의 수동 토글은 보존한다', () => {
  const source = readFileSync(new URL('../mod/harness-auto/main.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export default class HarnessAuto', 'class HarnessAuto');
  let space = { id: 'one', name: 'smart-workspace', active: true, machine: null };
  const calls = [];
  const Auto = new Function('View', 'div', 'spaces', 'run', `${source}; return HarnessAuto;`)(
    class {}, () => ({ size() {} }), () => space ? [space] : [], (...args) => calls.push(args));
  const view = new Auto();
  view.render(); view.render();
  space = { ...space, id: 'two', name: 'herdr-harness' }; view.render(); view.render();
  assert.deepEqual(calls, [
    ['layout.show', { id: 'harness' }], ['layout.show', { id: 'harness' }],
  ]);
  space = null; view.render();
  assert.deepEqual(calls.at(-1), ['layout.hide', { id: 'harness' }]);
});
