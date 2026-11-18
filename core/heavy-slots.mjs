import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// 모든 저장소의 에이전트가 함께 쓰는 무거운 작업(전체 시험·빌드) 슬롯. 슬롯마다 파일 하나를 배타 생성해 점유한다.
export const slotRoot = (env = process.env) => env.HERDR_HEAVY_DIR ?? join(env.LOCALAPPDATA ?? tmpdir(), 'HerdrHarness', 'heavy-slots');

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const read = (file) => { try { return readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

// 점유 프로세스가 사라진 슬롯만 비운다. 판정한 내용과 지금 내용이 같을 때만 옮겨서, 그사이 다른 대기자가 새로 점유한 슬롯을 지우지 않는다.
function clearStale(file, raw) {
  const holder = parse(raw);
  if (holder && Number.isInteger(holder.pid) && alive(holder.pid)) return false;
  if (read(file) !== raw) return true;
  const moved = `${file}.stale-${process.pid}-${Date.now()}`;
  try { renameSync(file, moved); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  unlinkSync(moved);
  return true;
}

export function tryAcquire(dir, slots, info) {
  mkdirSync(dir, { recursive: true });
  const token = randomUUID();
  for (let index = 0; index < slots; index++) {
    const file = join(dir, `slot-${index}.json`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, JSON.stringify({ ...info, token }), { flag: 'wx' });
        return { file, token, index };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const raw = read(file);
        if (raw !== null && !clearStale(file, raw)) break;
      }
    }
  }
  return null;
}

export function release(slot) {
  const holder = parse(read(slot.file));
  if (holder?.token === slot.token) unlinkSync(slot.file);
}

export function status(dir, slots) {
  return Array.from({ length: slots }, (_, index) => {
    const raw = read(join(dir, `slot-${index}.json`));
    if (raw === null) return { index, free: true };
    const holder = parse(raw);
    if (!Number.isInteger(holder?.pid) || holder.pid <= 0) return { index, free: false, alive: null };
    return { index, pid: holder.pid, alive: alive(holder.pid), cwd: holder.cwd, command: holder.command, started: holder.started };
  });
}

export async function acquire(dir, slots, info, { poll = 2000, onWait = () => {} } = {}) {
  for (let waited = 0; ; waited += poll) {
    const slot = tryAcquire(dir, slots, info);
    if (slot) return slot;
    onWait(waited, status(dir, slots));
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}
