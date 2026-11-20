// PR의 실시간 상태를 직접 읽는다. 호출자가 전달한 CI 성공이나 병합 결과는 믿지 않는다.
const { spawnSync } = require('node:child_process');
const { mergeGate, missingRemaining } = require('./workflow.cjs');
const { verifyPublication, syncHistory, candidateInTree, checksAtHead } = require('./dev14.cjs');
function execute(cwd, cmd, args, allowFailure = false) {
  const blob = cmd === 'git' && args[0] === 'cat-file' && args[1] === 'blob';
  const r = spawnSync(cmd, args, { cwd, encoding: blob ? 'buffer' : 'utf8', windowsHide: true, timeout: 30000, maxBuffer: blob ? 64 << 20 : 4 << 20 });
  if (r.error || (r.status !== 0 && !allowFailure)) throw new Error(`${cmd} 실행 실패: ${r.error?.message ?? r.stderr}`);
  if (blob) return { code: r.status, bytes: r.stdout };
  return { code: r.status, text: r.stdout?.includes('\0') ? r.stdout : r.stdout?.trim() ?? '' };
}
// Record the effective check names and app IDs for a DEV-14 proof. Older
// adapters only need the original strict-up-to-date gate.
function mainProtection(exec, cwd, repo, detailed) {
  function api(path) {
    const res = exec(cwd, 'gh', ['api', 'repos/' + repo + path], true);
    let data;
    try { data = JSON.parse(res.text); } catch { data = null; }
    return { ok: res.code === 0 && data !== null, data };
  }
  const classic = api('/branches/main/protection');
  const classicChecks = classic.ok && classic.data.required_status_checks;
  let strict = classicChecks?.strict === true && classic.data.enforce_admins?.enabled === true;
  const configured = [];
  function addChecks(list) {
    for (const c of list ?? []) {
      const app = c.integration_id ?? c.app_id;
      configured.push({ context: c.context, app: app > 0 ? app : null });
    }
  }
  if (classicChecks) {
    addChecks(classicChecks.checks);
    addChecks((classicChecks.contexts ?? []).map(context => ({context})));
  }
  const needsApproval = p => p?.required_approving_review_count > 0 || p?.require_code_owner_review === true ||
    p?.require_code_owner_reviews === true || p?.require_last_push_approval === true;
  let reviewRequired = needsApproval(classic.data?.required_pull_request_reviews);
  if (!strict || detailed) {
    const effective = api('/rules/branches/main');
    if (detailed && (!effective.ok || !Array.isArray(effective.data) ||
        (!classic.ok && String(classic.data?.status) !== '404'))) return {strict:false, configured, reviewRequired};
    for (const rule of effective.ok && Array.isArray(effective.data) ? effective.data : []) {
      if (rule.type === 'pull_request') reviewRequired ||= needsApproval(rule.parameters);
      if (rule.type !== 'required_status_checks') continue;
      addChecks(rule.parameters?.required_status_checks);
      if (strict || rule.parameters?.strict_required_status_checks_policy !== true || rule.ruleset_source_type !== 'Repository') continue;
      const detail = api('/rulesets/' + rule.ruleset_id);
      if (detail.ok && detail.data.enforcement === 'active' && Array.isArray(detail.data.bypass_actors) && !detail.data.bypass_actors.length) strict = true;
    }
  }
  return {strict, configured, reviewRequired};
}

function deliver(input, exec = execute) {
  const { cwd, flow, branch, apply = false, dev14, proofOnly = false } = input;
  if (proofOnly && (!dev14 || apply)) throw new Error('병합 증명 조회에는 DEV-14 후보가 필요하고 --apply와 함께 쓸 수 없다.');
  if (dev14 && !['ci','merged',...(proofOnly ? ['delivery-blocked'] : [])].includes(flow?.phase)) throw new Error('게시 근거가 있는 v2 단계가 아니다.');
  if (flow?.version !== 2 || !flow.authorization || flow.verification?.verdict!=='PASS' || !flow.delivery || !Number.isInteger(flow.delivery.pr) || !branch || branch==='main') throw new Error('자동 병합 대상 업무·PR이 없다.');
  const git = (...args) => {
    const compare = dev14 && (args[0]==='merge-tree' || (args[0]==='merge-base' && args[1]!=='--is-ancestor'));
    const result = exec(cwd,'git',args,Boolean(compare));
    if (compare && result.code===1) return ''; // conflict or no common ancestor
    if (result.code!==0) throw Error('Git 조회 실패: ' + args[0]);
    return result.text;
  };
  const gh = (...args) => exec(cwd, 'gh', args).text;
  const repo = JSON.parse(gh('repo','view','--json','nameWithOwner')).nameWithOwner;
  const urls = git('remote','get-url','--push','--all','origin').split(/\r?\n/);
  const canonical = u => u.replace(/^git@github.com:/,'https://github.com/').replace(/\.git$/,'').toLowerCase();
  if (urls.length!==1 || canonical(urls[0])!==`https://github.com/${repo}`.toLowerCase() || canonical(git('remote','get-url','origin'))!==canonical(urls[0])) throw new Error('fetch·push·GitHub 저장소가 다르다.');
  // A later ls-remote can name a newer commit that a completed fetch never saw.
  // Read main once and fetch that exact object, without sharing FETCH_HEAD.
  const fetchMain = (...refs) => {
    const main=git('ls-remote',urls[0],'refs/heads/main').split(/\s/)[0];
    if (!/^[a-f0-9]{40}$/.test(main)) throw Error('main SHA 조회 실패');
    git('fetch','--no-write-fetch-head','--no-tags',urls[0],main,...refs);
    return main;
  };
  if (!proofOnly && (git('branch','--show-current')!==branch || (!dev14 && git('rev-parse','HEAD')!==flow.delivery.head))) throw new Error('로컬 게시 후보가 바뀌었다.');
  const number = String(flow.delivery.pr);
  const fields = 'number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,baseRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergeCommit,mergedAt,body';
  const view = () => JSON.parse(gh('pr','view',number,'--repo',repo,'--json',fields));
  const pr = view();
  const samePR = p => p.number===flow.delivery.pr && p.headRefName===branch && p.baseRefName==='main' && (dev14 ? p.isCrossRepository===false : !p.isCrossRepository);
  if (!samePR(pr) || (!dev14 && pr.headRefOid!==flow.delivery.head)) throw new Error('PR의 저장소·브랜치·head가 게시 근거와 다르다.');
  if (proofOnly && pr.state !== 'MERGED') return { phase:'not-merged', pr:pr.number };
  const getChecks = () => {
    const r=exec(cwd,'gh',['pr','checks',number,'--repo',repo,'--required','--json',dev14?'name,bucket,state,link':'name,bucket,state'],true);
    if (![0,1,8].includes(r.code)) return [];
    try {
      const list=JSON.parse(r.text);
      return Array.isArray(list) && (r.code===0 || list.some(c=>c.bucket!=='pass')) ? list : [];
    } catch { return []; }
  };
  let publication, policy;
  if (dev14) {
    git('fetch','--no-write-fetch-head','--no-tags',urls[0],`refs/pull/${number}/head`);
    publication=verifyPublication(git, oid => exec(cwd,'git',['cat-file','blob',oid]).bytes, flow, dev14);
    policy=mainProtection(exec,cwd,repo,true);
  }
  const verifyMerged = p => {
    if (p.state!=='MERGED' || !p.mergeCommit?.oid || !p.mergedAt) return null;
    if (!samePR(p) || (!dev14 && p.headRefOid!==flow.delivery.head)) throw new Error('병합된 PR의 head·저장소·브랜치가 바뀌었다.');
    const m=p.mergeCommit.oid;
    const latest=fetchMain(...(dev14 ? [p.headRefOid] : []));
    const ancestry=exec(cwd,'git',['merge-base','--is-ancestor',m,latest],true);
    if (dev14 && ancestry.code===1) return {phase:'proof-blocked',pr:p.number,merge:m,mainContainsMerge:false,reasons:['병합 커밋이 현재 main에 없다.']};
    if (ancestry.code!==0) throw Error('현재 main의 병합 커밋 포함 여부를 확인할 수 없다.');
    const parents=git('show','-s','--format=%P',m).split(' ');
    if (dev14) {
      if (parents.length!==1) return {phase:'proof-blocked', pr:p.number, merge:m, reasons:['squash 병합 부모가 아니다.']};
      const base=parents[0], tree=git('rev-parse',m+'^{tree}');
      const exactCandidate=candidateInTree(git,publication,base,tree);
      const computed=exec(cwd,'git',['merge-tree','--write-tree',base,p.headRefOid],true);
      if (![0,1].includes(computed.code)) throw Error('예상 병합 tree 조회 실패');
      const exactTree=computed.code===0 && computed.text===tree;
      const {reasons}=syncHistory(git,publication,p.headRefOid,base);
      const required=getChecks();
      const passed=checksAtHead(gh,repo,p.headRefOid,required,policy.configured);
      const drifted=base!==publication.original.base || p.headRefOid!==publication.original.head;
      if (drifted && git('merge-base',base,p.headRefOid)!==base) reasons.push('최종 PR head가 squash 부모 main을 포함하지 않는다.');
      if (!exactCandidate || !exactTree) reasons.push('QA 후보 변경·모드 또는 전체 예상 병합 tree 불일치');
      if (!policy.strict) reasons.push('strict main 보호 근거 불충분');
      if (!passed || ['CHANGES_REQUESTED','REVIEW_REQUIRED'].includes(p.reviewDecision) ||
          (policy.reviewRequired && p.reviewDecision!=='APPROVED')) reasons.push('최종 PR 필수 CI·리뷰 근거 불충분');
      // PR 브랜치 이름도 증명에 묶는다. 저장소 정리는 이 이름과 head가 같은 로컬 업무 브랜치만 지운다.
      const proof={pr:p.number,url:p.url,head:p.headRefOid,branch:p.headRefName,merge:m,base,tree,original:publication.original,
        candidate:dev14.candidate.fingerprint,mainContainsMerge:true,exactCandidate,exactTree,requiredChecksPassed:passed};
      return reasons.length ? {phase:'proof-blocked',...proof,reasons} : {phase:'merged',...proof};
    }
    if (parents.length!==1 || parents[0]!==flow.delivery.base || git('rev-parse',`${m}^{tree}`)!==flow.delivery.tree) throw new Error('병합은 발생했지만 부모·tree 증명이 다르다. 후속 확인 필요');
    return { phase:'merged', pr:p.number, url:p.url, head:pr.headRefOid, branch:p.headRefName, merge:m, base:parents[0], tree:flow.delivery.tree };
  };
  const merged=verifyMerged(pr);
  if (merged) return merged;
  if (proofOnly) return {phase:'proof-blocked',pr:pr.number,reasons:['서버 병합 SHA·시각 근거 불충분']};
  // 동결 계획의 후속 확인이 PR 본문 남은 검증에 모두 있어야 병합한다. 이미 병합된 PR의 증명에는 적용하지 않는다.
  const bodyGap = p => {
    const missing = missingRemaining(flow.plan, p.body).map(m=>m.line);
    return missing.length ? {phase:'blocked',ready:false,pr:p.number,missing,reasons:['PR 본문 남은 검증 누락: '+missing.join(' / ')]} : null;
  };
  const gap = bodyGap(pr);
  if (gap) return gap;
  // 병합된 PR의 원격 브랜치는 이미 삭제될 수 있다. 열린 PR에서만 head를 가져온다.
  // FETCH_HEAD는 다른 프로세스와 공유하므로 사용하지 않는다.
  const main = fetchMain(`refs/heads/${branch}`);
  // head 조건만으로 base 경쟁은 막을 수 없다. 서버가 최신 main 포함을 강제해야 한다.
  policy ??= mainProtection(exec,cwd,repo,false);
  if (!policy.strict || (dev14 && !policy.configured.length)) {
    return {phase:'blocked',reasons:['자동 병합에는 main strict up-to-date와 관리자 포함 보호가 필요하다. 규칙을 우회하지 않는다.']};
  }
  let effectiveFlow=flow;
  if (dev14) {
    if (pr.state!=='OPEN' || pr.isDraft || !['ci','merged'].includes(flow.phase)) return {phase:'blocked',reasons:['열린 게시 후보가 아니다.']};
    if (apply && dev14.mergeAuthorized!==true) return {phase:'blocked',reasons:['업무별 동기화·병합 권한 확인 필요']};
    if (main!==pr.baseRefOid) return {phase:'ci',ready:false,reasons:['원격 main과 PR base 갱신 대기']};
    const history=syncHistory(git,publication,pr.headRefOid,main);
    if (history.reasons.length) return {phase:'revalidate',reasons:history.reasons};
    if (!history.heads.has(git('rev-parse','HEAD'))) throw new Error('로컬 HEAD는 검증된 게시·동기화 계보에 없다.');
    const merge=exec(cwd,'git',['merge-tree','--write-tree',main,pr.headRefOid],true);
    if (merge.code===1) return {phase:'revalidate',reasons:['main·PR 병합 충돌']};
    if (merge.code!==0 || !/^[a-f0-9]{40}$/.test(merge.text)) throw new Error('예상 병합 tree 조회 실패');
    if (!candidateInTree(git,publication,main,merge.text)) return {phase:'revalidate',reasons:['동기화 결과가 QA 후보 경로·모드와 다르다.']};
    if (git('merge-base',main,pr.headRefOid)!==main) {
      const pending={phase:'ci',ready:false,pr:pr.number,head:pr.headRefOid,base:main};
      if (!apply) return {...pending,reasons:['DEV-14 동기화 가능']};
      const fresh=view();
      if (!samePR(fresh) || fresh.state!=='OPEN' || fresh.isDraft || fresh.headRefOid!==pr.headRefOid || fresh.baseRefOid!==main ||
          git('ls-remote',urls[0],`refs/heads/${branch}`).split(/\s/)[0]!==pr.headRefOid ||
          git('ls-remote',urls[0],'refs/heads/main').split(/\s/)[0]!==main) return {...pending,reasons:['동기화 직전 ref 이동 · 다시 조회']};
      // Both parents are pinned. A later main tip cannot silently enter this commit.
      const sync=git('commit-tree',merge.text,'-p',pr.headRefOid,'-p',main,'-m',`Sync main for PR #${number} (DEV-14)`);
      if (!/^[a-f0-9]{40}$/.test(sync)) throw new Error('동기화 커밋 생성 실패');
      const push=exec(cwd,'git',['push','--no-follow-tags',urls[0],`${sync}:refs/heads/${branch}`],true);
      const remote=git('ls-remote',urls[0],`refs/heads/${branch}`).split(/\s/)[0];
      if (remote===sync) return {...pending,syncHead:sync,reasons:['동기화 완료 · 새 PR head의 필수 CI 대기']};
      if (remote!==pr.headRefOid) return {...pending,reasons:['동기화 중 원격 head 변경 · 다시 조회']};
      return {phase:'blocked',reasons:[push.code===0?'동기화 push 미확인':'동기화 push 거부']};
    }
    effectiveFlow={...flow,delivery:{...flow.delivery,head:pr.headRefOid,base:main,tree:merge.text}};
  } else if (main!==flow.delivery.base || main!==pr.baseRefOid) return { phase:'revalidate', reasons:['main 이동: 동기화·영향 검증 후 게시 근거 갱신'] };
  git('merge-base','--is-ancestor',main,pr.headRefOid);
  const tree=git('merge-tree','--write-tree',main,pr.headRefOid).split(/\r?\n/)[0];
  if (tree!==effectiveFlow.delivery.tree) throw new Error('예상 병합 tree 불일치');
  const assess = (p, checks) => {
    if (!dev14) return mergeGate(effectiveFlow,p,checks);
    if (policy.reviewRequired && p.reviewDecision!=='APPROVED') return {ready:false,blocked:true,reasons:['필수 리뷰 미충족']};
    // Missing checks on a newly pushed head are pending. Keep any failures
    // and review/conflict blockers in the shared gate.
    if (p.headRefOid!==publication.original.head) {
      const missing=policy.configured.some(c=>!checks.some(r=>r.name===c.context));
      if (missing || !p.statusCheckRollup?.length) {
        const rollup=p.statusCheckRollup?.length ? p.statusCheckRollup : [{status:'QUEUED'}];
        const waiting=mergeGate(effectiveFlow,{...p,statusCheckRollup:rollup},[...checks,{bucket:'pending'}]);
        return {...waiting,reasons:['동기화 head에 필수 CI 등록 대기',...waiting.reasons]};
      }
    }
    const gate=mergeGate(effectiveFlow,p,checks);
    if (gate.ready && !checksAtHead(gh,repo,p.headRefOid,checks,policy.configured)) return {ready:false,blocked:false,reasons:['최종 head에 연결된 필수 CI 성공 근거 대기']};
    return gate;
  };
  const gate=assess(pr,getChecks());
  if (!gate.ready || !apply) return { phase:gate.blocked?'blocked':'ci', ...gate, pr:pr.number, head:pr.headRefOid, base:main };
  const fresh=view();
  if (fresh.state==='MERGED') return verifyMerged(fresh) ?? {phase:'ci',ready:false,reasons:['서버 병합 증명 대기']};
  if (!samePR(fresh) || fresh.headRefOid!==pr.headRefOid || fresh.baseRefOid!==main || git('ls-remote',urls[0],'refs/heads/main').split(/\s/)[0]!==main) return { phase:dev14?'ci':'revalidate',ready:false,reasons:['병합 직전 head/base 이동'] };
  const freshGap=bodyGap(fresh);
  if (freshGap) return freshGap;
  const finalGate=assess(fresh,getChecks());
  if (!finalGate.ready) return {phase:finalGate.blocked?'blocked':'ci',...finalGate};
  // 서버의 보호 규칙도 그대로 적용한다. admin 우회·강제 병합·브랜치 삭제는 하지 않는다.
  const result=exec(cwd,'gh',['pr','merge',number,'--repo',repo,'--squash','--match-head-commit',pr.headRefOid],true);
  const after=view();
  const proof=verifyMerged(after);
  if (proof) return proof;
  return { phase:result.code===0?'ci':'blocked', ready:false, reasons:[result.code===0 ? '병합 큐/서버 처리 대기' : '병합 거부: 권한·서버 규칙을 확인한 뒤 재개한다'], pr:pr.number };
}
module.exports={ deliver, dev14Version:1 };
