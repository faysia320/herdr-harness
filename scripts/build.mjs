import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { hash, verify } = createRequire(import.meta.url)('../adapters/runtime.cjs');
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const modFiles = ['attention.js', 'contract.js', 'decisions.js', 'git-data.js', 'git-tree.js', 'logic.js', 'main.js', 'mod.json'];
export function build() {
  // mod 산출물만 복사한다. 순수 계약의 정본은 core/이며 생성본은 Git에서 제외한다.
  for (const name of ['decisions.js', 'contract.js']) copyFileSync(join(root, 'core', name), join(root, 'mod/harness', name));
  const files = ['package.json', 'adapters/runtime.cjs', 'bin/harness.mjs', 'bin/decision-bridge.mjs',
    ...['decisions.js', 'contract.js', 'decision-store.js', 'process.js'].map((n) => `core/${n}`), ...modFiles.map((n) => `mod/harness/${n}`)];
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const manifest = { format: 1, version, files: Object.fromEntries(files.sort().map((f) => [f, hash(readFileSync(join(root, f)))])) };
  const raw = `${JSON.stringify(manifest, null, 2)}\n`, digest = hash(raw);
  const release = join(root, 'dist', digest);
  if (!existsSync(release)) {
    for (const file of files) { mkdirSync(dirname(join(release, file)), { recursive: true }); copyFileSync(join(root, file), join(release, file)); }
    writeFileSync(join(release, 'manifest.json'), raw);
  }
  verify(release, digest);
  return { release, manifestHash: digest, version, provenance: 'content-hash' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(build(), null, 2));
