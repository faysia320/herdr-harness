// 저장소 PR CI의 QA 실행 영수증 검증. 체크아웃의 정책 파일·Git 객체와 GitHub 이벤트 payload만 읽는다.
// release·네트워크·Docker·전체 시험이 필요 없다. 다른 저장소는 이 파일과 core/qa-receipt-policy.cjs·core/dev14.cjs를 함께 복사한다.
// 사용법: node bin/verify-qa-receipt.mjs [--event <PR 이벤트 JSON>] [--policy policy/qa-receipt.json] [--main <main 커밋>] [--cwd <checkout>]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { loadPolicy, verifyPullRequest } = createRequire(import.meta.url)('../core/qa-receipt-policy.cjs');
const started = Date.now();
try {
  const { values: a } = parseArgs({ options: { event: { type: 'string' }, policy: { type: 'string', default: 'policy/qa-receipt.json' },
    main: { type: 'string' }, cwd: { type: 'string', default: '.' } } });
  const cwd = resolve(a.cwd);
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: 30000 });
    if (r.error || r.status !== 0) throw Error('git ' + args[0] + ' 실패: ' + (r.error?.message ?? r.stderr.trim()));
    return r.stdout.includes('\0') ? r.stdout : r.stdout.trim();
  };
  // 정책 파일 검사는 면제 PR에도 적용한다.
  const policy = loadPolicy(resolve(cwd, a.policy));
  const file = a.event ?? process.env.GITHUB_EVENT_PATH;
  if (!file) throw Error('--event 또는 GITHUB_EVENT_PATH가 필요하다.');
  const result = verifyPullRequest({ git, event: JSON.parse(readFileSync(file, 'utf8')), policy, main: a.main });
  console.log(JSON.stringify({ ...result, ms: Date.now() - started }, null, 2));
  if (result.status === 'exempt') console.error(`PR #${result.pr}은 도입 전 PR(exempt_pr_max ${policy.exempt_pr_max} 이하)이라 영수증 검사를 면제한다.`);
  if (result.status === 'fail') {
    for (const reason of result.reasons) console.error('QA 영수증 거부: ' + reason);
    console.error('같은 runner(node bin/qa-receipt.mjs)로 영수증을 다시 발급해 envelope 줄을 PR 본문에 넣으면 이 검사가 다시 실행된다.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error('QA 영수증 검증 실패: ' + error.message);
  process.exitCode = 1;
}
