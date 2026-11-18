#!/usr/bin/env node
import { createRequire } from 'node:module';
import { runTree } from '../core/process.js';
import { needsPreparation, preparationStatus, withPreparation } from '../core/preparation.mjs';
import { tryRecordMetric } from '../core/metrics.mjs';
const { binding } = createRequire(import.meta.url)('../adapters/runtime.cjs');
const controller = new AbortController(), stop = () => controller.abort();
const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
for (const signal of signals) process.on(signal, stop);
try {
  const [flag, file, ...args] = process.argv.slice(2);
  if (flag !== '--binding' || !file || !args.length) throw new Error('사용법: node bin/harness.mjs --binding 로컬연결.json <기존 CLI 명령>');
  const b = binding(file);
  if (!Array.isArray(b.command) || !b.command.length || !b.cwd) throw new Error('adapter 실행 설정이 없다.');
  if (b.timeout !== undefined && !(Number.isInteger(b.timeout) && b.timeout > 0 && b.timeout <= 2147483647)) throw new Error('연결 설정의 timeout은 1~2147483647 범위의 정수(ms)여야 한다.');
  if (args[0] === 'preparation-status') console.log(JSON.stringify(preparationStatus(), null, 2));
  else {
    const execute = () => {
      if (JSON.stringify(binding(file)) !== JSON.stringify(b)) throw new Error('준비 대기 중 연결 설정이 바뀌었다. 새 binding의 launcher로 다시 실행한다.');
      // 순서 대기에는 실행 한도를 소비하지 않는다. 조회·결정 명령은 준비 슬롯을 잡지 않는다.
      return runTree(b.command[0], [...b.command.slice(1), ...args], { cwd: b.cwd, timeout: b.timeout ?? 600000, signal: controller.signal });
    };
    let r, timing;
    try {
      r = needsPreparation(args)
        ? await withPreparation({ project: b.project, cwd: b.cwd, command: args[0] }, execute, { signal: controller.signal, onTiming: (t) => { timing = t; } })
        : await execute();
    } finally {
      // 순서 대기와 슬롯 점유를 나눠 남긴다. 결과 없이 끝나면 취소는 130, 그 밖의 예외는 null이다.
      if (timing) tryRecordMetric('preparation', { project: String(b.project ?? 'unknown'), command: args[0], ...timing, exit: r?.code ?? (controller.signal.aborted ? 130 : null) });
    }
    process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.code;
  }
} catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = e.name === 'AbortError' ? 130 : 2; }
finally { for (const signal of signals) process.removeListener(signal, stop); }
