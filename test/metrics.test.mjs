import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { metricRecord, recordMetric, tryRecordMetric, commandLabel } from '../core/metrics.mjs';
import { run } from '../core/process.js';

const cli = fileURLToPath(new URL('../bin/metric.mjs', import.meta.url));
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'herdr-metrics-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const install = { project: 'sw', task: 'SW-0121', worktree: 'E:/repositories/sw/.claude/worktrees/x', trigger: 'first-use', install_ms: 2600, import_method: 'hardlink', result: 'ok' };

test('종류별 규약 필드만 받고 공통 머리말을 붙인다', () => {
  const r = metricRecord('deps-install', install, new Date('2026-11-18T00:00:00Z'));
  assert.deepEqual([r.v, r.kind, r.at, r.pid], [1, 'deps-install', '2026-11-18T00:00:00.000Z', process.pid]);
  assert.equal(metricRecord('deps-install', { ...install, task: undefined, import_method: 'unknown' }).import_method, 'unknown');
  assert.throws(() => metricRecord('nope', {}), /알 수 없는 계측 종류/);
  assert.throws(() => metricRecord('deps-install', [install]), /객체/);
  assert.throws(() => metricRecord('deps-install', { ...install, note: 'x' }), /정의되지 않은 필드: note/);
  assert.throws(() => metricRecord('deps-install', { ...install, import_method: 'symlink' }), /import_method/);
  assert.throws(() => metricRecord('deps-install', { ...install, install_ms: -1 }), /install_ms/);
  const prep = { project: 'p', command: 'dispatch', acquired: false, wait_ms: 0, run_ms: 0, exit: null };
  assert.throws(() => metricRecord('preparation', { ...prep, wait_ms: 1.5 }), /wait_ms/);
  assert.throws(() => metricRecord('preparation', { ...prep, acquired: 'no' }), /acquired/);
  assert.equal(metricRecord('preparation', prep).exit, null);
  const heavy = { cwd: 'c', label: 'cargo test', slot: 0, wait_ms: 0, run_ms: 0, exit: 0 };
  assert.equal(metricRecord('heavy', heavy).slot, 0);
  assert.throws(() => metricRecord('heavy', { ...heavy, slot: -1 }), /slot/);
});

test('설치 오류 코드는 실패·시간 초과에서만 선택할 수 있고 원문과 경로를 거부한다', () => {
  const failed = { ...install, result: 'failed' };
  assert.equal(metricRecord('deps-install', { ...failed, error_code: 'ENAMETOOLONG' }).error_code, 'ENAMETOOLONG');
  assert.equal(metricRecord('deps-install', { ...install, result: 'timeout', error_code: 'ETIMEDOUT' }).error_code, 'ETIMEDOUT');
  for (const value of ['E1', 'ERR_PNPM_FETCH_404', 'E' + 'X'.repeat(40)])
    assert.equal(metricRecord('deps-install', { ...failed, error_code: value }).error_code, value);
  for (const value of [null, 127, 'E', 'E' + 'X'.repeat(41), 'enametoolong', 'ENOENT\n', 'ENOENT: file missing', 'E:/tmp/path'])
    assert.throws(() => metricRecord('deps-install', { ...failed, error_code: value }), /error_code/);
  assert.throws(() => metricRecord('deps-install', { ...install, error_code: 'ENAMETOOLONG' }), /error_code/);
});

test('상속된 속성은 종류나 필드로 받지 않는다', () => {
  for (const kind of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) assert.throws(() => metricRecord(kind, {}), /알 수 없는 계측 종류/);
  for (const field of ['toString', 'constructor', 'valueOf']) assert.throws(() => metricRecord('deps-install', { ...install, [field]: 'x' }), new RegExp(`정의되지 않은 필드: ${field}`));
});

test('지표에는 명령 원문 대신 인자·값을 뺀 작업 이름만 남긴다', () => {
  const cases = {
    'pnpm verify': 'pnpm verify',
    'cargo test --workspace': 'cargo test',
    'bun run docs:build --filter x': 'bun run docs:build',
    'bun install --frozen-lockfile': 'bun install',
    'npx vitest run src/a.test.ts': 'npx vitest run',
    'node -e "process.exit(3)"': 'node',
    'TOKEN=secret API_KEY=x pnpm publish --otp 123': 'pnpm',
    'echo ReviewCanary': 'echo',
    'FOO=1 BAR=x pnpm verify': 'pnpm verify',
    'GIT_AUTHOR_NAME="First Middle Last" pnpm verify': 'unknown',
    "BUILD_MESSAGE='first middle last' cargo test": 'unknown',
    'FOO=bar\\ Middle pnpm verify': 'unknown',
    'FOO=$HOME pnpm verify': 'unknown',
    'FOO=': 'unknown',
    'MODE=ci> reports/build-summary.log echo ok': 'unknown',
    'MODE=ci>reports/build-summary.log pnpm verify': 'unknown',
    'A=b|c pnpm verify': 'unknown',
    'A=b&&c pnpm verify': 'unknown',
    'CARGO_TARGET_DIR=C:/t/x RUST_LOG=info cargo test': 'cargo test',
    'EMPTY= pnpm verify': 'pnpm verify',
    '>reports\\ReviewOutput.log echo ok': 'unknown',
    '2>err.log pnpm verify': 'unknown',
    '<in.txt sort': 'unknown',
    'GIT_AUTHOR_NAME=First\u00a0Middle\u00a0Last echo ok': 'unknown',
    'pnpm\u3000verify': 'unknown',
    'pnpm verify\nrm x': 'unknown',
    '"C:\\Users\\이진영\\AppData\\node.exe" x.mjs': 'node',
    'echo ok': 'echo',
    'pnpm verify ReviewCanary': 'pnpm verify',
    '"C:\\Program Files\\nodejs\\node.exe" script.js': 'node',
    '"C:\\Program Files\\nodejs\\node.exe" scripts/run.mjs --all': 'node',
    'C:/tools/cargo.exe clippy -- -D warnings': 'cargo clippy',
    'curl https://user:pw@example.com': 'curl',
    '': 'unknown',
  };
  for (const [command, expected] of Object.entries(cases)) assert.equal(commandLabel(command), expected, command);
  const check = { project: 'sw', worktree: 'w', label: 'pnpm verify', run_ms: 1, result: 'ok' };
  assert.equal(metricRecord('first-check', check).label, 'pnpm verify');
  assert.equal(metricRecord('first-check', { ...check, label: 'node' }).label, 'node');
  for (const bad of ['pnpm verify --changed', 'pnpm verify a b c', 'FOO=1 pnpm', 'node -e x', '', 'echo ReviewCanary', 'pnpm publish']) assert.throws(() => metricRecord('first-check', { ...check, label: bad }), /label/, bad);
});

test('종류별 JSONL에 덧붙이고 실행 경로의 기록 실패는 결과를 바꾸지 않는다', (t) => {
  const dir = temp(t);
  recordMetric('first-check', { project: 'sw', worktree: 'w', label: 'pnpm verify', run_ms: 10, result: 'ok' }, { dir });
  recordMetric('first-check', { project: 'sw', worktree: 'w', label: 'pnpm verify', run_ms: 20, result: 'failed' }, { dir });
  assert.deepEqual(readFileSync(join(dir, 'first-check.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).run_ms), [10, 20]);
  const errors = []; t.mock.method(console, 'error', (m) => errors.push(m));
  assert.equal(tryRecordMetric('heavy', { cwd: 'x' }, { dir }), null);
  assert.match(errors[0], /\[metrics\] 기록 실패\(heavy\)/);
  assert.equal(existsSync(join(dir, 'heavy.jsonl')), false);
});

test('어댑터용 CLI는 검증한 기록만 남기고 잘못된 입력은 2로 알린다', (t) => {
  const dir = temp(t), env = { ...process.env, HERDR_METRICS_DIR: dir };
  const ok = run(process.execPath, [cli, 'deps-install', JSON.stringify(install)], { env });
  assert.equal(ok.code, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).install_ms, 2600);
  assert.equal(JSON.parse(readFileSync(join(dir, 'deps-install.jsonl'), 'utf8')).task, 'SW-0121');
  for (const args of [[], ['deps-install'], ['deps-install', '{'], ['deps-install', JSON.stringify({ ...install, result: 'maybe' })],
    ['deps-install', JSON.stringify({ ...install, toString: 'x' })], ['toString', '{}'], ['constructor', '{}']]) {
    const r = run(process.execPath, [cli, ...args], { env });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}`);
  }
  assert.equal(readFileSync(join(dir, 'deps-install.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(readdirSync(dir), ['deps-install.jsonl']);
});
