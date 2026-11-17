import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { hash, verify } = createRequire(import.meta.url)('../adapters/runtime.cjs');
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const modFiles = ['attention.js', 'context.js', 'contract.js', 'decisions.js', 'logic.js', 'main.js', 'mod.json'];
export const autoFiles = ['main.js', 'mod.json'];
export const accountFiles = ['main.js', 'mod.json'];
export function build() {
  // mod 산출물만 복사한다. 순수 계약의 정본은 core/이며 생성본은 Git에서 제외한다.
  // 같은 내용이면 다시 쓰지 않는다. 동시에 build하는 다른 프로세스가 쓰는 중인 파일을 읽지 않게 한다.
  for (const name of ['decisions.js', 'contract.js']) {
    const from = join(root, 'core', name), to = join(root, 'mod/harness', name);
    if (!existsSync(to) || !readFileSync(to).equals(readFileSync(from))) copyFileSync(from, to);
  }
  const files = ['package.json', 'adapters/runtime.cjs', 'bin/harness.mjs', 'bin/decision-bridge.mjs', 'bin/claude-account.mjs', 'core/claude-accounts.mjs', 'core/execution-policy.cjs', 'core/artifact-policy.cjs', 'core/ledger-archive.cjs', 'core/decision-closure.cjs', 'policy/execution.json', 'policy/artifacts.json', 'policy/ledger.json',
    ...['decisions.js', 'contract.js', 'decision-store.js', 'process.js'].map((n) => `core/${n}`), ...modFiles.map((n) => `mod/harness/${n}`), ...autoFiles.map((n) => `mod/harness-auto/${n}`), ...accountFiles.map((n) => `mod/claude-accounts/${n}`)];
  files.push('bin/herdr-browser.mjs', 'core/herdr-browser.mjs', 'bin/heavy.mjs', 'core/heavy-slots.mjs');
  files.push('core/workflow.cjs', 'core/delivery.cjs', 'policy/workflow.json', 'bin/watch-delivery.mjs');
  files.push('core/verification-receipt.cjs', 'core/preparation.mjs');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const manifest = { format: 1, version, files: Object.fromEntries(files.sort().map((f) => [f, hash(readFileSync(join(root, f)))])) };
  const raw = `${JSON.stringify(manifest, null, 2)}\n`, digest = hash(raw);
  const release = join(root, 'dist', digest);
  if (!existsSync(release)) {
    // 임시 폴더에 다 만든 뒤 이름을 바꾼다. 동시에 build한 쪽이 먼저 만들었으면 그 결과를 검증한다.
    mkdirSync(join(root, 'dist'), { recursive: true });
    const stage = mkdtempSync(join(root, 'dist', '.stage-'));
    try {
      for (const file of files) { mkdirSync(dirname(join(stage, file)), { recursive: true }); copyFileSync(join(root, file), join(stage, file)); }
      writeFileSync(join(stage, 'manifest.json'), raw);
      try { renameSync(stage, release); } catch (e) { if (!existsSync(release)) throw e; }
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
  verify(release, digest);
  return { release, manifestHash: digest, version, provenance: 'content-hash' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(build(), null, 2));
