// 과정 산출물 공통 규칙. 경로는 저장소 config가 선언하고, 커밋 여부·보관 위치·증거 항목은 공통 정책이 정한다.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const raw = fs.readFileSync(path.join(__dirname, '../policy/artifacts.json'));
const defaults = JSON.parse(raw);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (message) => { throw new Error(message); };
const reasoned = (v) => typeof v === 'string' && v.trim();
const holes = /\{(id|slug|date)\}/g;
const safe = /^[A-Za-z0-9._-]+$/;

function template(value, label) {
  if (typeof value !== 'string' || !value.endsWith('/') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\\')
    || value.split('/').slice(0, -1).some((p) => !p || p === '.' || p === '..')) fail(`${label}는 '/'로 끝나는 저장소 상대 폴더여야 한다: ${value}`);
  const unknown = value.replace(holes, '').match(/[{}]/);
  if (unknown) fail(`${label}에는 {id}·{slug}·{date}만 쓸 수 있다: ${value}`);
  return value;
}

function configure(local) {
  if (!object(local) || defaults.version !== 1 || typeof defaults.commit !== 'boolean') fail('과정 산출물 정책 형식이 올바르지 않다.');
  const policy = { version: defaults.version, sha256: digest(raw), archive: defaults.archive, evidence: defaults.evidence };
  const decl = local.process_artifacts;
  if (decl === undefined) return { declared: false, commit: null, paths: [], exempt: [], ...policy };
  if (!object(decl) || Object.keys(decl).some((k) => !['paths', 'commit', 'reason', 'exempt'].includes(k))) fail('process_artifacts에는 paths·commit·reason·exempt만 사용할 수 있다.');
  if (!Array.isArray(decl.paths) || !decl.paths.length) fail('process_artifacts.paths에 업무별 과정 문서 폴더를 하나 이상 선언한다.');
  const paths = decl.paths.map((p) => template(p, 'process_artifacts.paths'));
  // 폴더 템플릿에 업무 자리표시자가 없으면 색인 등 공용 문서까지 과정 문서로 잡는다.
  for (const p of paths) if (!p.match(holes)) fail(`process_artifacts.paths는 업무별 폴더여야 한다({id}·{slug}·{date} 필요): ${p}`);
  if (decl.commit !== undefined && typeof decl.commit !== 'boolean') fail('process_artifacts.commit은 true 또는 false다.');
  const commit = decl.commit ?? defaults.commit;
  if (commit !== defaults.commit && !reasoned(decl.reason)) fail('공통 기본과 다른 커밋 여부에는 reason이 필요하다.');
  const exempt = (decl.exempt ?? []).map((e) => {
    if (!object(e) || !reasoned(e.reason) || Object.keys(e).some((k) => !['path', 'reason'].includes(k))) fail('process_artifacts.exempt 항목에는 path와 reason이 필요하다.');
    const p = template(e.path, 'process_artifacts.exempt');
    if (p.match(holes)) fail(`exempt는 보존할 특정 폴더만 지정한다: ${p}`);
    return { path: p, reason: e.reason };
  });
  return { declared: true, commit, reason: decl.reason ?? null, paths, exempt, ...policy };
}

const declared = (local) => {
  const c = configure(local);
  if (!c.declared) fail('config에 process_artifacts 선언이 없다.');
  return c;
};
const pattern = (p) => new RegExp(`^${p.replace(holes, '\u0000').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\u0000', '[^/]+')}`);

// 한 업무의 실제 과정 문서 폴더. 값에 경로 구분자를 허용하지 않는다.
function resolve(local, vars = {}) {
  return declared(local).paths.map((p) => p.replace(holes, (_, k) => {
    if (typeof vars[k] !== 'string' || !safe.test(vars[k])) fail(`과정 문서 경로의 {${k}} 값이 없거나 올바르지 않다.`);
    return vars[k];
  }));
}

// 커밋·PR에 들어가면 안 되는 과정 문서. 삭제는 기존 문서 정리이므로 허용한다.
function violations(local, changes) {
  const c = declared(local);
  if (c.commit) return [];
  const rules = c.paths.map(pattern);
  return changes.map((v) => (typeof v === 'string' ? { status: 'A', path: v } : v))
    .map((v) => ({ status: String(v.status ?? 'A')[0].toUpperCase(), path: String(v.path).replaceAll('\\', '/') }))
    .filter((v) => v.status !== 'D' && rules.some((r) => r.test(v.path)) && !c.exempt.some((e) => v.path.startsWith(e.path)));
}

function files(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return files(abs, base);
    return e.isFile() ? [abs] : [];
  });
}

// base 아래 경로에 링크·junction이 끼어 있으면 쓰기·읽기 전에 거부한다. 경로 밖의 파일을 덮어쓰거나 읽지 않게 한다.
function noLink(base, target) {
  let at = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    if (isLink(at)) fail(`보관 경로에 링크가 있어 거부했다: ${at}`);
    if (!fs.existsSync(at)) return;
  }
}
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// 파일 하나를 보관 위치에 쓴다. 같은 폴더의 새 임시 파일에 쓴 뒤 이름을 바꾼다. 기존 파일이 하드 링크여도 그 원본은 바꾸지 않는다.
function put(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, target); }
  finally { fs.rmSync(temp, { force: true }); }
}

// names(worktree 기준 '/' 경로)를 상태 폴더의 보관 위치로 복사하고 manifest에 누적한다. 이전 보관본은 지우지 않는다.
function store(c, input, names) {
  if (!safe.test(input.id ?? '') || /^\.+$/.test(input.id)) fail('보관할 업무 ID가 올바르지 않다.');
  if (!path.isAbsolute(input.worktree ?? '') || !path.isAbsolute(input.stateDir ?? '')) fail('worktree와 상태 폴더는 절대 경로여야 한다.');
  const dest = path.join(input.stateDir, ...c.archive.replace('{id}', input.id).split('/'));
  const manifestFile = path.join(dest, 'manifest.json');
  noLink(input.stateDir, manifestFile);
  const previous = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { files: {} };
  const copied = {};
  for (const name of names) {
    const abs = path.join(input.worktree, ...name.split('/')), target = path.join(dest, ...name.split('/'));
    noLink(input.worktree, abs);
    if (!fs.lstatSync(abs).isFile()) fail(`보관할 항목이 일반 파일이 아니다: ${name}`);
    const bytes = fs.readFileSync(abs);
    noLink(input.stateDir, target);
    put(target, bytes);
    copied[name] = digest(bytes);
  }
  const manifest = { version: 1, id: input.id, at: input.at ?? new Date().toISOString(), files: { ...previous.files, ...copied } };
  put(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: dest, copied, total: Object.keys(manifest.files).length };
}

// 선언한 업무별 과정 문서 폴더의 파일 목록.
function declaredFiles(local, input) {
  return resolve(local, { ...input.vars, id: input.id }).flatMap((rel) => {
    const root = path.join(input.worktree, ...rel.split('/'));
    noLink(input.worktree, root);
    return files(root).map((abs) => path.relative(input.worktree, abs).split(path.sep).join('/'));
  });
}

// worktree의 미커밋 과정 문서를 상태 폴더로 복사한다. 이전 보관본은 지우지 않고 같은 경로만 갱신한다.
function archive(local, input) {
  const c = declared(local);
  const out = store(c, input, declaredFiles(local, input));
  return { dir: out.dir, copied: Object.keys(out.copied).sort(), total: out.total };
}

// worktree 정리 전 보관. 선언한 과정 문서와 호출자가 지정한 파일(예: 무시된 실행 영수증)을 같은 위치에 복사한다.
// 선언이 없는 저장소는 지정 파일만 복사한다. 이번 호출의 사본 지문(files)으로 삭제 전 보존을 확인한다.
function preserve(local, input) {
  const c = configure(local);
  const extra = (input.files ?? []).map((name) => {
    if (typeof name !== 'string' || !name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[\\\0]/.test(name)
      || name.split('/').some((p) => !p || p === '.' || p === '..')) fail(`보관할 파일은 worktree 상대 경로여야 한다: ${name}`);
    return name;
  });
  const names = [...new Set([...(c.declared ? declaredFiles(local, input) : []), ...extra])].sort();
  const out = store(c, input, names);
  return { declared: c.declared, dir: out.dir, copied: Object.keys(out.copied), total: out.total, files: out.copied };
}

module.exports = { configure, resolve, violations, archive, preserve };
