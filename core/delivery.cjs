// PR의 실시간 상태를 직접 읽는다. 호출자가 전달한 CI 성공이나 병합 결과는 믿지 않는다.
const { spawnSync } = require('node:child_process');
const { mergeGate } = require('./workflow.cjs');
function execute(cwd, cmd, args, allowFailure = false) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 << 20 });
  if (r.error || (r.status !== 0 && !allowFailure)) throw new Error(`${cmd} 실행 실패: ${r.error?.message ?? r.stderr}`);
  return { code: r.status, text: r.stdout?.trim() ?? '' };
}
function deliver(input, exec = execute) {
  const { cwd, flow, branch, apply = false } = input;
  if (flow?.version !== 2 || !flow.authorization || flow.verification?.verdict!=='PASS' || !flow.delivery || !Number.isInteger(flow.delivery.pr) || !branch || branch==='main') throw new Error('자동 병합 대상 업무·PR이 없다.');
  const git = (...args) => exec(cwd, 'git', args).text;
  const gh = (...args) => exec(cwd, 'gh', args).text;
  const repo = JSON.parse(gh('repo','view','--json','nameWithOwner')).nameWithOwner;
  const urls = git('remote','get-url','--push','--all','origin').split(/\r?\n/);
  const canonical = u => u.replace(/^git@github.com:/,'https://github.com/').replace(/\.git$/,'').toLowerCase();
  if (urls.length!==1 || canonical(urls[0])!==`https://github.com/${repo}`.toLowerCase() || canonical(git('remote','get-url','origin'))!==canonical(urls[0])) throw new Error('fetch·push·GitHub 저장소가 다르다.');
  if (git('branch','--show-current')!==branch || git('rev-parse','HEAD')!==flow.delivery.head) throw new Error('로컬 게시 후보가 바뀌었다.');
  const number = String(flow.delivery.pr);
  const fields = 'number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,baseRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergeCommit,mergedAt';
  const view = () => JSON.parse(gh('pr','view',number,'--repo',repo,'--json',fields));
  const pr = view();
  if (pr.headRefName!==branch || pr.headRefOid!==flow.delivery.head || pr.baseRefName!=='main' || pr.isCrossRepository) throw new Error('PR의 저장소·브랜치·head가 게시 근거와 다르다.');
  const verifyMerged = p => {
    if (p.state!=='MERGED' || !p.mergeCommit?.oid || !p.mergedAt) return null;
    const m=p.mergeCommit.oid;
    git('fetch','--no-write-fetch-head','--no-tags',urls[0],'refs/heads/main');
    const latest=git('ls-remote',urls[0],'refs/heads/main').split(/\s/)[0];
    git('merge-base','--is-ancestor',m,latest);
    const parents=git('show','-s','--format=%P',m).split(' ');
    if (parents.length!==1 || parents[0]!==flow.delivery.base || git('rev-parse',`${m}^{tree}`)!==flow.delivery.tree) throw new Error('병합은 발생했지만 부모·tree 증명이 다르다. 후속 확인 필요');
    return { phase:'merged', pr:p.number, url:p.url, head:pr.headRefOid, merge:m, base:parents[0], tree:flow.delivery.tree };
  };
  const merged=verifyMerged(pr);
  if (merged) return merged;
  // 병합된 PR의 원격 브랜치는 이미 삭제될 수 있다. 열린 PR에서만 head를 가져온다.
  // FETCH_HEAD는 다른 프로세스와 공유하므로 사용하지 않는다.
  git('fetch','--no-write-fetch-head','--no-tags',urls[0],'refs/heads/main',`refs/heads/${branch}`);
  const main = git('ls-remote',urls[0],'refs/heads/main').split(/\s/)[0];
  if (!/^[a-f0-9]{40}$/.test(main)) throw new Error('main SHA 조회 실패');
  // head 조건만으로 base 경쟁은 막을 수 없다. 서버가 최신 main 포함을 강제해야 한다.
  const protection=exec(cwd,'gh',['api',`repos/${repo}/branches/main/protection`],true);
  let protectedBranch; try {protectedBranch=JSON.parse(protection.text);} catch {protectedBranch=null;}
  let strict=protection.code===0 && protectedBranch?.required_status_checks?.strict===true && protectedBranch?.enforce_admins?.enabled===true;
  if (!strict) {
    const effective=exec(cwd,'gh',['api',`repos/${repo}/rules/branches/main`],true);
    let rules;try{rules=JSON.parse(effective.text);}catch{rules=[];}
    for(const rule of Array.isArray(rules)?rules:[]) if(rule.type==='required_status_checks' && rule.parameters?.strict_required_status_checks_policy===true && rule.ruleset_source_type==='Repository') {
      const detail=exec(cwd,'gh',['api',`repos/${repo}/rulesets/${rule.ruleset_id}`],true);
      let set;try{set=JSON.parse(detail.text);}catch{set=null;}
      if(detail.code===0 && set?.enforcement==='active' && Array.isArray(set.bypass_actors) && !set.bypass_actors.length) strict=true;
    }
  }
  if (!strict) {
    return {phase:'blocked',reasons:['자동 병합에는 main strict up-to-date와 관리자 포함 보호가 필요하다. 규칙을 우회하지 않는다.']};
  }
  if (main!==flow.delivery.base || main!==pr.baseRefOid) return { phase:'revalidate', reasons:['main 이동: 동기화·영향 검증 후 게시 근거 갱신'] };
  git('merge-base','--is-ancestor',main,pr.headRefOid);
  const tree=git('merge-tree','--write-tree',main,pr.headRefOid).split(/\r?\n/)[0];
  if (tree!==flow.delivery.tree) throw new Error('예상 병합 tree 불일치');
  const checks=exec(cwd,'gh',['pr','checks',number,'--repo',repo,'--required','--json','name,bucket,state'],true);
  let required; try { required=JSON.parse(checks.text); } catch { required=[]; }
  const gate=mergeGate(flow,pr,required);
  if (!gate.ready || !apply) return { phase:gate.blocked?'blocked':'ci', ...gate, pr:pr.number, head:pr.headRefOid, base:main };
  const fresh=view();
  if (fresh.headRefOid!==pr.headRefOid || fresh.baseRefOid!==main || git('ls-remote',urls[0],'refs/heads/main').split(/\s/)[0]!==main) return { phase:'revalidate', reasons:['병합 직전 head/base 이동'] };
  const latestChecks=exec(cwd,'gh',['pr','checks',number,'--repo',repo,'--required','--json','name,bucket,state'],true);
  let latestRequired; try { latestRequired=JSON.parse(latestChecks.text); } catch { latestRequired=[]; }
  const finalGate=mergeGate(flow,fresh,latestRequired);
  if (!finalGate.ready) return {phase:finalGate.blocked?'blocked':'ci',...finalGate};
  // 서버의 보호 규칙도 그대로 적용한다. admin 우회·강제 병합·브랜치 삭제는 하지 않는다.
  const result=exec(cwd,'gh',['pr','merge',number,'--repo',repo,'--squash','--match-head-commit',pr.headRefOid],true);
  const after=view();
  const proof=verifyMerged(after);
  if (proof) return proof;
  return { phase:result.code===0?'ci':'blocked', ready:false, reasons:[result.code===0 ? '병합 큐/서버 처리 대기' : '병합 거부: 권한·서버 규칙을 확인한 뒤 재개한다'], pr:pr.number };
}
module.exports={ deliver };
