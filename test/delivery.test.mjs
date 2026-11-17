import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { deliver }=createRequire(import.meta.url)('../core/delivery.cjs');
const H='a'.repeat(40), B='b'.repeat(40), M='c'.repeat(40), T='d'.repeat(40);
function fixture({pending=false,drift=false,reject=false,merged=false,wrongTree=false,deletedBranch=false,ruleset=null}={}) {
 const calls=[]; let didMerge=merged;
 const flow={version:2,phase:'ci',authorization:'사용자 요청',verification:{verdict:'PASS'},delivery:{pr:12,head:H,base:B,tree:T}};
 const pr=()=>({number:12,url:'https://github.com/example/repo/pull/12',state:didMerge?'MERGED':'OPEN',headRefName:'codex/test',headRefOid:H,baseRefName:'main',baseRefOid:B,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'APPROVED',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}],...(didMerge?{mergeCommit:{oid:M},mergedAt:'2026-11-17T00:00:00Z'}:{})});
 const exec=(cwd,cmd,args)=>{
   calls.push([cmd,...args]);let text='';const key=args.join(' ');
   if(cmd==='gh') {
     if(key.startsWith('api ') && ruleset) {
       if(key.endsWith('/protection'))return {code:1,text:JSON.stringify({message:'Branch not protected'})};
       if(key.endsWith('/rules/branches/main'))text=JSON.stringify([{type:'required_status_checks',parameters:{strict_required_status_checks_policy:ruleset.strict},ruleset_source_type:'Repository',ruleset_id:42}]);
       else if(key.endsWith('/rulesets/42'))text=JSON.stringify({enforcement:'active',bypass_actors:ruleset.bypass?[{actor_type:'RepositoryRole',actor_id:5}]:[]});
       else throw Error(key);
     }
     else if(key.startsWith('api ')) text=JSON.stringify({required_status_checks:{strict:true},enforce_admins:{enabled:true}});
     else if(key.startsWith('repo view')) text=JSON.stringify({nameWithOwner:'example/repo'});
     else if(key.startsWith('pr view')) text=JSON.stringify(pr());
     else if(key.startsWith('pr checks')) text=JSON.stringify([{name:'CI',bucket:pending?'pending':'pass'}]);
     else if(key.startsWith('pr merge')) {if(!reject)didMerge=true;return {code:reject?1:0,text:''};}
     else throw Error(key);
   } else if(key.startsWith('fetch') && deletedBranch && args.includes('refs/heads/codex/test')) throw Error("couldn't find remote ref refs/heads/codex/test");
   else if(key.startsWith('remote get-url'))text='https://github.com/example/repo.git';
   else if(key==='branch --show-current')text='codex/test';
   else if(key==='rev-parse HEAD')text=H;
   else if(key.startsWith('ls-remote'))text=`${didMerge?M:drift?M:B}\trefs/heads/main`;
   else if(key.startsWith('merge-tree'))text=T;
   else if(key.startsWith('show -s'))text=B;
   else if(key.startsWith('rev-parse'))text=wrongTree?'e'.repeat(40):T;
   else if(!key.startsWith('fetch') && !key.startsWith('merge-base'))throw Error(key);
   return {code:0,text};
 };
 return {input:{cwd:'.',flow,branch:'codex/test',apply:true},exec,calls};
}
test('모든 기준 통과 후 정확한 head로 병합하고 서버 readback·tree를 확인한다',()=>{
 const f=fixture();assert.equal(deliver(f.input,f.exec).merge,M);
 assert.deepEqual(f.calls.filter(x=>x[0]==='gh'&&x[2]==='merge'),[['gh','pr','merge','12','--repo','example/repo','--squash','--match-head-commit',H]]);
});
test('CI 대기는 쓰기 없이 반환하고 base 이동은 재검증으로 돌린다',()=>{
 for(const options of [{pending:true},{drift:true}]){const f=fixture(options);assert.equal(deliver(f.input,f.exec).phase,options.drift?'revalidate':'ci');assert.equal(f.calls.some(x=>x[0]==='gh'&&x[2]==='merge'),false);}
});
test('서버 거부·병합 후 증명 실패·재시작을 구분한다',()=>{
 let f=fixture({reject:true});assert.equal(deliver(f.input,f.exec).phase,'blocked');
 f=fixture({wrongTree:true});assert.throws(()=>deliver(f.input,f.exec),/병합은 발생/);
 f=fixture({merged:true,deletedBranch:true});assert.equal(deliver(f.input,f.exec).phase,'merged');assert.equal(f.calls.some(x=>x[0]==='gh'&&x[2]==='merge'),false);
});

test('SW처럼 ruleset을 쓰면 strict 필수 CI와 우회 없는 규칙을 요구한다',()=>{
 for(const ruleset of [{strict:false,bypass:false},{strict:true,bypass:true}]) {
   const f=fixture({ruleset});assert.equal(deliver(f.input,f.exec).phase,'blocked');
   assert.equal(f.calls.some(x=>x[0]==='gh'&&x[2]==='merge'),false);
 }
 const f=fixture({ruleset:{strict:true,bypass:false}});assert.equal(deliver(f.input,f.exec).phase,'merged');
});
