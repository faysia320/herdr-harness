import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { hash, verify } = createRequire(import.meta.url)('../adapters/runtime.cjs');
export function verifyInstall(store) {
  const active = JSON.parse(readFileSync(join(store, 'active.json'), 'utf8'));
  verify(active.release, active.manifestHash);
  const record = JSON.parse(readFileSync(active.recordPath, 'utf8'));
  for (const f of record.files) if (hash(readFileSync(f.file)) !== f.after) throw new Error(`설치 이후 파일이 바뀌었다: ${f.file}`);
  return { version: 1, release: active.release, manifestHash: active.manifestHash, files: record.files.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(verifyInstall(process.argv[2]), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 2; }
}
