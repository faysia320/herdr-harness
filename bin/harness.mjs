#!/usr/bin/env node
import { createRequire } from 'node:module';
import { run } from '../core/process.js';
const { binding } = createRequire(import.meta.url)('../adapters/runtime.cjs');
try {
  const [flag, file, ...args] = process.argv.slice(2);
  if (flag !== '--binding' || !file || !args.length) throw new Error('사용법: node bin/harness.mjs --binding 로컬연결.json <기존 CLI 명령>');
  const b = binding(file);
  if (!Array.isArray(b.command) || !b.command.length || !b.cwd) throw new Error('adapter 실행 설정이 없다.');
  const r = run(b.command[0], [...b.command.slice(1), ...args], { cwd: b.cwd, timeout: b.timeout ?? 600000 });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.code;
} catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
