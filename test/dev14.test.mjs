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
function fixture(t, mainPath='docs/readme.md') {
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
  fs.writeFileSync(join(cwd,'old.txt'),'delete me'); git('add','old.txt'); git('commit','-m','base');
  const base=git('rev-parse','HEAD');
  git('switch','-c','topic');
  const bytes=Buffer.from([0,13,10,255,42]);
  const binary='payload with spaces.bin';
  fs.writeFileSync(join(cwd,binary),bytes); git('rm','old.txt'); git('add','--',binary);
  git('update-index','--chmod=+x','--',binary); git('commit','-m','QA candidate');
  const head=git('rev-parse','HEAD'), tree=git('rev-parse','HEAD^{tree}');
  const candidate={head,x_base:base,paths:[
    {path:'old.txt',status:'DELETED',mode:null,sha256:null},
    {path:binary,status:'A',mode:'100755',sha256:sha(bytes)}]};
  candidate.fingerprint=sha(JSON.stringify({head,base,paths:candidate.paths.map(p=>[p.path,p.status,p.mode,p.sha256])}));
  git('push',remote,'topic','main');
  const mainDir=join(root,'main');
  git('worktree','add',mainDir,'main');
  function advance(file) {
    const dest=join(mainDir,file); fs.mkdirSync(join(dest,'..'),{recursive:true}); fs.writeFileSync(dest,'upstream');
    git('-C',mainDir,'add','--',file); git('-C',mainDir,'commit','-m','advance'); git('-C',mainDir,'push',remote,'main');
  }
  advance(mainPath);
  const flow={version:2,phase:'ci',authorization:'조건부 병합',verification:{verdict:'PASS',candidate:candidate.fingerprint},delivery:{pr:7,head,base,tree}};
  const input={cwd,branch:'topic',flow,dev14:{candidate,mergeAuthorized:true},apply:true};
  const tip=branch=>fs.readFileSync(join(remote,'refs','heads',branch),'utf8').trim();
  const state={merged:null,finalHead:null,passed:false,wrongCI:false,review:'APPROVED',pushes:0,merges:0};
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
    const call=args.join(' '), h=state.finalHead??tip('topic'), b=tip('main');
    const link='https://fixture.invalid/jobs/42';
    if (call.startsWith('repo view')) return result({nameWithOwner:'fixture/dev14'});
    if (call.startsWith('api ') && call.includes('/branches/main/protection')) return result({required_status_checks:{strict:true,checks:[{context:'CI',app_id:42}]},enforce_admins:{enabled:true}});
    if (call.endsWith('/rules/branches/main')) return result([]);
    if (call.includes('/check-runs?')) return result([{check_runs:[{name:'CI',app:{id:state.wrongApp?99:42},head_sha:state.wrongCI?head:h,status:'completed',conclusion:'success',details_url:link}]}]);
    if (call.includes('/status?')) return result({sha:h,statuses:[]});
    if (call.startsWith('pr checks')) return result(state.noChecks?[]:[{name:'CI',bucket:state.passed?'pass':'pending',state:state.passed?'SUCCESS':'PENDING',link}]);
    if (call.startsWith('pr view')) return result({number:7,url:url+'/pull/7',state:state.merged?'MERGED':'OPEN',isDraft:false,isCrossRepository:false,
      headRefName:'topic',headRefOid:h,baseRefName:'main',baseRefOid:b,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',
      reviewDecision:state.review,statusCheckRollup:state.noChecks?[]:[{status:state.passed?'COMPLETED':'IN_PROGRESS',conclusion:state.passed?'SUCCESS':null}],
      mergeCommit:state.merged&&{oid:state.merged},mergedAt:state.merged&&'2026-11-19T01:00:00Z'});
    if (call.startsWith('pr merge')) { assert.equal(args.at(-1),h); state.merges++; squash(); return result({}); }
    throw Error('unexpected call: '+call);
  }
  function result(data) {return {text:JSON.stringify(data),code:0};}
  return {query:(patch={})=>deliver({...input,...patch},exec),input,state,advance,tip,git,remote,head,base,binary,squash,mainDir};
}

test('독립 main 이동 두 번, 새 head CI·리뷰·권한을 확인하고 한 번만 squash한다',t=>{
  const f=fixture(t);
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

test('민감 경로 또는 겹침은 쓰기 전에 재QA로 돌린다',t=>{
  for(const p of ['Cargo.lock','.github/workflows/verify.yml','payload with spaces.bin','crates/workspace-contracts/src/lib.rs','team/shared.rules']){
    const f=fixture(t,p);
    f.input.dev14.sensitivePaths=['team/shared.rules'];
    assert.equal(f.query().phase,'revalidate',p);
    assert.deepEqual([f.state.pushes,f.state.merges],[0,0]);
  }
});

test('병합 사실·후보 바이트·필수 CI가 맞아도 민감 변경은 DONE이 되지 않는다',t=>{
  const f=fixture(t,'pnpm-lock.yaml');
  const base=f.tip('main');
  const sync=f.git('commit-tree',f.git('merge-tree','--write-tree',f.head,base),'-p',f.head,'-p',base,'-m','external sync');
  f.git('push',f.remote,sync+':refs/heads/topic'); f.state.passed=true; f.squash();
  const p=f.query({proofOnly:true,apply:false});
  assert.equal(p.phase,'proof-blocked'); assert.ok(p.mainContainsMerge && p.exactTree && p.exactCandidate && p.requiredChecksPassed);
  assert.match(p.reasons.join(' '),/pnpm-lock/); assert.equal(f.state.merges,0);
  assert.throws(()=>f.query({proofOnly:true}),/apply/);
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
