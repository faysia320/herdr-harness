// QA 실행 영수증 v2 발급. 하네스 밖 PR도 이 명령으로 같은 영수증을 받는다.
// 사용법: node bin/qa-receipt.mjs [--worktree <checkout>] [--base <기준 커밋>] [--run <회차 ID>] [--round N] [--heavy <bin/heavy.mjs>] [--policy policy/qa-receipt.json]
// --base 기본값은 origin/main과 HEAD의 merge-base, --heavy 기본값은 이 파일 옆의 heavy.mjs다.
// 성공하면 exit 0과 envelope 줄(정책 output/<회차>/envelope.txt)을 출력한다. 검사 실패는 exit 1, 환경 준비 실패(BLOCKED)는 exit 3이다.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { issueReceipt, releaseOf } from '../core/qa-receipt-runner.mjs';

try {
  const { values: a } = parseArgs({ options: { worktree: { type: 'string', default: '.' }, base: { type: 'string' }, run: { type: 'string' },
    round: { type: 'string' }, heavy: { type: 'string' }, policy: { type: 'string', default: 'policy/qa-receipt.json' } } });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: resolve(a.worktree), encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw Error('git ' + args[0] + ' 실패: ' + r.stderr.trim());
    return r.stdout.trim();
  };
  const worktree = git('rev-parse', '--show-toplevel');
  const heavy = resolve(a.heavy ?? join(dirname(fileURLToPath(import.meta.url)), 'heavy.mjs'));
  const result = await issueReceipt({ worktree, heavy, release: releaseOf(heavy), policyFile: a.policy,
    base: a.base ?? git('merge-base', 'refs/remotes/origin/main', 'HEAD'), run: a.run ?? 'local-' + randomUUID(), round: a.round ? Number(a.round) : null });
  const { outputs, receipt, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
  if (result.status === 'PASS') console.error('PR 본문 «남은 검증» 뒤 줄 맨 앞에 넣을 줄: ' + join(result.out, 'envelope.txt'));
  else for (const reason of result.reasons) console.error(result.status + ': ' + reason);
  process.exitCode = { PASS: 0, FAIL: 1, BLOCKED: 3 }[result.status];
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
