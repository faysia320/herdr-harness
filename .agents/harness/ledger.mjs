import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { check, now, project, readJson } from './repository.mjs';

// Windows에서 다른 프로세스(백신·색인·편집기)가 대상 파일을 잠시 열고 있으면 rename이 EPERM·EACCES·EBUSY로 실패한다.
// 그 경우만 100ms 간격으로 최대 20회(약 2초) 다시 시도하고, 끝내 실패하면 마지막 오류를 던진다. 다른 오류는 바로 던진다.
const transientRename = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function atomic(file, bytes, { retries = 20, delay = 100 } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, bytes, { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, file); return; }
      catch (e) { if (!transientRename.has(e.code) || attempt >= retries) throw e; pause(delay); }
    }
  } finally { rmSync(temp, { force: true }); }
}

export async function readLedger(ctx) {
  const { validateLedger } = await import(pathToFileURL(join(ctx.binding.release, 'core/contract.js')).href);
  try { return validateLedger(readJson(join(ctx.stateDir, 'ledger.json')), project); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { version: 1, project, seq: 0, lead: null, tasks: {} };
  }
}

const lockBusy = () => new Error('대장 잠금이 사용 중이다. 종료된 실행이면 소유 PID를 확인한다.');
// 잠금 파일의 소유 PID가 이미 없는(ESRCH) 경우만 회수 대상이다. 빈 파일(생성 직후)·손상된 내용·살아 있거나 판정할 수 없는 PID는 보존한다.
function ownerGone(file) {
  try {
    const pid = JSON.parse(readFileSync(file, 'utf8'))?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return false;
  } catch (e) { return e.code === 'ESRCH'; }
}
// 회수는 별도 회수 잠금(wx) 안에서 소유자를 다시 확인하고 새 잠금까지 연다. 같은 죽은 PID를 동시에 본 다른 프로세스가 새 소유자의 잠금을 지우지 않는다.
function acquire(file) {
  try { return openSync(file, 'wx'); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const guard = file + '.reclaim';
  let held;
  try { held = openSync(guard, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw lockBusy(); throw e; }
  try {
    if (!ownerGone(file)) throw lockBusy();
    rmSync(file, { force: true });
    try { return openSync(file, 'wx'); }
    catch (e) { if (e.code === 'EEXIST') throw lockBusy(); throw e; }
  } finally { closeSync(held); rmSync(guard, { force: true }); }
}

export function lock(ctx, action) {
  mkdirSync(ctx.stateDir, { recursive: true });
  const file = join(ctx.stateDir, 'ledger.lock');
  const fd = acquire(file);
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
  if (event) appendEvent(ctx, event);
}

// 대장 교체(atomic)와 이벤트 추가를 나눠 부를 때 쓴다. 위임은 대장 저장이 끝난 뒤에만 이벤트를 남긴다.
export function appendEvent(ctx, event) {
  appendFileSync(join(ctx.stateDir, 'events.jsonl'), JSON.stringify({ at: now(), ...event }) + '\n');
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
