import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { validateDecisions, changeDecision, resolvedForTask } from './decisions.js';
import { validateLedger } from './contract.js';
const { renameRetry } = createRequire(import.meta.url)('./atomic-rename.cjs');

// 쓰기는 adapter가 기존 ledger.lock을 잡고 Lead 생존을 확인한 동안만 호출한다.
// 잠금을 이중 획득하거나 업무 대장·events를 쓰지 않는다.
export function decisionStore({ stateDir, project, ledger, action, id, input, revision, all, task, by, at }) {
  validateLedger(ledger, project);
  const file = join(stateDir, 'decisions.json');
  const data = existsSync(file) ? validateDecisions(JSON.parse(readFileSync(file, 'utf8')), project) : { version: 1, project, requests: {} };
  if (action === 'list') return Object.values(data.requests).filter((r) => all || r.status === 'open');
  // 다음 단계 지시서에 넣을 업무별 해소 결정. 읽기 전용이라 Lead 확인 없이 허용하고 파일을 쓰지 않는다.
  if (action === 'resolved-for-task') {
    if (typeof task !== 'string' || !Object.keys(ledger.tasks).some((k) => k.toUpperCase() === task.toUpperCase())) throw new Error(`${task} 작업이 없다.`);
    return resolvedForTask(data, task);
  }
  if (!by || ledger.lead?.terminal !== by) throw new Error('현재 대장에 등록된 Lead 세션만 결정함을 쓸 수 있다.');
  const before = JSON.stringify(data);
  const result = changeDecision(data, { action, id, input, revision, by, at: at ?? new Date().toISOString(), tasks: ledger.tasks });
  if (before === JSON.stringify(data)) return result;
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > (1 << 20)) throw new Error('결정함이 mod의 1 MiB 읽기 한도를 넘어서 저장하지 않았다.');
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, serialized, { flag: 'wx' }); renameRetry(tmp, file); }
  finally { rmSync(tmp, { force: true }); }
  return result;
}
