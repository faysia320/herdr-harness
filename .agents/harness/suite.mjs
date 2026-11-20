import { join } from 'node:path';

const suiteCommand = ['node', 'scripts/build.mjs', '&&', 'node', '--test', '--test-reporter=tap',
  'test/*.test.mjs', 'mod/harness/*.test.mjs'];
export const suiteInvocation = ctx => [process.execPath, join(ctx.binding.release, 'bin/heavy.mjs'), '--', ...suiteCommand];

export function suiteEnvironment(env) {
  // Node의 시험 worker 표지를 상속하면 하위 node --test가 시험 없이 성공할 수 있다.
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));
}

export function suiteTestCount(stdout) {
  if (!/(?:^|\r?\n)TAP version 13\r?\n/.test(stdout)) return;
  const summary = /(?:^|\r?\n)# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail 0\r?\n# cancelled 0\r?\n# skipped 0\r?\n# todo 0\r?\n# duration_ms \d+(?:\.\d+)?(?:\r?\n)*$/.exec(stdout);
  if (!summary) return;
  const tests = Number(summary[1]);
  if (Number.isSafeInteger(tests) && tests > 0 && tests === Number(summary[2])) return tests;
}
