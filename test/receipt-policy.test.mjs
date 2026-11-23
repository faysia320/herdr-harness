import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const contract = createRequire(import.meta.url)('../core/qa-receipt-policy.cjs');
const { validatePolicy, loadPolicy, requiredPairs, tapSummary, tapPassed, encodeEnvelope, decodeEnvelope, verifyResults } = contract;

const image = 'docker.io/library/node@sha256:' + 'a'.repeat(64);
const steps = [['node', 'scripts/build.mjs'], ['node', '--test', '--test-reporter=tap', 'test/*.test.mjs']];
const policy = () => ({ version: 1, output: 'target/hh-verify/receipts', exempt_pr_max: 7,
  platforms: { windows: { runner: 'host' }, linux: { runner: 'docker', image } },
  checks: { suite: { result: 'tap', steps }, docs: { result: 'exit', steps: [['node', 'scripts/docs.mjs']] } },
  required: [{ checks: ['suite'], platforms: ['windows', 'linux'] }, { paths: ['docs/', 'README.md'], checks: ['docs'], platforms: ['windows'] }] });
const passed = (platform, check, extra = {}) => ({ platform, check, steps: policy().checks[check].steps, state: 'passed', exit: 0,
  ...(check === 'suite' ? { tests: 12, pass: 12, fail: 0, cancelled: 0, skipped: 0, todo: 0 } : {}), ...extra });
const receipt = (results, environments) => ({ kind: 'herdr-qa-receipt', version: 2, results, environments: environments ?? {
  windows: { os: 'windows', node: 'v24.11.1', git: '2.53.0' }, linux: { os: 'linux', node: 'v22.23.5', git: '2.39.5', image } } });

test('HH 저장소 정책은 Windows 호스트와 digest 고정 Docker Linux에서 hh-suite를 기본 필수로 요구한다', () => {
  const hh = loadPolicy(new URL('../policy/qa-receipt.json', import.meta.url));
  assert.deepEqual(requiredPairs(hh, ['README.md']), [{ platform: 'windows', check: 'hh-suite' }, { platform: 'linux', check: 'hh-suite' }]);
  assert.match(hh.platforms.linux.image, /@sha256:[0-9a-f]{64}$/);
  assert.equal(hh.output, 'target/hh-verify/receipts');
  assert.throws(() => loadPolicy(new URL('./missing-qa-receipt.json', import.meta.url)), /정책을 읽을 수 없다/);
});

test('정책 검증: 기본 규칙·선언된 ID·셸 특수문자 없는 명령·digest 고정 이미지만 받는다', () => {
  assert.equal(validatePolicy(policy()).version, 1);
  const broken = [
    p => { p.version = 2; },
    p => { p.output = '../out'; },
    p => { p.output = '/abs'; },
    p => { p.exempt_pr_max = -1; },
    p => { p.platforms = {}; },
    p => { p.platforms.linux.image = 'node:22-bookworm'; },
    p => { p.platforms.freebsd = { runner: 'host' }; },
    p => { p.platforms.windows = { runner: 'docker', image }; },
    p => { p.checks.suite.result = 'junit'; },
    p => { p.checks.suite.steps = []; },
    p => { p.checks.suite.steps = [['node', 'a.mjs', '&&', 'rm', '-rf', 'x']]; },
    p => { p.checks.suite.steps = [['node', '$(whoami)']]; },
    p => { p.checks.suite.steps = [['node', 'two words']]; },
    p => { p.required = [p.required[1]]; },
    p => { p.required[0].checks = ['missing']; },
    p => { p.required[0].platforms = ['windows', 'windows']; },
    p => { p.required[1].paths = ['../docs/']; },
    p => { p.required[1].paths = []; },
    p => { p.required[0].anyPlatform = 'yes'; },
    p => { p.required[0].anyPlatform = 1; },
  ];
  for (const change of broken) {
    const p = policy();
    change(p);
    assert.throws(() => validatePolicy(p), /정책 오류/, change.toString());
  }
});

test('변경 경로 규칙: 기본 규칙과 걸린 경로 규칙의 합집합, 폴더 경계·삭제 경로를 구분한다', () => {
  const p = policy();
  const base = [{ platform: 'windows', check: 'suite' }, { platform: 'linux', check: 'suite' }];
  assert.deepEqual(requiredPairs(p, ['core/a.cjs']), base);
  assert.deepEqual(requiredPairs(p, ['docsite/a.md', 'README.md.bak']), base);
  const docs = [{ platform: 'windows', check: 'suite' }, { platform: 'windows', check: 'docs' }, { platform: 'linux', check: 'suite' }];
  assert.deepEqual(requiredPairs(p, ['docs/guide/a.md']), docs);
  // 삭제·이동 원래 경로도 변경 행에 있으므로 같은 규칙이 걸린다.
  assert.deepEqual(requiredPairs(p, ['README.md']), docs);
  p.required.push({ paths: ['docs/'], checks: ['suite', 'docs'], platforms: ['linux'] });
  assert.deepEqual(requiredPairs(p, ['docs/a.md']), [...docs, { platform: 'linux', check: 'docs' }]);
});

test('TAP 요약: 양수 전체 통과만 통과로 보고 잘린 출력·실패·건너뜀을 거부한다', () => {
  const tap = '\nTAP version 13\n# tests 3\n# suites 1\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 12.5\n';
  assert.deepEqual(tapSummary(tap.replaceAll('\n', '\r\n')), { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, durationMs: 12.5 });
  assert.equal(tapPassed(tapSummary(tap)), true);
  for (const output of [tap.replace('# fail 0', '# fail 1').replace('# pass 3', '# pass 2'), tap.replace('# skipped 0', '# skipped 1'),
    tap.replace('# tests 3', '# tests 0').replace('# pass 3', '# pass 0'), tap.replace('# todo 0', '# todo 2')]) assert.equal(tapPassed(tapSummary(output)), false);
  for (const output of [tap.replace('# duration_ms 12.5\n', ''), 'build only\n', tap + 'ok 4 - late output\n', null]) assert.equal(tapSummary(output), null);
});

test('검사 목록 대조: 정책이 요구한 OS×검사가 정확히 한 번 정책 명령으로 통과해야 한다', () => {
  const p = policy();
  const all = [passed('windows', 'suite'), passed('linux', 'suite')];
  assert.deepEqual(verifyResults(receipt(all), p, ['core/a.cjs']), []);
  const rejected = [
    [[passed('windows', 'suite')], /필수 검사 결과 없음: linux\/suite/],
    [[...all, passed('linux', 'suite')], /검사 결과 중복: linux\/suite/],
    [[all[0], passed('linux', 'suite', { state: 'failed', exit: 1 })], /통과하지 않은 검사: linux\/suite/],
    [[all[0], passed('linux', 'suite', { steps: [['node', '--test', 'test/one.test.mjs']] })], /정책과 다른 명령: linux\/suite/],
    [[all[0], passed('linux', 'suite', { tests: 0, pass: 0 })], /시험 수·실패/],
    [[all[0], passed('linux', 'suite', { skipped: 1, pass: 11 })], /시험 수·실패/],
    [[all[0], passed('linux', 'suite', { fail: undefined })], /시험 수·실패/],
  ];
  for (const [results, pattern] of rejected) assert.match(verifyResults(receipt(results), p, ['core/a.cjs']).join('\n'), pattern);
  // 다른 OS 결과를 복사해도 실행 환경 기록이 없거나 이미지가 다르면 거부한다.
  assert.match(verifyResults(receipt(all, { windows: receipt([]).environments.windows }), p, ['a']).join('\n'), /실행 환경 기록 없음·불일치: linux/);
  assert.match(verifyResults(receipt(all, { ...receipt([]).environments, linux: { ...receipt([]).environments.linux, image: 'node@sha256:' + 'b'.repeat(64) } }), p, ['a']).join('\n'), /linux/);
  // 경로 규칙이 요구한 검사가 빠지면 거부하고, 넣으면 통과한다.
  assert.match(verifyResults(receipt(all), p, ['docs/a.md']).join('\n'), /필수 검사 결과 없음: windows\/docs/);
  assert.deepEqual(verifyResults(receipt([...all, passed('windows', 'docs')]), p, ['docs/a.md']), []);
});

test('OR 규칙(anyPlatform): 나열한 플랫폼 하나에서 규칙의 검사 전부가 통과하면 되고, 누락·나눠 통과·잘못된 환경은 거부한다', () => {
  const p = policy();
  p.checks.lint = { result: 'exit', steps: [['node', 'lint.mjs']] };
  p.required = [{ checks: ['suite', 'lint'], platforms: ['windows', 'linux'], anyPlatform: true }];
  assert.equal(validatePolicy(p).required[0].anyPlatform, true);
  const lint = platform => ({ platform, check: 'lint', steps: [['node', 'lint.mjs']], state: 'passed', exit: 0 });
  // 기본 pick은 AND와 같은 상한(나열한 모든 플랫폼)이고, 발급기는 pick으로 하나를 고른다.
  assert.equal(requiredPairs(p, ['a']).length, 4);
  assert.deepEqual(requiredPairs(p, ['a'], rule => rule.anyPlatform ? ['linux'] : rule.platforms), [{ platform: 'linux', check: 'suite' }, { platform: 'linux', check: 'lint' }]);
  for (const os of ['windows', 'linux']) {
    assert.deepEqual(verifyResults(receipt([passed(os, 'suite'), lint(os)]), p, ['a']), [], os);
    // 실행하지 않은 다른 플랫폼의 환경 기록이 없어도 된다.
    assert.deepEqual(verifyResults(receipt([passed(os, 'suite'), lint(os)], { [os]: receipt([]).environments[os] }), p, ['a']), [], os);
  }
  assert.deepEqual(verifyResults(receipt([passed('windows', 'suite'), lint('windows'), passed('linux', 'suite')]), p, ['a']), []);
  const rejected = [
    [[], /플랫폼 하나\(windows\|linux\)에서 suite·lint 통과 필요: .*필수 검사 결과 없음: windows\/suite/],
    [[passed('windows', 'suite')], /필수 검사 결과 없음: windows\/lint/],
    [[passed('windows', 'suite'), lint('linux')], /플랫폼 하나/],
    [[passed('linux', 'suite', { state: 'failed', exit: 1 }), lint('linux')], /통과하지 않은 검사: linux\/suite/],
  ];
  for (const [results, pattern] of rejected) assert.match(verifyResults(receipt(results), p, ['a']).join('\n'), pattern);
  assert.match(verifyResults(receipt([passed('linux', 'suite'), lint('linux')], { windows: receipt([]).environments.windows }), p, ['a']).join('\n'), /실행 환경 기록 없음·불일치: linux/);
  // 걸린 AND 규칙은 OR 규칙과 별도로 모두 충족해야 한다.
  p.required.push({ paths: ['docs/'], checks: ['lint'], platforms: ['windows', 'linux'] });
  assert.deepEqual(verifyResults(receipt([passed('linux', 'suite'), lint('linux')]), p, ['a']), []);
  assert.match(verifyResults(receipt([passed('linux', 'suite'), lint('linux')]), p, ['docs/a.md']).join('\n'), /필수 검사 결과 없음: windows\/lint/);
  assert.deepEqual(verifyResults(receipt([passed('linux', 'suite'), lint('linux'), lint('windows')]), p, ['docs/a.md']), []);
});

test('PR 본문 봉투: 한 줄 주석으로 왕복하고 없음·중복·형식 변경·잘림을 구별한다', () => {
  const value = { kind: 'herdr-qa-receipt', version: 2, run: 'r1', note: '한글 값' };
  const line = encodeEnvelope(value);
  assert.match(line, /^<!-- herdr-qa-receipt:v2 [A-Za-z0-9_-]+ -->$/);
  assert.deepEqual(decodeEnvelope(`## 남은 검증\r\n- [ ] item\r\n\r\n${line}\r\n`), value);
  assert.throws(() => decodeEnvelope('## 검증\n- 없음'), /영수증\(herdr-qa-receipt:v2\)이 없다/);
  assert.throws(() => decodeEnvelope(null), /없다/);
  assert.throws(() => decodeEnvelope(`${line}\n${line}`), /여러 개/);
  assert.throws(() => decodeEnvelope('    ' + line), /형식이 다르다/);
  assert.throws(() => decodeEnvelope(line.replace(' -->', '')), /형식이 다르다/);
  assert.throws(() => decodeEnvelope(line.slice(0, 40) + ' -->'), /해독할 수 없다/);
});
