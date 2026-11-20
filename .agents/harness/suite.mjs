import { createRequire } from 'node:module';
import { join } from 'node:path';

const { tapSummary, tapPassed } = createRequire(import.meta.url)('../../core/qa-receipt-policy.cjs');

const suiteCommand = ['node', 'scripts/build.mjs', '&&', 'node', '--test', '--test-reporter=tap',
  'test/*.test.mjs', 'mod/harness/*.test.mjs'];
export const suiteInvocation = ctx => [process.execPath, join(ctx.binding.release, 'bin/heavy.mjs'), '--', ...suiteCommand];

export function suiteEnvironment(env) {
  // Node의 시험 worker 표지를 상속하면 하위 node --test가 시험 없이 성공할 수 있다.
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));
}

// QA 실행 영수증 v2와 같은 TAP 요약 판정이다. 양수의 전체 통과이고 실패·취소·건너뜀·todo가 0일 때만 건수를 돌려준다.
export function suiteTestCount(stdout) {
  const summary = tapSummary(stdout);
  if (tapPassed(summary)) return summary.tests;
}
