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
// 폐지한 사용자 결정 게시·종결(v1). 일반 결정함 진입점으로 넘어가지 않게 이름을 남겨 거부한다.
function decisionClosure() {
  throw new Error('사용자 결정 게시·종결(v1)은 폐지됐다. 병합된 업무는 workflow accept-merged로 종결한다.');
}
function workflow(file, input) {
  const b = binding(file);
  if (b.project !== input.project || path.resolve(path.dirname(file)) !== path.resolve(input.stateDir)) throw new Error('workflow 연결 경계가 다르다.');
  const api = require(path.join(b.release, 'core/workflow.cjs'));
  if (input.action === 'create') return api.create(input.kind, input.authorization);
  if (input.action === 'collect') return api.collect(input.flow, input.report, input.candidate);
  // 게시 권한 없는 업무의 QA PASS 로컬 종결. 호출자는 Lead 잠금 안에서 현재 후보·결정을 확인하고 돌려받은 task·event를 저장한다.
  if (input.action === 'close-local') {
    if (!api.closeLocal) throw new Error('고정 release가 로컬 종결을 지원하지 않는다. 새 release를 설치한 뒤 재시도한다.');
    if (input.task?.project !== undefined && input.task.project !== input.project) throw new Error('업무 프로젝트가 연결과 다르다.');
    return api.closeLocal(input.task, input, { now: input.now });
  }
  // revalidate 재구현이 병합한 main을 {from,to}로 돌려준다(이동이 없으면 null). 호출자는 구현 DONE 수집에서 새 기준으로 후보를 검사하고 함께 저장한다.
  if (input.action === 'merged-base') {
    if (!api.mergedBase) throw new Error('고정 release가 재구현 기준 이동을 지원하지 않는다. 새 release를 설치한 뒤 재시도한다.');
    return api.mergedBase(input.task, (...args) => {
      const r = spawnSync('git', args, { cwd: input.task.worktree, encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000 });
      if (r.error || r.status !== 0) throw new Error('기준 확인 실패: ' + (r.error?.message ?? r.stderr.trim()));
      return r.stdout.trim();
    });
  }
  // options는 새 계획 형식 문구(scopes)와 해소 결정(decisions)을 켜는 명시 입력이다. 이전 release는 무시하므로 features로 먼저 확인한다.
  if (input.action === 'instructions') return api.instructions(input.flow, input.stage, input.candidate, input.options);
  if (input.action === 'features') return { planScopeVersion: api.planScopeVersion ?? null };
  if (['freeze', 'remaining', 'pr-remaining'].includes(input.action)) {
    if (api.planScopeVersion !== 1) throw new Error('고정 release가 검증 계획 실행 위치 분류를 지원하지 않는다.');
    if (input.action === 'freeze') return api.freezePlan(input.plan, input.options);
    // verification은 QA 보고서의 limitations를 함께 싣는 선택 입력이다. 이전 release는 무시하고 계획 항목만 돌려준다.
    if (input.action === 'remaining') return api.remainingVerification(input.plan, input.verification);
    return api.missingRemaining(input.plan, input.body, input.verification);
  }
  if (input.action === 'verify-receipt') return require(path.join(b.release, 'core/verification-receipt.cjs')).verifyReceipt(input.cwd,input.since,input.base,input.receipt);
  // 발급 뒤 영수증 tree 검증. 발급기가 후보 객체를 남기지 않으므로 어댑터는 tree를 git으로 읽지 않고 이 결과로 대조한다.
  if (input.action === 'receipt-tree-check') {
    const api = require(path.join(b.release, 'core/verification-receipt.cjs'));
    if (!api.receiptTreeCheck) throw new Error('고정 release가 영수증 tree 검사를 지원하지 않는다. 새 release를 설치한 뒤 재시도한다.');
    return api.receiptTreeCheck({ worktree: input.worktree, base: input.base, tree: input.tree });
  }
  if (input.action === 'delivery') return require(path.join(b.release, 'core/delivery.cjs')).deliver(input);
  // 사용자 승인 병합 종결. PR·원격 main 조회는 binding의 저장소(cwd)에서 release가 직접 한다. 호출자는 Lead 잠금 안에서
  // 돌려받은 task·event를 저장하고 worktree 정리를 부른다. pr을 생략하면 연결된 PR을 쓰고 브랜치 대조를 면제하지 않는다.
  if (input.action === 'accept-merged') {
    const manifest = JSON.parse(fs.readFileSync(path.join(b.release, 'manifest.json'), 'utf8'));
    if (!Object.hasOwn(manifest.files, 'core/merged-closure.cjs')) throw new Error('고정 release가 사용자 승인 병합 종결을 지원하지 않는다. 새 release를 설치한 뒤 재시도한다.');
    if (input.task?.project !== undefined && input.task.project !== input.project) throw new Error('업무 프로젝트가 연결과 다르다.');
    const cwd = typeof b.cwd === 'string' ? b.cwd : input.cwd;
    if (!path.isAbsolute(cwd ?? '')) throw new Error('PR 조회 위치(binding cwd)는 절대 경로여야 한다.');
    const api = require(path.join(b.release, 'core/merged-closure.cjs'));
    const given = input.pr !== undefined && input.pr !== null;
    const pr = Number(given ? input.pr : input.task?.x_flow?.delivery?.pr);
    const request = { ...input, pr, explicit: given && input.explicit === true };
    return api.accept(input.task, request, api.verify(cwd, pr), { now: input.now });
  }
  throw new Error('지원하지 않는 workflow 동작');
}
module.exports = { hash, verify, binding, bridge, executionPolicy, artifactPolicy, ledgerArchive, worktreeCleanup, workflow };
if (require.main === module) {
  const handler = { policy: executionPolicy, artifacts: artifactPolicy, ledger: ledgerArchive, cleanup: worktreeCleanup, closure: decisionClosure, workflow }[process.argv[3]] ?? bridge;
  try { process.stdout.write(`${JSON.stringify(handler(process.argv[2], JSON.parse(fs.readFileSync(0, 'utf8'))))}\n`); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
}
