import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 준비·설치 병목을 단계별로 나눠 재기 위한 공통 기록 규약. 저장소 어댑터도 같은 필드로 남긴다.
// 기록은 종류별 JSONL 한 줄씩 덧붙인다. 시험 격리에만 HERDR_METRICS_DIR를 쓴다.
export const metricsRoot = (env = process.env) => env.HERDR_METRICS_DIR ?? join(env.LOCALAPPDATA ?? tmpdir(), 'HerdrHarness', 'metrics');

const ms = (v) => Number.isInteger(v) && v >= 0;
const text = (v) => typeof v === 'string' && v.length > 0;
const code = (v) => v === null || Number.isInteger(v);
const optional = (check) => (v) => v === undefined || check(v);
const oneOf = (...values) => (v) => values.includes(v);
// 지표에는 명령 원문 대신 작업 이름만 남긴다. 정규식으로는 하위 명령과 인자 값을 구별할 수 없으므로,
// 하위 명령은 아래에 등록한 조합만 붙이고 그 밖에는 실행 파일 이름만 쓴다.
export const KNOWN_LABELS = new Set([
  'pnpm verify', 'pnpm test', 'pnpm build', 'pnpm lint', 'pnpm typecheck', 'pnpm install', 'pnpm run build', 'pnpm run test',
  'npm test', 'npm run build', 'npm run test', 'npx vitest', 'npx vitest run', 'vitest run',
  'cargo test', 'cargo clippy', 'cargo build', 'cargo check', 'cargo nextest run',
  'bun install', 'bun test', 'bun run build', 'bun run docs:build', 'next build',
]);
const PROGRAM = /^[A-Za-z0-9._-]+$/;
const label = (v) => typeof v === 'string' && (KNOWN_LABELS.has(v) || PROGRAM.test(v));

// 명령 원문에서 작업 이름을 만든다. 앞쪽 환경변수 지정과 실행 파일 경로·확장자를 버리고,
// 등록된 하위 명령 조합 중 가장 긴 것만 붙인다. 원문의 다른 단어는 복사하지 않는다.
export function commandLabel(command) {
  // 지원하는 단순 명령 문법만 해석한다. 단어 구분은 셸과 같은 공백·탭뿐이며, 그 밖의 공백 문자(줄 바꿈 없는 공백 등)가 있으면
  // 셸과 다르게 나눠 값 일부가 남을 수 있으므로 unknown이다.
  const source = String(command);
  if (/[^\S \t]/.test(source)) return 'unknown';
  let rest0 = source.trim();
  // 앞쪽 환경변수 할당은 값이 단순한 문자(영숫자 . _ : / -, 빈 값)로만 이뤄져 경계가 확실할 때만 건너뛴다.
  // 따옴표·이스케이프·치환·붙은 리디렉션(MODE=ci>out.log) 등 그 밖의 문법은 값이나 경로가 이름으로 남지 않게 unknown이다.
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest0)) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9._:/-]*(?:[ \t]+|$)/.exec(rest0);
    if (!assignment) return 'unknown';
    rest0 = rest0.slice(assignment[0].length);
  }
  // 공백이 든 실행 파일 경로는 따옴표로 감싸 온다.
  const quoted = /^(["'])(.*?)\1(?:[ \t]+|$)/.exec(rest0);
  const head = quoted ? quoted[2] : rest0.split(/[ \t]+/)[0];
  // 실행 파일 자리에 리디렉션·셸 연산자가 오면 경로 basename을 뽑기 전에 멈춘다(예: ">logs\out.log echo ok").
  if (/[<>|&;()^%!*?`$"']/.test(head)) return 'unknown';
  const words = (quoted ? rest0.slice(quoted[0].length) : rest0.slice(head.length)).trim().split(/[ \t]+/).filter(Boolean);
  const program = head.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  if (!PROGRAM.test(program)) return 'unknown';
  for (let n = Math.min(3, words.length); n > 0; n--) {
    const candidate = [program, ...words.slice(0, n)].join(' ');
    if (KNOWN_LABELS.has(candidate)) return candidate;
  }
  return program;
}

// 공통 런처·heavy 실행기가 기록하는 종류와, 어댑터가 실제 설치·첫 검사를 호출하며 기록하는 종류다.
// import 방식은 관측한 경우에만 적고, 모르면 unknown으로 둔다.
export const KINDS = {
  preparation: { project: text, command: label, acquired: (v) => typeof v === 'boolean', wait_ms: ms, run_ms: ms, exit: code },
  heavy: { cwd: text, label, slot: ms, wait_ms: ms, run_ms: ms, exit: code },
  'deps-install': { project: text, task: optional(text), worktree: text, trigger: oneOf('first-use', 'stamp-mismatch', 'forced'),
    install_ms: ms, import_method: oneOf('hardlink', 'clone', 'copy', 'unknown'), store_dir: optional(text), result: oneOf('ok', 'failed', 'timeout'),
    error_code: (value, row) => value === undefined || (row.result !== 'ok' && typeof value === 'string' && /^E[A-Z0-9_]{1,40}$/.test(value)) },
  'first-check': { project: text, task: optional(text), worktree: text, label, run_ms: ms, result: oneOf('ok', 'failed', 'timeout') },
};

export function metricRecord(kind, data, now = new Date()) {
  const spec = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
  if (!spec) throw new Error(`알 수 없는 계측 종류: ${kind}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('계측 값은 객체여야 한다.');
  const extra = Object.keys(data).filter((k) => !Object.hasOwn(spec, k));
  if (extra.length) throw new Error(`${kind} 계측에 정의되지 않은 필드: ${extra.join(', ')}`);
  const bad = Object.entries(spec).filter(([k, check]) => !check(data[k], data)).map(([k]) => k);
  if (bad.length) throw new Error(`${kind} 계측 필드가 올바르지 않다: ${bad.join(', ')}`);
  return { v: 1, kind, at: now.toISOString(), pid: process.pid, ...data };
}

export function recordMetric(kind, data, { dir = metricsRoot() } = {}) {
  const record = metricRecord(kind, data);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${kind}.jsonl`), JSON.stringify(record) + '\n');
  return record;
}

// 실행 경로에서 쓰는 기록. 기록 실패가 준비·시험 명령의 결과를 바꾸지 않게 경고만 남긴다.
export function tryRecordMetric(kind, data, options) {
  try { return recordMetric(kind, data, options); }
  catch (e) { console.error(`[metrics] 기록 실패(${kind}): ${e.message}`); return null; }
}
