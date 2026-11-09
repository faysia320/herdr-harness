// 공통 v1 읽기 계약. 전이 판정과 대장 쓰기는 저장소 adapter가 소유한다.
export const CONTRACT_VERSION = 1;
export const STATES = ['QUEUED', 'RESEARCHING', 'READY_TO_IMPLEMENT', 'IMPLEMENTING', 'QA', 'DONE', 'BLOCKED', 'FAILED'];
export const TRANSITIONS = {
  QUEUED: ['RESEARCHING', 'BLOCKED', 'FAILED'],
  RESEARCHING: ['READY_TO_IMPLEMENT', 'RESEARCHING', 'BLOCKED', 'FAILED'],
  READY_TO_IMPLEMENT: ['IMPLEMENTING', 'BLOCKED', 'FAILED'],
  IMPLEMENTING: ['QA', 'BLOCKED', 'FAILED'],
  QA: ['DONE', 'READY_TO_IMPLEMENT', 'BLOCKED', 'FAILED'],
  BLOCKED: ['QUEUED', 'RESEARCHING', 'READY_TO_IMPLEMENT', 'IMPLEMENTING', 'QA', 'DONE', 'FAILED'],
  FAILED: ['QUEUED'], DONE: [],
};
export function validateLedger(ledger, project) {
  if (!ledger || ledger.version !== CONTRACT_VERSION || ledger.project !== project || !ledger.tasks || typeof ledger.tasks !== 'object' || Array.isArray(ledger.tasks)) throw new Error('작업 대장 버전·프로젝트·형식이 맞지 않는다.');
  for (const task of Object.values(ledger.tasks)) if (!STATES.includes(task?.state)) throw new Error('지원하지 않는 업무 상태다.');
  return ledger;
}
