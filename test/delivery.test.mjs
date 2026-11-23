import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from '../scripts/build.mjs';
const { deliver }=createRequire(import.meta.url)('../core/delivery.cjs');
const { encodeEnvelope }=createRequire(import.meta.url)('../core/qa-receipt-policy.cjs');
const H='a'.repeat(40), B='b'.repeat(40), M='c'.repeat(40), T='d'.repeat(40);
function fixture({pending=false,drift=false,reject=false,merged=false,wrongTree=false,deletedBranch=false,ruleset=null,plan,bodies=[]}={}) {
 const calls=[]; let didMerge=merged, views=0;
 const flow={version:2,phase:'ci',authorization:'사용자 요청',verification:{verdict:'PASS'},delivery:{pr:12,head:H,base:B,tree:T},...(plan?{plan}:{})};
 // bodies[n]은 n번째 PR 조회의 본문이다. 비어 있으면 body 필드가 없는 이전 조회와 같다.
 const pr=()=>{
   const body=views<bodies.length?{body:bodies[views]}:{};views++;
   return {number:12,url:'https://github.com/example/repo/pull/12',state:didMerge?'MERGED':'OPEN',headRefName:'codex/test',headRefOid:H,baseRefName:'main',baseRefOid:B,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'APPROVED',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}],...(didMerge?{mergeCommit:{oid:M},mergedAt:'2026-11-17T00:00:00Z'}:{}),...body};
 };
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
 // main can advance between two remote calls. Both graph checks must use
 // objects fetched by the exact advertised SHA, including the post-merge read.
 assert.deepEqual(f.calls.filter(x=>x[0]==='git'&&x[1]==='fetch').map(x=>x[5]),[B,M]);
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

test('후속 확인이 있는 계획은 첫 조회와 병합 직전 PR 본문에 남은 검증 줄이 모두 있어야 병합한다',()=>{
 const plan={version:2,criteria:['AC1','AC2'],checks:['hh-suite'],checkScopes:[{id:'hh-suite',location:'independent-qa',executor:'hh-suite',criteria:['AC1','AC2']},
   {id:'mobile-browser-copy',location:'follow-up',criteria:['AC2'],environment:'배포 후 Galaxy Chrome',verify:'제목을 복사해 Teams에 붙여넣고 원문과 대조'}]};
 const line='mobile-browser-copy (AC2) | 환경: 배포 후 Galaxy Chrome | 확인: 제목을 복사해 Teams에 붙여넣고 원문과 대조';
 const body=`## 남은 검증\r\n- [ ] ${line}\r\n`;
 const merges=f=>f.calls.filter(x=>x[0]==='gh'&&x[2]==='merge').length;
 let f=fixture({plan,bodies:[body,body,body]});assert.equal(deliver(f.input,f.exec).phase,'merged');assert.equal(merges(f),1);
 assert.ok(f.calls.some(x=>x[0]==='gh'&&x[1]==='pr'&&x[2]==='view'&&x.at(-1).split(',').includes('body')));
 // 남은 검증 뒤 줄 맨 앞에 넣은 QA 실행 영수증 주석(CRLF)은 목록 판정을 바꾸지 않는다.
 const withReceipt=body+'\r\n'+encodeEnvelope({kind:'herdr-qa-receipt',version:2,run:'qa'})+'\r\n';
 f=fixture({plan,bodies:[withReceipt,withReceipt,withReceipt]});assert.equal(deliver(f.input,f.exec).phase,'merged');assert.equal(merges(f),1);
 // 본문이 없거나 환경·방법 한 줄이 빠지면 병합하지 않고 빠진 줄을 돌려준다.
 // 템플릿 HTML 주석 안에만 있는 줄은 PR 화면에 보이지 않으므로 누락이다.
 // HTML 속성이나 요소 안에만 있는 줄도 화면에 보이지 않는다.
 const attribute=`## 남은 검증\n<div title="internal fixture\n- [ ] ${line}\n">Template</div>\n`;
 for(const bodies of [[],[null],['## 남은 검증\n- mobile-browser-copy (AC2) | 확인: 제목을 복사해 Teams에 붙여넣고 원문과 대조'],[`## 남은 검증\n<!-- 예시:\n- [ ] ${line}\n-->\n`],
   [attribute],[`<details>\n\n- [ ] ${line}\n\n</details>`]]){
   f=fixture({plan,bodies});const r=deliver(f.input,f.exec);
   assert.deepEqual([r.phase,r.missing],['blocked',[line]]);assert.match(r.reasons[0],/PR 본문 남은 검증 누락/);assert.equal(merges(f),0);
 }
 // 인라인 코드의 리터럴 주석 표식은 주석이 아니므로 뒤의 목록 줄이 보인다.
 const coded=`템플릿 표식은 \`<!--\`로 시작한다.\n\n## 남은 검증\n- [ ] ${line}\n`;
 f=fixture({plan,bodies:[coded,coded,coded]});assert.equal(deliver(f.input,f.exec).phase,'merged');assert.equal(merges(f),1);
 // PR 연결 뒤 본문을 지우거나 숨기면 병합 직전 재조회에서 막는다.
 for(const edited of ['본문 삭제',`## 남은 검증\n<!-- ${line} -->`,attribute]){
   f=fixture({plan,bodies:[body,edited]});const late=deliver(f.input,f.exec);
   assert.deepEqual([late.phase,late.missing],['blocked',[line]]);assert.equal(merges(f),0);
 }
 // 이미 병합된 PR의 증명과 후속 확인 0건·기존 계획은 본문을 요구하지 않는다.
 f=fixture({plan,merged:true});assert.equal(deliver(f.input,f.exec).phase,'merged');
 f=fixture({plan:{version:2,criteria:['AC1'],checks:['hh-suite']}});assert.equal(deliver(f.input,f.exec).phase,'merged');
 f=fixture({plan:{...plan,checkScopes:plan.checkScopes.slice(0,1)}});assert.equal(deliver(f.input,f.exec).phase,'merged');
});

test('QA가 남긴 한계·후속 확인도 PR 본문 남은 검증에 있어야 병합한다',()=>{
 const plan={version:2,criteria:['AC1'],checks:['hh-suite'],checkScopes:[{id:'hh-suite',location:'independent-qa',executor:'hh-suite',criteria:['AC1']}]};
 const limitations=[{id:'L1',kind:'limitation',severity:'Low',note:'오류 문구가 영어로 남는다'},{id:'device',kind:'follow-up',criteria:['AC1'],environment:'배포 후 실기기',verify:'붙여넣기 결과 대조'}];
 const lines=['L1 | 남는 한계 Low: 오류 문구가 영어로 남는다','device (AC1) | 환경: 배포 후 실기기 | 확인: 붙여넣기 결과 대조'];
 const merges=f=>f.calls.filter(x=>x[0]==='gh'&&x[2]==='merge').length;
 const run=bodies=>{const f=fixture({plan,bodies});f.input.flow.verification={verdict:'PASS',criteria:[{id:'AC1',status:'unverified',evidence:'로컬만'}],limitations};return [deliver(f.input,f.exec),merges(f)];};
 const full='## 남은 검증\n'+lines.map(l=>'- [ ] '+l).join('\n');
 const [ok,merged]=run([full,full,full]);assert.deepEqual([ok.phase,merged],['merged',1]);
 const [gap,none]=run(['## 남은 검증\n- [ ] '+lines[0]]);assert.deepEqual([gap.phase,gap.missing,none],['blocked',[lines[1]],0]);
});

test('병합 증명에 PR 브랜치 이름을 남긴다',()=>{
 const f=fixture();assert.equal(deliver(f.input,f.exec).branch,'codex/test');
});

test('watch-delivery는 flow-deliver --apply의 정리 결과를 그대로 내보내고 ci가 아니면 끝난다',t=>{
 const dir=mkdtempSync(join(tmpdir(),'herdr-watch-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const built=build(),stub=join(dir,'adapter.mjs'),file=join(dir,'harness-binding.json');
 const cleanup={status:'refused',reasons:['살아 있는 위임 터미널이 있다: t9'],retry:'node .agents/harness/launch.mjs cleanup-worktree HH-001'};
 writeFileSync(stub,`console.log(JSON.stringify({id:'HH-001',phase:'merged',argv:process.argv.slice(2),cleanup:${JSON.stringify(cleanup)}}));`);
 writeFileSync(file,JSON.stringify({version:1,project:'fixture',release:built.release,manifestHash:built.manifestHash,cwd:dir,command:[process.execPath,stub]}));
 const r=spawnSync(process.execPath,['bin/watch-delivery.mjs',file,'HH-001','1'],{encoding:'utf8',windowsHide:true,timeout:60000});
 assert.equal(r.status,0,r.stderr);
 assert.deepEqual(JSON.parse(r.stdout),{id:'HH-001',phase:'merged',argv:['flow-deliver','HH-001','--apply'],cleanup});
});
