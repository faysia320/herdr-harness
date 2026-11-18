import { recordMetric } from '../core/metrics.mjs';

// 사용법: node metric.mjs <종류> '<JSON>'  (어댑터가 실제 설치·첫 검사 시간을 공통 규약으로 남긴다)
const [kind, raw] = process.argv.slice(2);
try {
  if (!kind || !raw) throw new Error("사용법: node metric.mjs <preparation|heavy|deps-install|first-check> '<JSON>'");
  console.log(JSON.stringify(recordMetric(kind, JSON.parse(raw))));
} catch (e) { console.error(e.message); process.exitCode = 2; }
