#!/usr/bin/env node
// 사용법:
//   node bin/claude-account.mjs status
//   node bin/claude-account.mjs setup <키> [폴더] [표시 이름]   예: setup b
//   node bin/claude-account.mjs use <키>                       a는 기본 계정(~/.claude)
//   node bin/claude-account.mjs resume <터미널>                 한도로 멈춘 Claude 터미널을 현재 계정으로 이어 실행
//   node bin/claude-account.mjs scan                           한도로 멈춘 Claude 터미널 목록
import { status, setup, use, resumeTerminal, scan } from '../core/claude-accounts.mjs';
try {
  const [cmd, ...args] = process.argv.slice(2);
  const out = cmd === 'status' ? status() : cmd === 'setup' ? setup(...args) : cmd === 'use' ? use(args[0]) : cmd === 'resume' ? resumeTerminal(args[0], args[1])
    : cmd === 'scan' ? scan() : (() => { throw new Error('사용법: status | setup <키> [폴더] [이름] | use <키> | resume <터미널> | scan'); })();
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
