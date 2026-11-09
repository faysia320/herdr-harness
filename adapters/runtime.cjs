// herdr-harness가 배포하는 작은 호환 진입점. 정책과 업무 상태는 회사 CLI가 관리한다.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = (v) => createHash('sha256').update(v).digest('hex');
function verify(release, expected) {
  const raw = fs.readFileSync(path.join(release, 'manifest.json'));
  if (hash(raw) !== expected) throw new Error('설치 manifest 지문이 달라 실행하지 않았다.');
  const manifest = JSON.parse(raw);
  if (manifest.format !== 1 || !manifest.files || !Object.keys(manifest.files).length) throw new Error('지원하지 않는 설치 manifest다.');
  for (const [file, digest] of Object.entries(manifest.files)) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(file) || file.split('/').some((p) => p === '..' || !p) || path.isAbsolute(file)) throw new Error('설치 파일 경계가 잘못됐다.');
    const target = path.join(release, file);
    if (!fs.lstatSync(target).isFile() || hash(fs.readFileSync(target)) !== digest) throw new Error(`설치 파일 지문 불일치: ${file}`);
  }
  return manifest;
}
function binding(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.version !== 1 || !path.isAbsolute(value.release) || typeof value.project !== 'string') throw new Error('연결 설정이 올바르지 않다.');
  verify(value.release, value.manifestHash);
  return value;
}
function bridge(file, input) {
  const b = binding(file);
  if (b.project !== input.project || path.resolve(path.dirname(file)) !== path.resolve(input.stateDir)) throw new Error('결정함 연결의 프로젝트·상태 경계가 다르다.');
  const r = spawnSync(process.execPath, [path.join(b.release, 'bin/decision-bridge.mjs')], {
    input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer: 4 << 20,
  });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr.trim() ?? '공통 결정함 실행 실패');
  return JSON.parse(r.stdout);
}
module.exports = { hash, verify, binding, bridge };
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(bridge(process.argv[2], JSON.parse(fs.readFileSync(0, 'utf8'))))}\n`); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
}
