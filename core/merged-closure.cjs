// 이미 main에 병합된 PR의 업무를 사용자 승인으로 DONE 종결하는 공통 판정. Lead 인증·대장 잠금·저장·worktree 정리는 프로젝트 어댑터가 맡는다.
// 병합 증명(core/delivery.cjs, phase=merged)·정책 예외(policy-exception)와 다르다. strict 보호·QA 후보 지문·squash 부모·민감 경로·
// QA PASS·최초 게시 기록은 보지 않고, GitHub의 PR state=MERGED·merge SHA와 그 SHA가 지금 원격 main에 포함됨만 확인한다.
const { spawnSync } = require('node:child_process');
const KIND = 'merged-accepted';
const VERSION = 1;
const oid = /^[0-9a-f]{40}$/;
const fail = (message) => { throw new Error(message); };
const text = (value) => typeof value === 'string' ? value.trim() : '';

function run(cwd, cmd, args, env = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000, maxBuffer: 4 << 20 });
  if (r.error) fail(`${cmd} ${args[0]} 실행 실패: ${r.error.message}`);
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

// origin 설정 URL의 GitHub 저장소(HOST/OWNER/REPO). insteadOf 재작성 전 값을 읽어 다른 저장소의 PR을 조회하지 않게 하고,
// 호스트까지 넘겨 GH_HOST가 다른 호스트를 가리켜도 origin의 GitHub 호스트로 조회한다.
function repository(cwd) {
  const url = run(cwd, 'git', ['config', '--get', 'remote.origin.url']).out;
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) fail(`origin이 GitHub 저장소가 아니다: ${url || '(없음)'}`);
  return `github.com/${m[1]}/${m[2]}`;
}

// 원격 PR과 현재 원격 main을 직접 조회한다. 호출자가 넘긴 PR 결과나 낡은 로컬 origin/main은 근거로 쓰지 않는다.
// HERDR_HARNESS_GH(JSON 배열)는 시험용 gh 대체 명령이다.
function verify(cwd, number, env = process.env) {
  if (!Number.isSafeInteger(number) || number < 1) fail(`PR 번호가 올바르지 않다: ${number}`);
  const repo = repository(cwd);
  const gh = env.HERDR_HARNESS_GH ? JSON.parse(env.HERDR_HARNESS_GH) : ['gh'];
  const view = run(cwd, gh[0], [...gh.slice(1), 'pr', 'view', String(number), '--repo', repo, '--json', 'number,state,mergeCommit,mergedAt,url,headRefName'], env);
  if (view.code !== 0) fail(`gh pr view ${number} 실패: ${view.err || `종료 코드 ${view.code}`}`);
  const pr = JSON.parse(view.out);
  if (pr?.number !== number) fail(`gh가 돌려준 PR 번호가 다르다: ${pr?.number} ≠ ${number}`);
  if (pr.state !== 'MERGED') fail(`PR #${number}가 병합되지 않았다(${pr.state}).`);
  const merge = text(pr.mergeCommit?.oid).toLowerCase();
  if (!oid.test(merge)) fail(`PR #${number}의 병합 커밋 SHA가 없다.`);
  const main = run(cwd, 'git', ['ls-remote', 'origin', 'refs/heads/main']);
  const tip = main.code === 0 ? main.out.split(/\s/)[0] : '';
  if (!oid.test(tip)) fail(`원격 main을 조회하지 못했다: ${main.err || '응답 없음'}`);
  const fetched = run(cwd, 'git', ['fetch', '--no-write-fetch-head', '--no-tags', 'origin', tip]);
  if (fetched.code !== 0) fail(`원격 main ${tip}을 가져오지 못했다: ${fetched.err}`);
  const ancestry = run(cwd, 'git', ['merge-base', '--is-ancestor', merge, tip]);
  if (ancestry.code === 1) fail(`PR #${number}의 병합 커밋 ${merge}이 현재 원격 main(${tip})에 없다.`);
  if (ancestry.code !== 0) fail(`병합 커밋 ${merge}의 원격 main 포함 여부를 확인할 수 없다: ${ancestry.err || `종료 코드 ${ancestry.code}`}`);
  return { repo, pr: number, url: pr.url ?? null, merge, main: tip, branch: text(pr.headRefName) || null, mergedAt: pr.mergedAt ?? null };
}

// 확인된 병합 결과와 사용자 승인으로 DONE 업무·사건을 만든다. 일반 전이표를 넓히지 않고 이전 상태를 closure에 남긴다.
// explicit은 Lead가 PR 번호를 직접 지정했다는 뜻이다. 아니면 PR head 브랜치가 업무 브랜치와 같아야 한다.
function accept(task, input, merged, { now = new Date().toISOString() } = {}) {
  if (task?.x_flow?.version !== 2) fail(`${task?.id}는 v2 업무가 아니다.`);
  if (task.state === 'DONE') fail(`${task.id}는 이미 DONE이다. 기존 종결 근거를 덮어쓰지 않는다.`);
  const quote = text(input?.evidence?.quote), source = text(input?.evidence?.source), terminal = text(input?.terminal);
  if (!quote) fail('사용자 승인 원문(evidence.quote)이 필요하다. 사용자가 실제로 한 말을 그대로 적는다.');
  if (!source) fail('승인 출처(evidence.source)가 필요하다. 예: Lead 대화 2026-11-21.');
  if (!terminal) fail('종결을 실행한 Lead 터미널(terminal)이 필요하다.');
  if (merged?.pr !== Number(input?.pr) || !oid.test(merged?.merge ?? '')) fail('확인된 병합 결과가 요청한 PR과 다르다.');
  if (input.explicit !== true && merged.branch !== task.branch)
    fail(`PR #${merged.pr}의 브랜치 ${merged.branch}가 업무 브랜치 ${task.branch}와 다르다. 이 PR이 맞으면 Lead가 PR 번호를 직접 지정한다.`);
  const flow = task.x_flow;
  const closure = { kind: KIND, pr: merged.pr, url: merged.url, merge: merged.merge, main: merged.main, branch: merged.branch,
    explicit: input.explicit === true, at: now, terminal, evidence: { quote, source }, previousState: task.state, previousPhase: flow.phase ?? null };
  const why = `사용자 승인 병합 종결: PR #${merged.pr} 병합 ${merged.merge.slice(0, 12)}`;
  // 진행 중 회차는 종결 사실로 끝내 늦은 수집이 DONE을 바꾸지 못하게 한다. 위임 터미널 생존 여부는 정리기가 따로 확인한다.
  const runs = (task.runs ?? []).map((r, i) => task.current?.run === i && r.status === 'running'
    ? { ...r, status: 'ended', ended: now, outcome: 'closed', note: why } : r);
  const next = { ...task, state: 'DONE', pending: null, awaiting: null, resume_state: null, blocked_reason: null, current: null, updated: now, runs,
    x_flow: { ...flow, phase: 'closed', closure },
    history: [...(task.history ?? []), { at: now, from: task.state, to: 'DONE', why, closure: { ...closure } }] };
  return { task: next, event: { at: now, project: task.project, task: task.id, event: 'x_flow', from: task.state, to: 'DONE', phase: 'closed',
    closure: KIND, pr: merged.pr, merge: merged.merge } };
}

module.exports = { KIND, version: VERSION, verify, accept, repository };
