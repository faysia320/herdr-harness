import { mkdirSync, openSync, closeSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
// install과 rollback은 같은 보관소에서 동시에 소스·binding을 바꾸지 않는다.
// 죽은 프로세스의 잠금도 시간만 보고 지우지 않는다. 활성 작업 확인 후 사람이 복구한다.
export function withInstallLock(store, action) {
  mkdirSync(resolve(store), { recursive: true });
  const file = join(resolve(store), 'install.lock');
  let fd;
  try { fd = openSync(file, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('다른 설치·복구가 진행 중이다. install.lock 소유 작업을 확인한다.'); throw e; }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); return action(); }
  finally { closeSync(fd); rmSync(file, { force: true }); }
}
