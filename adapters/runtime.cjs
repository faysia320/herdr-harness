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
// 끝난 업무의 worktree·로컬 업무 브랜치 정리. 호출자는 대장 잠금 안에서 DONE 업무의 경로·브랜치 규칙과 실행 조회 결과를 넘기고
// 돌려받은 결과를 대장에 기록한다. 고정 release에 정리 모듈이 없으면 실행하지 않는다.
function worktreeCleanup(file, input) {
  const b = binding(file);
  if (b.project !== input.project || path.resolve(path.dirname(file)) !== path.resolve(input.stateDir)) throw new Error('worktree 정리 연결의 프로젝트·상태 경계가 다르다.');
  const real = (p) => { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  if (typeof b.cwd !== 'string' || typeof input.task?.root !== 'string' || real(b.cwd) !== real(input.task.root)) throw new Error('worktree 정리 연결의 저장소 경계가 다르다.');
  const manifest = JSON.parse(fs.readFileSync(path.join(b.release, 'manifest.json'), 'utf8'));
  if (!Object.hasOwn(manifest.files, 'core/worktree-cleanup.cjs')) throw new Error('고정 release가 worktree 정리를 지원하지 않는다. 새 release를 설치한 뒤 재시도한다.');
  const api = require(path.join(b.release, 'core/worktree-cleanup.cjs'));
  if (input.action === 'cleanup') return api.cleanup({ ...input.task, stateDir: input.stateDir });
  throw new Error('지원하지 않는 worktree 정리 동작이다.');
}
// 사용자 결정으로 QA 게이트를 예외 처리한 업무의 게시 허가·종결. 호출자는 대장 잠금 안에서 부르고 돌려받은 업무·사건을 저장한다.
// 병합 확인은 release 쪽에서 gh로 직접 한다. 호출자가 PR 조회 결과를 넘겨 근거를 대신할 수 없다.
function decisionClosure(file, input) {
  const b = binding(file);
  if (b.project !== input.project || path.resolve(path.dirname(file)) !== path.resolve(input.stateDir)) throw new Error('결정 종결 연결의 프로젝트·상태 경계가 다르다.');
  if (input.task?.project !== input.project) throw new Error('업무 프로젝트가 연결과 다르다.');
  const api = require(path.join(b.release, 'core/decision-closure.cjs'));
  if (input.action === 'authorize') return api.authorize(input.task, input.evidence, { now: input.now });
  if (input.action === 'gate') return api.gate(input.task);
  if (input.action === 'close') {
    if (!path.isAbsolute(input.cwd ?? '')) throw new Error('PR 조회 위치(cwd)는 절대 경로여야 한다.');
    return api.close(input.task, input.evidence, api.viewPr(input.cwd, Number(input.evidence?.pr)), { now: input.now });
  }
  throw new Error('지원하지 않는 결정 종결 동작이다.');
}
function workflow(file, input) {
  const b = binding(file);
  if (b.project !== input.project || path.resolve(path.dirname(file)) !== path.resolve(input.stateDir)) throw new Error('workflow 연결 경계가 다르다.');
  const api = require(path.join(b.release, 'core/workflow.cjs'));
  if (input.action === 'create') return api.create(input.kind, input.authorization);
  if (input.action === 'collect') return api.collect(input.flow, input.report, input.candidate);
  // options는 새 계획 형식 문구(scopes)와 해소 결정(decisions)을 켜는 명시 입력이다. 이전 release는 무시하므로 features로 먼저 확인한다.
  if (input.action === 'instructions') return api.instructions(input.flow, input.stage, input.candidate, input.options);
  if (input.action === 'features') return { planScopeVersion: api.planScopeVersion ?? null };
  if (['freeze', 'remaining', 'pr-remaining'].includes(input.action)) {
    if (api.planScopeVersion !== 1) throw new Error('고정 release가 검증 계획 실행 위치 분류를 지원하지 않는다.');
    if (input.action === 'freeze') return api.freezePlan(input.plan, input.options);
    if (input.action === 'remaining') return api.remainingVerification(input.plan);
    return api.missingRemaining(input.plan, input.body);
  }
  if (input.action === 'verify-receipt') return require(path.join(b.release, 'core/verification-receipt.cjs')).verifyReceipt(input.cwd,input.since,input.base,input.receipt);
  if (input.action === 'delivery') return require(path.join(b.release, 'core/delivery.cjs')).deliver(input);
  throw new Error('지원하지 않는 workflow 동작');
}
module.exports = { hash, verify, binding, bridge, executionPolicy, artifactPolicy, ledgerArchive, worktreeCleanup, decisionClosure, workflow };
if (require.main === module) {
  const handler = { policy: executionPolicy, artifacts: artifactPolicy, ledger: ledgerArchive, cleanup: worktreeCleanup, closure: decisionClosure, workflow }[process.argv[3]] ?? bridge;
  try { process.stdout.write(`${JSON.stringify(handler(process.argv[2], JSON.parse(fs.readFileSync(0, 'utf8'))))}\n`); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
}
