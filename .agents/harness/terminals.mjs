import { save } from './ledger.mjs';
import { check, now, project } from './repository.mjs';

// hc가 없는 터미널(제거됨 포함)을 not_found로 알리면 없는 것으로 본다. 그 밖의 조회 실패는 그대로 던진다.
const notFound = error => /"kind"\s*:\s*"not_found"/.test(error?.message ?? '');
export function lookupTerminal(ctx, address) {
  try { return ctx.herdr(['get', address]); } catch (error) { if (notFound(error)) return null; throw error; }
}

// 끝난(finished) 터미널을 hc rm으로 목록에서 지운다. 응답과 무관하게 다시 조회해 사라졌는지로 판정한다.
function remove(ctx, address) {
  let error = null;
  try { ctx.herdr(['rm', address]); } catch (e) { error = e.message; }
  try { if (!lookupTerminal(ctx, address)) return { removed: true }; } catch (e) { error ??= e.message; }
  return { removed: false, rm: error ?? 'hc rm 뒤에도 목록에 남아 있다.' };
}

// 대장에 기록된 그 회차의 주소이고 업무·회차 레이블이 같을 때만 닫는다. Lead·다른 업무 터미널, 레이블 불일치, 조회 실패는 닫지 않는다(kept).
// 수집 때는 아직 작업 중인 에이전트도 닫지 않는다(kept). 산출물을 쓴 뒤 턴을 이어 가는 에이전트를 끊지 않기 위해서다.
// 재회수(reclaim)는 그 회차가 이미 끝난 뒤이므로 작업 중이어도 닫는다.
// 이미 없으면 absent, 끝났으면 finished다. kill을 보냈으면 응답과 무관하게 다시 조회해 결과를 정한다.
// killed는 종료(after: finished)나 제거(after: removed)를 확인한 경우, still-live는 kill 뒤에도 살아 있는 경우,
// unknown은 kill 뒤 상태를 확인하지 못한 경우다. finished로 확인한 터미널은 hc rm으로 지우고 removed(또는 rm 실패 사유)를 남긴다.
export function closeTerminal(ctx, ledger, task, run, { reclaim = false } = {}) {
  const record = { address: run.terminal ?? null, at: now() };
  try {
    check(run.terminal, '대장에 위임 터미널 주소가 없다.');
    check(run.terminal !== ledger.lead?.terminal, 'Lead 터미널은 닫지 않는다.');
    const terminal = lookupTerminal(ctx, run.terminal);
    if (!terminal) return { ...record, outcome: 'absent' };
    check(terminal.labels?.['harness.project'] === project && terminal.labels?.['harness.task'] === task.id &&
      terminal.labels?.['harness.run'] === run.token, '터미널의 업무·회차 레이블이 이 회차와 다르다.');
    if (terminal.state !== 'live') return { ...record, outcome: 'finished', ...remove(ctx, run.terminal) };
    check(reclaim || terminal.status?.state !== 'working', '에이전트가 아직 작업 중이다. 다음 위임·종결 때 다시 닫는다.');
  } catch (error) {
    return { ...record, outcome: 'kept', reason: error.message };
  }
  let killError = null, after;
  try { ctx.herdr(['kill', run.terminal]); } catch (error) { killError = error.message; }
  const note = killError ? { kill: killError } : {};
  try { after = lookupTerminal(ctx, run.terminal); }
  catch (error) { return { ...record, outcome: 'unknown', ...note, reason: 'kill 뒤 터미널 상태를 확인하지 못했다: ' + error.message }; }
  if (!after) return { ...record, outcome: 'killed', after: 'removed', ...note };
  if (after.state !== 'live') return { ...record, outcome: 'killed', after: after.state, ...note, ...remove(ctx, run.terminal) };
  return { ...record, outcome: 'still-live', ...note,
    reason: 'kill 뒤에도 터미널이 살아 있다(keep 터미널 등). 다음 위임·종결 때 다시 닫는다.' };
}

// 다시 닫을 회차: 남겨 둔(kept)·kill 뒤 살아 있던(still-live)·확인 못 한(unknown) 터미널과 hc rm에 실패한 터미널.
const retryable = x => ['kept', 'still-live', 'unknown'].includes(x?.outcome) || x?.removed === false;

// 같은 업무의 다음 위임 직전과 업무가 DONE·FAILED로 끝날 때 이전 회차의 남은 위임 터미널을 다시 닫고 결과를 그 회차의 x_terminal에 남긴다.
// 진행 중인 회차는 건드리지 않는다. 결과가 같으면(시각 제외) 대장을 다시 쓰지 않는다.
export function reclaimTerminals(ctx, ledger, task) {
  const changed = [];
  (task.runs ?? []).forEach((run, index) => {
    if (run.status !== 'ended' || task.current?.run === index || !retryable(run.x_terminal)) return;
    const { at: _, ...before } = run.x_terminal;
    const result = closeTerminal(ctx, ledger, task, run, { reclaim: true });
    const { at: __, ...after } = result;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    run.x_terminal = result;
    changed.push({ token: run.token, ...result });
  });
  if (changed.length) save(ctx, ledger);
  return changed;
}
