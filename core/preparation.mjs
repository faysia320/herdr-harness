import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// release·저장소와 무관하게 같은 PC에서 준비 명령 하나만 실행한다. 시험/빌드 슬롯과는 별도다.
export const preparationRoot = (env = process.env) => env.HERDR_PREPARATION_DIR ?? join(env.LOCALAPPDATA ?? tmpdir(), 'HerdrHarness', 'preparation');
export const needsPreparation = (args) => ['prepare', 'dispatch'].includes(args[0]) || (args[0] === 'next' && args.includes('--go'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const read = (file) => { try { return readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

export function preparationStatus(dir = preparationRoot()) {
  const file = join(dir, 'active.json'), raw = read(file), holder = parse(raw);
  return { file, free: raw === null, holder, alive: Number.isInteger(holder?.pid) && holder.pid > 0 ? alive(holder.pid) : null };
}

export async function withPreparation(info, action, { dir = preparationRoot(), signal, poll = 1000, report = (message) => console.error(message) } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'active.json'), token = randomUUID(), queued = Date.now();
  let lastReport = -Infinity, owned = false;
  try {
    while (!owned) {
      signal?.throwIfAborted();
      let fd;
      try { fd = openSync(file, 'wx'); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (fd !== undefined) {
        // 생성과 기록 사이에는 다른 대기자가 빈 파일을 볼 수 있다. 빈/죽은 잠금도 자동 삭제하지 않는다.
        owned = true;
        try { writeFileSync(fd, JSON.stringify({ ...info, pid: process.pid, token, started: new Date().toISOString() }) + '\n'); }
        finally { closeSync(fd); }
        break;
      }
      const state = preparationStatus(dir);
      if (state.free) continue;
      if (state.alive === false) throw new Error(`준비 잠금의 소유 프로세스가 종료됐다: ${file}. 하위 Git 작업까지 종료됐는지 확인 후 이 잠금만 복구한다.`);
      if (Date.now() - lastReport >= 60000) {
        report(`[prepare] 순서 대기 ${Math.round((Date.now() - queued) / 1000)}초: ${state.holder?.project ?? '잠금 기록 중'} pid ${state.holder?.pid ?? '?'} (${file})`);
        lastReport = Date.now();
      }
      await delay(poll, undefined, { signal });
    }
    signal?.throwIfAborted();
    const started = Date.now();
    report(`[prepare] 준비 시작: ${info.project} ${info.command}; 순서 대기 ${Math.round((started - queued) / 1000)}초`);
    try { return await action(); }
    finally { report(`[prepare] 준비 명령 종료: ${info.project}; 실행 ${Math.round((Date.now() - started) / 1000)}초`); }
  } finally {
    // action은 하위 프로세스 종료를 확인한 뒤 반환해야 한다. 강제 종료로 남은 잠금은 시간만으로 빼앗지 않는다.
    if (owned && parse(read(file))?.token === token) unlinkSync(file);
  }
}
