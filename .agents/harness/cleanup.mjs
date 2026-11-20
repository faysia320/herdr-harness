import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { save } from './ledger.mjs';
import { adapter, check, config, now, project } from './repository.mjs';
import { lookupTerminal } from './stages.mjs';

// 끝난 업무 정리를 공통 release의 worktree-cleanup에 맡긴다. 이 파일은 HH의 경로·브랜치 규칙과 실행 조회만 넘긴다.
export const cleanupCommand = id => 'node .agents/harness/launch.mjs cleanup-worktree ' + id;

// 대장 보관에서 붙잡을 업무: worktree가 남았거나 정리가 끝나지 않은 업무, 미해소 질문이 걸린 업무.
export const archiveKeep = (tasks, decided) => tasks.filter(t => (t.worktree && existsSync(t.worktree)) ||
  (t.x_cleanup && t.x_cleanup.status !== 'done') || decided.has(t.id)).map(t => t.id);

// 정리 전 실행 조회. 대장에 기록된 회차마다 위임 터미널의 상태와 회차 레이블을 넘긴다. 제거된 터미널(not_found)은 absent이고,
// 그 밖의 조회 실패는 unknown으로 넘겨 정리를 막는다.
function activity(ctx, task) {
  return { current: Boolean(task.current), runs: task.runs.map(r => {
    const address = r.terminal ?? r.name ?? null;
    if (!address) return { token: r.token, status: r.status, address, state: 'absent' };
    try {
      const terminal = lookupTerminal(ctx, address);
      return { token: r.token, status: r.status, address, state: terminal?.state ?? 'absent', run: terminal?.labels?.['harness.run'] ?? null };
    } catch (error) { return { token: r.token, status: r.status, address, state: 'unknown', error: error.message }; }
  }) };
}

// DONE 직후와 Lead 재시도에서 공통 정리를 부른다. 정리가 실패해도 DONE·병합 증명·예외 종결·승인 병합 종결은 되돌리지 않고
// 사유·남은 자원·재시도 명령을 응답과 대장의 x_cleanup에 남긴다. 결과가 같으면 다시 기록하지 않는다.
// 추적 파일 내용 확인 한도는 DONE 직후 자동 정리가 watch-delivery 한 회(180초) 안에 들어가게 하고, Lead 재시도는 더 길게 준다.
export function cleanupWorktree(ctx, ledger, task, { retry = false } = {}) {
  const flow = task.x_flow ?? {}, delivery = flow.delivery ?? {}, merged = flow.phase === 'merged';
  const closure = flow.phase === 'closed' ? flow.closure?.kind : null;
  let result;
  try {
    check(task.state === 'DONE' && (merged || ['policy-exception', 'merged-accepted'].includes(closure)),
      '병합 증명·정책 예외·사용자 승인 병합 종결로 DONE이 된 업무만 정리한다.');
    check(JSON.stringify(adapter.binding(ctx.file)) === JSON.stringify(ctx.binding), '실행 중 binding이 바뀌었다. 고정 릴리스로 다시 실행한다.');
    result = adapter.worktreeCleanup(ctx.file, { action: 'cleanup', project, stateDir: ctx.stateDir, task: {
      id: task.id, state: task.state, root: ctx.root, worktreeDir: join(ctx.root, config.project.worktree_dir), worktree: task.worktree, branch: task.branch,
      ...(merged ? { kind: 'merged', proof: { head: delivery.head, original: delivery.original?.head ?? null, branch: delivery.branch ?? null } }
        : closure === 'merged-accepted' ? { kind: 'merged-accepted' } : { kind: 'closed', candidate: task.candidate }),
      activity: activity(ctx, task), ignored: { keep: config.cleanup.keep_ignored, discard: config.cleanup.discard_ignored },
      artifacts: { config, vars: { slug: task.slug } }, retry: cleanupCommand(task.id), at: now(),
      limits: { contentMs: retry ? config.cleanup.retry_content_ms : config.cleanup.content_ms },
    } });
  } catch (error) {
    result = { version: 1, id: task.id, status: 'failed', reasons: [error.message],
      remaining: [task.worktree].filter(p => p && existsSync(p)), retry: cleanupCommand(task.id) };
  }
  const { at: _, ...stored } = task.x_cleanup ?? {};
  if (JSON.stringify(stored) !== JSON.stringify(result)) {
    task.x_cleanup = { ...result, at: now() };
    save(ctx, ledger, { event: 'x_cleanup', task: task.id, status: result.status });
  }
  return result;
}
