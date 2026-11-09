import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic } from './install.mjs';
import { verifyInstall } from './verify-install.mjs';
import { withInstallLock } from './install-lock.mjs';
export function rollback(store) {
  return withInstallLock(store, () => rollbackUnlocked(store));
}
function rollbackUnlocked(store) {
  verifyInstall(store); // 다른 수동 변경을 덮어쓰지 않는다.
  const activePath = join(store, 'active.json');
  const active = JSON.parse(readFileSync(activePath, 'utf8'));
  const record = JSON.parse(readFileSync(active.recordPath, 'utf8'));
  for (const f of record.files) { if (f.before === null) rmSync(f.file, { force: true }); else atomic(f.file, Buffer.from(f.before, 'base64')); }
  if (record.previous) atomic(activePath, JSON.stringify(record.previous, null, 2));
  else rmSync(activePath, { force: true });
  return { restored: record.previous?.release ?? '설치 전 소스', preserved: ['projects.json', 'ledger.json', 'decisions.json', '읽음 정보'] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(rollback(process.argv[2]), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 2; }
}
