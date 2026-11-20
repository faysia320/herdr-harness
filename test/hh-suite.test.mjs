import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { suiteEnvironment, suiteInvocation, suiteTestCount } from '../.agents/harness/suite.mjs';
import { createRequire } from 'node:module';

test('HH suite executes actual tests when started inside a Node test worker', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-suite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'probe.test.mjs');
  writeFileSync(file, "import test from 'node:test'; import assert from 'node:assert/strict';\n" +
    "test('run this probe', () => assert.equal(process.env.HH_SUITE_FIXTURE, 'preserved'));\n");
  const inherited = { ...process.env, NODE_TEST_CONTEXT: 'child-v8', HH_SUITE_FIXTURE: 'preserved' };
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
    cwd: dir, env: suiteEnvironment(inherited), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(suiteTestCount(result.stdout), 1);
  assert.equal(inherited.NODE_TEST_CONTEXT, 'child-v8');
  assert.equal(suiteEnvironment({ node_test_context: 'child-v8' }).node_test_context, undefined);
});

test('HH suite rejects zero, missing, incomplete or skipped test results', () => {
  const summary = '\nTAP version 13\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n' +
    '# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.25\n';
  assert.equal(suiteTestCount(summary.replaceAll('\n', '\r\n')), 1);
  for (const output of [
    summary.replace('# tests 1', '# tests 0').replace('# pass 1', '# pass 0'),
    'build complete\n',
    summary.replace('# duration_ms 1.25\n', ''),
    summary.replace('# skipped 0', '# skipped 1'),
    summary.replace('# pass 1', '# pass 0'),
  ]) assert.equal(suiteTestCount(output), undefined);
});

test('HH QA runner의 Windows hh-suite 명령은 저장소 QA 영수증 정책의 명령과 같다', async () => {
  const { heavyArgv } = await import('../core/qa-receipt-runner.mjs');
  const { loadPolicy } = createRequire(import.meta.url)('../core/qa-receipt-policy.cjs');
  const policy = loadPolicy(new URL('../policy/qa-receipt.json', import.meta.url));
  const release = join(tmpdir(), 'pinned-release');
  // verify.mjs는 같은 엔진의 Windows 결과로 기존 hh-suite.log를 쓰고, 수집기는 이 argv를 대조한다.
  assert.deepEqual(heavyArgv(join(release, 'bin/heavy.mjs'), policy.checks['hh-suite'].steps), suiteInvocation({ binding: { release } }));
});
