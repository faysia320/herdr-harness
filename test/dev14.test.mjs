import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { deliver }=createRequire(import.meta.url)('../core/delivery.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const url='https://github.com/fixture/dev14.git';

// Only GitHub responses are simulated. Git computes the graph, merge trees, file
// modes and binary blobs and pushes normally to a disposable bare repository.
// opts.file은 후보가 추가하는 파일, opts.baseFiles는 기준 커밋에 미리 두는 파일이다. mainPath가 null이면 main을 움직이지 않는다.
function fixture(t, mainPath='docs/readme.md', opts={}) {
  const root=fs.mkdtempSync(join(tmpdir(),'herdr-dev14-')), remote=join(root,'remote.git'), cwd=join(root,'repo');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3}));
  fs.mkdirSync(cwd);
  function run(args, allow=false, blob=false) {
    const r=spawnSync('git',args,{cwd,encoding:blob?null:'utf8',windowsHide:true});
    if (r.error || (r.status && !allow)) throw Error('git '+args.join(' ')+': '+r.stderr);
    return blob?{code:r.status,bytes:r.stdout}:{code:r.status,text:r.stdout.includes('\0')?r.stdout:r.stdout.trim()};
  }
  const git=(...args)=>run(args).text;
  git('init','--bare',remote); git('init','-b','main');
  git('config','user.name','Dev14 Fixture'); git('config','user.email','dev14@example.invalid');
  git('config','core.autocrlf','false');
  fs.writeFileSync(join(cwd,'old.txt'),'delete me');
  for (const file of opts.baseFiles??[]) { fs.mkdirSync(join(cwd,file,'..'),{recursive:true}); fs.writeFileSync(join(cwd,file),'base '+file); }
  git('add','-A'); git('commit','-m','base');
  const base=git('rev-parse','HEAD');
  git('switch','-c','topic');
  const bytes=Buffer.from([0,13,10,255,42]);
  const binary=opts.file??'payload with spaces.bin';
  fs.mkdirSync(join(cwd,binary,'..'),{recursive:true}); fs.writeFileSync(join(cwd,binary),bytes); git('rm','old.txt'); git('add','--',binary);
  git('update-index','--chmod=+x','--',binary); git('commit','-m','QA candidate');
  const head=git('rev-parse','HEAD'), tree=git('rev-parse','HEAD^{tree}');
  const candidate={head,x_base:base,paths:[
    {path:'old.txt',status:'DELETED',mode:null,sha256:null},
    {path:binary,status:'A',mode:'100755',sha256:sha(bytes)}].sort((a,b)=>a.path<b.path?-1:1)};
  candidate.fingerprint=sha(JSON.stringify({head,base,paths:candidate.paths.map(p=>[p.path,p.status,p.mode,p.sha256])}));
  git('push',remote,'topic','main');
  const mainDir=join(root,'main');
  git('worktree','add',mainDir,'main');
  function advance(file) {
    const dest=join(mainDir,file); fs.mkdirSync(join(dest,'..'),{recursive:true}); fs.writeFileSync(dest,'upstream');
    git('-C',mainDir,'add','--',file); git('-C',mainDir,'commit','-m','advance'); git('-C',mainDir,'push',remote,'main');
  }
  if (mainPath) advance(mainPath);
  const flow={version:2,phase:'ci',authorization:'조건부 병합',verification:{verdict:'PASS',candidate:candidate.fingerprint},delivery:{pr:7,head,base,tree}};
  const input={cwd,branch:'topic',flow,dev14:{candidate,mergeAuthorized:true},apply:true};
  const tip=branch=>fs.readFileSync(join(remote,'refs','heads',branch),'utf8').trim();
  const state={merged:null,finalHead:null,passed:false,wrongCI:false,review:'APPROVED',pushes:0,merges:0,strict:true,views:0,onView:null,beforeMerge:null};
  function squash(override) {
    const h=tip('topic'), b=tip('main');
    const m=git('commit-tree',override??git('merge-tree','--write-tree',b,h),'-p',b,'-m','squash');
    git('push',remote,m+':refs/heads/main');
    state.merged=m; state.finalHead=h;
  }
  function exec(_,cmd,args,allow) {
    if (cmd==='git') {
      if (args[0]==='remote') return {code:0,text:url};
      if (args[0]==='push') state.pushes++;
      const local=args.map(arg=>arg===url?remote:arg);
      // The fixture retains the synthetic PR ref just as the provider does after deletion.
      if (args[0]==='fetch' && args.includes('refs/pull/7/head')) {
        git('--git-dir='+remote,'update-ref','refs/pull/7/head',state.finalHead??tip('topic'));
      }
      return run(local,allow,args[0]==='cat-file');
    }
    const call=args.join(' ');
    if (call.startsWith('pr view')) state.onView?.(++state.views);
    const h=state.finalHead??tip('topic'), b=state.staleBase??tip('main');
    const link='https://fixture.invalid/jobs/42';
    if (call.startsWith('api -X PATCH') && call.endsWith('pulls/7 -f base=main')) { state.baseRefreshes=(state.baseRefreshes??0)+1; state.staleBase=null; return result({}); }
    if (call.startsWith('repo view')) return result({nameWithOwner:'fixture/dev14'});
    if (call.startsWith('api ') && call.includes('/branches/main/protection')) return result({required_status_checks:{strict:state.strict,checks:[{context:'CI',app_id:42}]},enforce_admins:{enabled:true}});
    if (call.endsWith('/rules/branches/main')) return result([]);
    if (call.includes('/check-runs?')) return result([{check_runs:[{name:'CI',app:{id:state.wrongApp?99:42},head_sha:state.wrongCI?head:h,status:'completed',conclusion:'success',details_url:link}]}]);
    if (call.includes('/status?')) return result({sha:h,statuses:[]});
    if (call.startsWith('pr checks')) return result(state.noChecks?[]:[{name:'CI',bucket:state.passed?'pass':'pending',state:state.passed?'SUCCESS':'PENDING',link}]);
    if (call.startsWith('pr view')) return result({number:7,url:url+'/pull/7',state:state.merged?'MERGED':'OPEN',isDraft:false,isCrossRepository:false,
      headRefName:'topic',headRefOid:h,baseRefName:'main',baseRefOid:b,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',
      reviewDecision:state.review,statusCheckRollup:state.noChecks?[]:[{status:state.passed?'COMPLETED':'IN_PROGRESS',conclusion:state.passed?'SUCCESS':null}],
      mergeCommit:state.merged&&{oid:state.merged},mergedAt:state.merged&&'2026-11-19T01:00:00Z'});
    if (call.startsWith('pr merge')) {
      state.beforeMerge?.();
      // 서버는 --match-head-commit이 현재 head와 다르면 병합하지 않는다.
      if (args.at(-1)!==tip('topic')) return {code:1,text:''};
      state.merges++; squash(); return result({});
    }
    throw Error('unexpected call: '+call);
  }
  function result(data) {return {text:JSON.stringify(data),code:0};}
  return {query:(patch={},wrap=exec=>exec)=>deliver({...input,...patch},wrap(exec)),input,state,advance,tip,git,remote,head,base,binary,squash,mainDir};
}

test('독립 main 이동 두 번, 새 head CI·리뷰·권한을 확인하고 한 번만 squash한다',t=>{
  const f=fixture(t);
  // GitHub이 PR base SHA를 늦게 갱신하면 apply가 같은 base로 다시 지정해 갱신을 요청하고 기다린다. 조회만 하는 호출은 요청하지 않는다.
  f.state.staleBase='0'.repeat(40);
  assert.match(f.query({apply:false}).reasons[0],/PR base 갱신 대기/); assert.equal(f.state.baseRefreshes,undefined);
  assert.match(f.query().reasons[0],/PR base 갱신 대기/); assert.deepEqual([f.state.baseRefreshes,f.state.staleBase,f.state.pushes],[1,null,0]);
  assert.match(f.query({apply:false}).reasons[0],/동기화 가능/);
  assert.equal(f.query({dev14:{candidate:f.input.dev14.candidate}}).phase,'blocked');
  assert.equal(f.query({proofOnly:true,apply:false}).phase,'not-merged');
  assert.equal(f.state.pushes,0);
  const first=f.query(); assert.equal(first.syncHead,f.tip('topic'));
  f.state.noChecks=true; assert.match(f.query().reasons[0],/등록 대기/); f.state.noChecks=false;
  assert.equal(f.query().phase,'ci'); assert.equal(f.state.pushes,1);
  f.advance('docs/other.md');
  const second=f.query(); assert.equal(second.syncHead,f.tip('topic')); assert.notEqual(first.syncHead,second.syncHead);
  f.state.passed=true; f.state.wrongCI=true;
  assert.equal(f.query({apply:false}).ready,false); assert.equal(f.query().ready,false);
  f.state.wrongCI=false; f.state.wrongApp=true; assert.equal(f.query().ready,false);
  f.state.wrongApp=false; f.state.review='REVIEW_REQUIRED';
  assert.equal(f.query().phase,'blocked'); assert.equal(f.state.merges,0);
  f.state.review='APPROVED';
  const proof=f.query(); assert.equal(proof.phase,'merged'); assert.equal(proof.exactCandidate,true);
  assert.equal(proof.base,f.git('rev-parse','main')); assert.equal(proof.original.head,f.head);
  f.git('--git-dir='+f.remote,'update-ref','-d','refs/heads/topic');
  const replay=f.query({proofOnly:true,apply:false,cwd:f.mainDir,flow:{...f.input.flow,phase:'merged',delivery:proof}});
  assert.equal(replay.merge,proof.merge); assert.deepEqual([f.state.pushes,f.state.merges],[2,1]);
});

// H1: main 이동 재검증은 경로 겹침·병합 충돌·병합 결과 불일치로만 한다. lockfile·CI·설정 같은 경로 종류만으로는 재QA하지 않는다.
test('겹치지 않는 main 변경은 lockfile·CI·설정·어댑터 민감 경로여도 ci에 머물러 동기화한다',t=>{
  for(const p of ['Cargo.lock','.github/workflows/verify.yml','crates/workspace-contracts/src/lib.rs','team/shared.rules']){
    const f=fixture(t,p);
    f.input.dev14.sensitivePaths=['team/shared.rules'];
    const r=f.query({apply:false});
    assert.deepEqual([r.phase,r.reasons[0]],['ci','DEV-14 동기화 가능'],p);
    assert.deepEqual([f.state.pushes,f.state.merges],[0,0]);
  }
  // PR 쪽 후보가 package.json·.agents여도 같다.
  for(const file of ['package.json','.agents/harness/config.json']){
    const f=fixture(t,'pnpm-lock.yaml',{file});
    assert.equal(f.query({apply:false}).phase,'ci',file);
  }
});

test('후보 경로가 겹치거나 main·PR 병합이 충돌하면 쓰기 전에 재QA로 돌린다',t=>{
  const overlap=fixture(t,'payload with spaces.bin');
  const r=overlap.query();
  assert.equal(r.phase,'revalidate'); assert.match(r.reasons[0],/QA 경로 겹침: payload with spaces\.bin/);
  assert.deepEqual([overlap.state.pushes,overlap.state.merges],[0,0]);
  // 경로가 겹치지 않아도 main의 디렉터리 이동이 후보의 새 파일 위치와 충돌하면 겹침 분기와 별개로 재QA한다.
  const conflict=fixture(t,null,{file:'a/new.bin',baseFiles:['a/x.txt']});
  conflict.git('-C',conflict.mainDir,'mv','a','b'); conflict.git('-C',conflict.mainDir,'commit','-m','rename a to b');
  conflict.git('-C',conflict.mainDir,'push',conflict.remote,'main');
  const c=conflict.query();
  assert.deepEqual([c.phase,c.reasons],['revalidate',['main·PR 병합 충돌']]);
  assert.deepEqual([conflict.state.pushes,conflict.state.merges],[0,0]);
});

test('strict 흐름은 lockfile main 변경을 동기화하고 새 head CI 통과 뒤 squash·사후 증명을 마친다',t=>{
  const f=fixture(t,'pnpm-lock.yaml');
  const first=f.query(); assert.equal(first.syncHead,f.tip('topic'));
  f.state.passed=true;
  const proof=f.query(); assert.equal(proof.phase,'merged'); assert.ok(proof.exactCandidate && proof.exactTree && proof.requiredChecksPassed);
  assert.deepEqual([f.state.pushes,f.state.merges],[1,1]);
  const replay=f.query({proofOnly:true,apply:false});
  assert.equal(replay.phase,'merged'); assert.throws(()=>f.query({proofOnly:true}),/apply/);
});

// H3: strict up-to-date가 꺼진 규칙도 조회로 확인되면 동기화 없이 확인한 head를 --match-head-commit으로 한 번 병합한다.
test('strict-off 규칙은 동기화 없이 확인한 head를 한 번 squash하고 사후 증명한다',t=>{
  const f=fixture(t); f.state.strict=false; f.state.passed=true;
  const dry=f.query({apply:false}); assert.deepEqual([dry.phase,dry.ready],['ci',true]);
  const proof=f.query();
  assert.equal(proof.phase,'merged'); assert.ok(proof.exactCandidate && proof.exactTree && proof.requiredChecksPassed);
  assert.equal(proof.head,f.head); assert.equal(proof.base,f.git('rev-parse',proof.merge+'^'));
  assert.deepEqual([f.state.pushes,f.state.merges],[0,1]);
  assert.equal(f.query({proofOnly:true,apply:false}).phase,'merged');
  // strict-off에서도 겹침은 재QA다.
  const overlap=fixture(t,'payload with spaces.bin'); overlap.state.strict=false; overlap.state.passed=true;
  assert.equal(overlap.query().phase,'revalidate'); assert.equal(overlap.state.merges,0);
});

// 저장소 ruleset만 있는 main. strict 값과 ruleset 상세 조회 결과(code)를 바꾼다. 403은 토큰 권한 부족 응답이다.
const ruleQuery=(strict,detailCode)=>exec=>(cwd,cmd,args,allow)=>{
  if (cmd==='gh' && args[0]==='api') {
    if (args[1].endsWith('/branches/main/protection')) return {code:1,text:JSON.stringify({status:'404'})};
    if (args[1].endsWith('/rules/branches/main')) return {code:0,text:JSON.stringify([{type:'required_status_checks',ruleset_source_type:'Repository',ruleset_id:99,
      parameters:{strict_required_status_checks_policy:strict,required_status_checks:[{context:'CI',integration_id:42}]}}])};
    if (args[1].endsWith('/rulesets/99')) return {code:detailCode,text:JSON.stringify({status:'403'})};
  }
  return exec(cwd,cmd,args,allow);
};
test('strict ruleset을 확정하지 못하면 느슨한 병합·사후 증명을 하지 않고, 확인된 strict-off ruleset은 병합한다',t=>{
  // strict_required_status_checks_policy=true인데 ruleset 상세가 403이면 strict-off로 보지 않는다.
  const denied=fixture(t); denied.state.passed=true;
  const r=denied.query({},ruleQuery(true,1));
  assert.equal(r.phase,'blocked'); assert.deepEqual([denied.state.pushes,denied.state.merges],[0,0]);
  // 서버가 다른 경로로 병합해도 strict 근거 미확정이면 사후 자동 종결을 하지 않는다.
  denied.squash();
  const proof=denied.query({proofOnly:true,apply:false},ruleQuery(true,1));
  assert.equal(proof.phase,'proof-blocked'); assert.ok(proof.reasons.includes('main 보호 규칙 조회 근거 불충분'));
  // 관리자 우회가 가능한 classic strict 보호도 확정이 아니다.
  const admins=fixture(t); admins.state.passed=true;
  const bypass=admins.query({},exec=>(cwd,cmd,args,allow)=>cmd==='gh' && args[0]==='api' && args[1].endsWith('/branches/main/protection') ?
    {code:0,text:JSON.stringify({required_status_checks:{strict:true,checks:[{context:'CI',app_id:42}]},enforce_admins:{enabled:false}})} : exec(cwd,cmd,args,allow));
  assert.equal(bypass.phase,'blocked'); assert.deepEqual([admins.state.pushes,admins.state.merges],[0,0]);
  // 명시적 strict-off ruleset은 상세 조회와 무관하게 동기화 없이 한 번 병합하고 사후 증명한다.
  const off=fixture(t); off.state.passed=true;
  assert.equal(off.query({},ruleQuery(false,1)).phase,'merged'); assert.deepEqual([off.state.pushes,off.state.merges],[0,1]);
  assert.equal(off.query({proofOnly:true,apply:false},ruleQuery(false,1)).phase,'merged');
});

test('strict-off에서 병합 직전 main·head가 확인한 SHA와 다르면 병합하지 않는다',t=>{
  // 마지막 조회 직전에 main이 움직이면 병합 0회.
  const moved=fixture(t); moved.state.strict=false; moved.state.passed=true;
  moved.state.onView=n=>{ if(n===2) moved.advance('docs/late.md'); };
  const r=moved.query(); assert.deepEqual([r.phase,r.reasons],['ci',['병합 직전 head/base 이동']]); assert.equal(moved.state.merges,0);
  // 마지막 조회 직전에 head가 움직여도 병합 0회.
  const pushed=fixture(t); pushed.state.strict=false; pushed.state.passed=true;
  pushed.state.onView=n=>{ if(n===2) pushed.git('push',pushed.remote,pushed.git('commit-tree',pushed.git('rev-parse',pushed.head+'^{tree}'),'-p',pushed.head,'-m','late')+':refs/heads/topic'); };
  assert.equal(pushed.query().phase,'ci'); assert.equal(pushed.state.merges,0);
  // 조회 뒤 서버 요청 직전에 head가 바뀌면 --match-head-commit이 병합을 거부한다.
  const raced=fixture(t); raced.state.strict=false; raced.state.passed=true;
  raced.state.beforeMerge=()=>raced.git('push',raced.remote,raced.git('commit-tree',raced.git('rev-parse',raced.head+'^{tree}'),'-p',raced.head,'-m','race')+':refs/heads/topic');
  const x=raced.query(); assert.equal(x.phase,'blocked'); assert.match(x.reasons[0],/병합 거부/); assert.equal(raced.state.merges,0);
});

test('임의 head·틀린 QA 지문·후보 외 파일이 든 실제 squash는 거부한다',t=>{
  const f=fixture(t);
  f.input.dev14.candidate.paths[1].sha256='0'.repeat(64);
  assert.throws(()=>f.query(),/지문/);
  f.input.dev14.candidate.paths[1].sha256=sha(Buffer.from([0,13,10,255,42]));
  const unreviewed=f.git('commit-tree',f.input.flow.delivery.tree,'-p',f.head,'-m','unreviewed');
  f.git('push',f.remote,unreviewed+':refs/heads/topic'); assert.equal(f.query().phase,'revalidate');
  f.state.passed=true; f.squash(f.git('rev-parse','main^{tree}'));
  const p=f.query({proofOnly:true,apply:false}); assert.equal(p.phase,'proof-blocked');
  assert.equal(p.exactTree,false); assert.equal(p.exactCandidate,false);
  assert.deepEqual([f.state.pushes,f.state.merges],[0,0]);
});

// QA 실행 영수증 v2의 후보 지문. CI는 merge-base(main, PR head)에서 head까지의 raw 행으로 다시 계산한다.
test('QA 후보 지문은 독립 main 동기화·rebase 뒤에도 같고 후보 경로·기준이 바뀌면 달라진다',t=>{
  const { candidateBinding }=createRequire(import.meta.url)('../core/qa-receipt-policy.cjs');
  const cwd=fs.mkdtempSync(join(tmpdir(),'herdr-binding-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true,maxRetries:3}));
  const run=args=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});if(r.status)throw Error(args.join(' ')+': '+r.stderr);return r.stdout.includes('\0')?r.stdout:r.stdout.trim();};
  const git=(...args)=>run(args);
  git('init','-q','-b','main'); git('config','user.name','Binding Fixture'); git('config','user.email','binding@example.invalid'); git('config','core.autocrlf','false');
  // mode는 index에서만 바꾼다. Linux(filemode=true)에서도 작업 사본 실행 비트를 변경으로 보지 않게 한다.
  git('config','core.filemode','false');
  const write=(file,text)=>{fs.mkdirSync(join(cwd,file,'..'),{recursive:true});fs.writeFileSync(join(cwd,file),text);};
  for(const file of ['keep.txt','old.txt','tool.sh','dir/a.txt']) write(file,file+'\n');
  git('add','-A'); git('commit','-q','-m','base');
  const B=git('rev-parse','HEAD');
  git('switch','-q','-c','topic');
  write('keep.txt','changed\n'); git('rm','-q','old.txt'); git('mv','dir/a.txt','dir/b.txt');
  fs.writeFileSync(join(cwd,'payload with spaces.bin'),Buffer.from([0,13,10,255]));
  write('한글 이름.txt','값\n');
  git('add','-A'); git('update-index','--chmod=+x','tool.sh'); git('update-index','--chmod=+x','payload with spaces.bin');
  git('commit','-q','-m','candidate');
  const H0=git('rev-parse','HEAD');
  const qa=candidateBinding(git,B,B,H0);
  // 수정·삭제·이동(삭제+추가)·바이너리·mode·한글 경로가 모두 행으로 남는다.
  assert.deepEqual(qa.paths,['dir/a.txt','dir/b.txt','keep.txt','old.txt','payload with spaces.bin','tool.sh','한글 이름.txt']);
  assert.equal(qa.count,7);
  const advance=(file,text)=>{git('switch','-q','main');write(file,text);git('add','-A');git('commit','-q','-m','advance '+file);git('switch','-q','topic');return git('rev-parse','main');};
  const sync=main=>{const head=git('rev-parse','HEAD');const merged=git('commit-tree',git('merge-tree','--write-tree',head,main),'-p',head,'-p',main,'-m','sync');git('reset','-q','--hard',merged);return merged;};
  const ci=(head,main)=>candidateBinding(git,B,git('merge-base',main,head),head);
  // PR이 main보다 뒤처져 있어도(동기화 전) merge-base가 B라 같다.
  let main=advance('docs/one.md','one\n');
  assert.equal(ci(H0,main).digest,qa.digest);
  // 독립 main 변경을 두 번 동기화해도 같다.
  const S1=sync(main);
  assert.equal(ci(S1,main).digest,qa.digest);
  main=advance('docs/two.md','two\n');
  const S2=sync(main);
  assert.deepEqual([ci(S2,main).digest,ci(S2,main).count],[qa.digest,qa.count]);
  // 겹치지 않는 rebase도 같다.
  const rebased=git('commit-tree',git('merge-tree','--write-tree',main,H0),'-p',main,'-m','rebased');
  assert.equal(ci(rebased,main).digest,qa.digest);
  // 영수증 기준 base가 다르면 같은 행이어도 지문이 다르다.
  assert.notEqual(candidateBinding(git,main,main,rebased).digest,qa.digest);
  // main이 후보 경로를 바꾸면 그 행의 이전 blob이 달라져 무효다.
  main=advance('keep.txt','upstream\n');
  const conflict=git('commit-tree',git('rev-parse',S2+'^{tree}'),'-p',S2,'-p',main,'-m','sync keeps candidate bytes');
  assert.notEqual(ci(conflict,main).digest,qa.digest);
  // QA 뒤 PR에 파일을 더하거나 후보 파일을 바꾸면 무효다.
  git('reset','-q','--hard',S2); write('extra.txt','late\n'); git('add','-A'); git('commit','-q','-m','late');
  assert.equal(ci(git('rev-parse','HEAD'),git('rev-parse','HEAD~1^2')).count,8);
  git('reset','-q','--hard',S2); write('keep.txt','edited after QA\n'); git('commit','-qam','edit');
  assert.notEqual(ci(git('rev-parse','HEAD'),git('rev-parse','HEAD~1^2')).digest,qa.digest);
  assert.throws(()=>candidateBinding(git,'main',B,H0),/SHA/);
});
