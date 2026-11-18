import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from '../scripts/build.mjs';

test('CRLF checkout은 LF와 동일한 릴리스를 만들고 미커밋 소스 변경은 지문에 반영한다', t => {
  const baseline = build(), root = mkdtempSync(join(tmpdir(), 'herdr-build-eol-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(baseline.release, root, { recursive: true });
  mkdirSync(join(root, 'scripts'));
  cpSync(new URL('../scripts/build.mjs', import.meta.url), join(root, 'scripts/build.mjs'));
  const runBuild = () => JSON.parse(execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' }));
  const files = ['bin/claude-account.mjs', 'core/decisions.js', 'adapters/runtime.cjs', 'policy/execution.json'];
  for (const file of files) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n'));
  }
  const result = runBuild();
  assert.equal(result.manifestHash, baseline.manifestHash);
  for (const file of [...files, 'mod/harness/decisions.js']) {
    assert.ok(readFileSync(join(root, file)).includes('\r\n'));
    assert.deepEqual(readFileSync(join(result.release, file)), readFileSync(join(baseline.release, file)));
  }
  const file = join(root, files[0]);
  writeFileSync(file, readFileSync(file, 'utf8') + '// 수정된 후보\r\n');
  const edited = runBuild();
  assert.notEqual(edited.manifestHash, baseline.manifestHash);
  assert.match(readFileSync(join(edited.release, files[0]), 'utf8'), /수정된 후보\n$/);
});
