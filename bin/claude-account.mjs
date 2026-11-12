#!/usr/bin/env node
// Read-only usage display. Authentication is managed directly by Claude CLI.
import { status, codexUsage } from '../core/claude-accounts.mjs';
try {
  const [cmd] = process.argv.slice(2);
  const out = cmd === 'status' ? status() : cmd === 'codex' ? codexUsage()
    : (() => { throw new Error('사용법: status | codex. 계정 변경은 Claude의 /login을 사용하세요.'); })();
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
