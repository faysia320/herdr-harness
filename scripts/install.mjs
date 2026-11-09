import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, basename, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build, modFiles } from './build.mjs';
import { run } from '../core/process.js';
import { withInstallLock } from './install-lock.mjs';
const { hash, verify } = createRequire(import.meta.url)('../adapters/runtime.cjs');
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
export function atomic(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, bytes); renameSync(tmp, file); } finally { rmSync(tmp, { force: true }); }
}
export function nativeCheck(path, executable = 'herdr-app') {
  const r = run(executable, ['check', path], { timeout: 30000 });
  if (r.code !== 0) throw new Error(`Herdr native check 실패: ${r.stderr || r.stdout}`);
  // 호스트가 JSON으로 오류를 보고하면 종료 코드 0이어도 설치를 거부한다.
  let value;
  try { value = JSON.parse(r.stdout); } catch { /* CLI 버전별 텍스트 출력 */ }
  if (value?.ok === false || value?.error || value?.errors?.length) throw new Error(`Herdr native check 오류: ${r.stdout}`);
}
export function install(plan, { check = nativeCheck } = {}) {
  if (!isAbsolute(plan.store) || !isAbsolute(plan.modPath) || !Array.isArray(plan.bindings)) throw new Error('store, modPath 절대 경로와 bindings 배열이 필요하다.');
  for (const b of plan.bindings) if (!isAbsolute(b.file) || !isAbsolute(b.cwd) || !Array.isArray(b.command) || !b.command.length || !b.project) throw new Error('프로젝트 연결 설정이 올바르지 않다.');
  plan = { ...plan, store: resolve(plan.store), modPath: resolve(plan.modPath), bindings: plan.bindings.map((b) => ({ ...b, file: resolve(b.file), cwd: resolve(b.cwd) })) };
  // 로컬 계획 오타로 업무 대장·질문·개인 설정을 연결 파일로 덮어쓰지 않는다.
  for (const b of plan.bindings) if (basename(b.file) !== 'harness-binding.json') throw new Error('연결 파일 이름은 harness-binding.json이어야 한다. 업무 자료와 개인 설정은 설치 대상이 아니다.');
  if (new Set(plan.bindings.map((b) => b.file.toLowerCase())).size !== plan.bindings.length) throw new Error('중복 연결 파일을 설치할 수 없다.');
  return withInstallLock(plan.store, () => installUnlocked(plan, check));
}
function installUnlocked(plan, check) {
  mkdirSync(plan.store, { recursive: true });
  const built = build(), release = join(plan.store, 'releases', built.manifestHash);
  if (!existsSync(release)) cpSync(built.release, release, { recursive: true, errorOnExist: true, force: false });
  verify(release, built.manifestHash);
  mkdirSync(dirname(plan.modPath), { recursive: true });
  const stage = mkdtempSync(join(dirname(plan.modPath), '.harness-stage-'));
  const configPath = join(plan.modPath, 'projects.json');
  try {
    for (const name of modFiles) cpSync(join(release, 'mod/harness', name), join(stage, name));
    writeFileSync(join(stage, 'projects.json'), existsSync(configPath) ? readFileSync(configPath) : '{"projects":[]}\n');
    check(stage, plan.herdrExecutable);
    const id = randomUUID(), recordPath = join(plan.store, 'installs', `${id}.json`);
    const activePath = join(plan.store, 'active.json');
    const writes = [
      ...modFiles.map((name) => ({ file: join(plan.modPath, name), bytes: readFileSync(join(stage, name)) })),
      ...plan.bindings.map((b) => ({ file: b.file, bytes: Buffer.from(`${JSON.stringify({ version: 1, project: b.project, release, manifestHash: built.manifestHash, command: b.command, cwd: b.cwd }, null, 2)}\n`) })),
    ];
    // 사용자 설정은 처음 설치할 때만 만들며 업데이트·복구 대상에서 제외한다.
    if (!existsSync(configPath)) atomic(configPath, '{"projects":[]}\n');
    const previous = existsSync(activePath) ? json(activePath) : null;
    const record = { version: 1, id, release, manifestHash: built.manifestHash, modPath: plan.modPath, previous,
      files: writes.map(({ file, bytes }) => ({ file, before: existsSync(file) ? readFileSync(file).toString('base64') : null, after: hash(bytes) })) };
    atomic(recordPath, JSON.stringify(record, null, 2));
    try {
      for (const w of writes) atomic(w.file, w.bytes);
      check(plan.modPath, plan.herdrExecutable);
      atomic(activePath, JSON.stringify({ version: 1, id, recordPath, release, manifestHash: built.manifestHash }, null, 2));
    } catch (e) {
      for (const f of record.files) { if (f.before === null) rmSync(f.file, { force: true }); else atomic(f.file, Buffer.from(f.before, 'base64')); }
      throw e;
    }
    return { release, manifestHash: built.manifestHash, modPath: plan.modPath, bindings: plan.bindings.map((b) => b.file), recordPath };
  } finally {
    // mkdtemp로 생성한 이 설치의 staging만 정리한다.
    if (dirname(stage) !== dirname(plan.modPath) || !stage.startsWith(join(dirname(plan.modPath), '.harness-stage-'))) throw new Error('staging 경계가 다르다.');
    rmSync(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(install(json(process.argv[2])), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 2; }
}
