import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { check, now, project, readJson } from './repository.mjs';

export function atomic(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temp, bytes, { flag: 'wx' }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}

export async function readLedger(ctx) {
  const { validateLedger } = await import(pathToFileURL(join(ctx.binding.release, 'core/contract.js')).href);
  try { return validateLedger(readJson(join(ctx.stateDir, 'ledger.json')), project); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { version: 1, project, seq: 0, lead: null, tasks: {} };
  }
}

export function lock(ctx, action) {
  mkdirSync(ctx.stateDir, { recursive: true });
  const file = join(ctx.stateDir, 'ledger.lock');
  let fd;
  try { fd = openSync(file, 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error('대장 잠금이 사용 중이다. 종료된 실행이면 소유 PID를 확인한다.');
    throw e;
  }
  return (async () => {
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
      return await action();
    } finally { closeSync(fd); rmSync(file, { force: true }); }
  })();
}

export function save(ctx, ledger, event) {
  const bytes = JSON.stringify(ledger, null, 2) + '\n';
  check(Buffer.byteLength(bytes, 'utf8') <= 1 << 20, 'Herdr의 대장 읽기 한도에 도달했다. 완료 업무를 먼저 보관한다.');
  atomic(join(ctx.stateDir, 'ledger.json'), bytes);
  if (event) appendFileSync(join(ctx.stateDir, 'events.jsonl'), JSON.stringify({ at: now(), ...event }) + '\n');
}

export async function transition(ctx, task, to, reason, awaiting = null) {
  const { TRANSITIONS } = await import(pathToFileURL(join(ctx.binding.release, 'core/contract.js')).href);
  const from = task.state;
  if (from !== to) {
    check(TRANSITIONS[from]?.includes(to), '잘못된 업무 전이: ' + from + ' → ' + to);
    task.history.push({ at: now(), from, to, why: reason });
    task.state = to;
  }
  task.awaiting = awaiting;
  task.updated = now();
}

export function taskById(ledger, id) {
  check(Object.hasOwn(ledger.tasks, id), '업무 ID를 찾을 수 없다.');
  return ledger.tasks[id];
}

export function requireLead(ctx, ledger, terminal) {
  check(terminal && ledger.lead?.terminal === terminal && ctx.herdr(['get', terminal])?.state === 'live',
    '현재 대장에 등록된 살아 있는 Lead만 실행한다. recover와 hc 상태를 확인한다.');
  return terminal;
}

export function withoutDecision(ctx, ledger, task) {
  check(!ctx.decisions({ ledger, action: 'list' }).some(item => !item.task || item.task.toUpperCase() === task.id),
    '미해소 사용자 결정이 있다.');
}

export function artifact(file, run) {
  const raw = readFileSync(file, 'utf8');
  const value = JSON.parse(raw);
  check(value?.run === run.token, '현재 실행의 산출물이 아니다.');
  return value;
}
