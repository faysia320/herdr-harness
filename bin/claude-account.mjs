#!/usr/bin/env node
// 사용법:
//   node bin/claude-account.mjs status
// 토큰 등록: powershell -File bin/claude-token-import.ps1 -Key b
//   node bin/claude-account.mjs use <키>                       다음 실행에 사용할 장기 토큰 선택
//   node bin/claude-account.mjs resume <터미널>                 한도로 멈춘 Claude 터미널을 현재 계정으로 이어 실행
//   node bin/claude-account.mjs scan                           한도로 멈춘 Claude 터미널 목록
//   node bin/claude-account.mjs codex                          Codex 최근 세션 기록의 사용량(보기 전용)
//   node bin/claude-account.mjs leads                          하네스 레포별 Lead와 그 Lead가 쓰는 계정
//   node bin/claude-account.mjs switch-lead <터미널>            Lead를 같은 터미널·같은 대화로 현재 계정에서 다시 띄움
import { status, use, resumeTerminal, scan, sessions, leads, switchLead, codexUsage } from '../core/claude-accounts.mjs';
import { registerToken } from '../core/claude-tokens.mjs';
try {
  const [cmd, ...args] = process.argv.slice(2);
  const out = cmd === 'status' ? status() : cmd === 'register' ? registerToken(...args) : cmd === 'use' ? use(args[0]) : cmd === 'resume' ? resumeTerminal(args[0], args[1])
    : cmd === 'sessions' ? sessions() : cmd === 'scan' ? scan() : cmd === 'codex' ? codexUsage() : cmd === 'leads' ? leads() : cmd === 'switch-lead' ? switchLead(args[0], { force: args.includes('--force') })
    : (() => { throw new Error('사용법: status | register <키> [이름] | use <키> | resume <터미널> | scan | sessions | leads | switch-lead <터미널>'); })();
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
