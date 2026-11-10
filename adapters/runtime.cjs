// herdr-harness가 배포하는 작은 호환 진입점. 실행 정책은 공통 release, 업무 상태는 프로젝트 CLI가 관리한다.
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
// Python도 같은 resolver를 호출한다. 언어별 모델 선택 로직을 복제하지 않는다.
function executionPolicy(file, input) {
  const b = binding(file);
  if (b.project !== input.project || path.resolve(path.dirname(file)) !== path.resolve(input.stateDir)) throw new Error('실행 정책 연결의 프로젝트·상태 경계가 다르다.');
  const api = require(path.join(b.release, 'core/execution-policy.cjs'));
  if (input.action === 'config') return api.configure(input.config);
  if (input.action === 'resolve') return { ...api.resolve(input.config, input.task, input.stage), releaseHash: b.manifestHash };
  throw new Error('지원하지 않는 실행 정책 동작이다.');
}
// 과정 산출물의 커밋 여부·보관·PR 검사도 binding으로 고정한 release 규칙을 쓴다.
function artifactPolicy(file, input) {
  const b = binding(file);
  if (b.project !== input.project || path.resolve(path.dirname(file)) !== path.resolve(input.stateDir)) throw new Error('과정 산출물 연결의 프로젝트·상태 경계가 다르다.');
  const api = require(path.join(b.release, 'core/artifact-policy.cjs'));
  if (input.action === 'config') return api.configure(input.config);
  if (input.action === 'resolve') return api.resolve(input.config, input.vars);
  if (input.action === 'violations') return api.violations(input.config, input.changes);
  if (input.action === 'archive') return api.archive(input.config, { ...input.task, stateDir: input.stateDir });
  throw new Error('지원하지 않는 과정 산출물 동작이다.');
}
// 끝난 업무 보관. 호출자는 대장 잠금 안에서 부르고 돌려받은 대장을 저장한다.
function ledgerArchive(file, input) {
  const b = binding(file);
  if (b.project !== input.project || path.resolve(path.dirname(file)) !== path.resolve(input.stateDir)) throw new Error('대장 보관 연결의 프로젝트·상태 경계가 다르다.');
  if (input.ledger?.project !== input.project) throw new Error('대장 프로젝트가 연결과 다르다.');
  const api = require(path.join(b.release, 'core/ledger-archive.cjs'));
  if (input.action === 'plan') return api.plan(input.ledger, input.options);
  if (input.action === 'archive') return api.archive(input.ledger, input.stateDir, input.options);
  if (input.action === 'restore') return api.restore(input.ledger.tasks[input.id], input.stateDir);
  throw new Error('지원하지 않는 대장 보관 동작이다.');
}
module.exports = { hash, verify, binding, bridge, executionPolicy, artifactPolicy, ledgerArchive };
if (require.main === module) {
  const handler = { policy: executionPolicy, artifacts: artifactPolicy, ledger: ledgerArchive }[process.argv[3]] ?? bridge;
  try { process.stdout.write(`${JSON.stringify(handler(process.argv[2], JSON.parse(fs.readFileSync(0, 'utf8'))))}\n`); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
}
