import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { create, collect, mergeGate }=createRequire(import.meta.url)('../core/workflow.cjs');
const fingerprint='a'.repeat(64);
const flow=()=>({...create('bug-fix','사용자: 기준 충족 시 자동 병합'),plan:{criteria:['AC1'],checks:['repro']}});
const report=(kind)=>({version:2,candidate:fingerprint,verdict:kind==='code'?'FAIL':kind?'BLOCKED':'PASS',criteria:[{id:'AC1',status:kind?'unverified':'passed',evidence:'원래 사용자 경로'}],checks:[{id:'repro',command:'node test.mjs',status:kind?'failed':'passed',evidence:'로그'}],findings:kind?[{id:'F1',kind,signature:'same-root',evidence:'재현 명령과 출력',next:'원인 수정'}]:[]});
test('환경 실패는 구현 재작업을 늘리지 않고 동일 원인 반복은 진단으로 보낸다',()=>{
 const one=collect(flow(),report('environment'),fingerprint);
 assert.equal(one.flow.repairs,0);assert.equal(one.pending,'qa');assert.equal(one.state,'BLOCKED');
 assert.equal(collect(one.flow,report('environment'),fingerprint).flow.phase,'diagnose');
});
test('코드 실패만 수정으로 보내고 PASS는 병합 전 DONE이 아니다',()=>{
 const one=collect(flow(),report('code'),fingerprint);assert.equal(one.flow.repairs,1);assert.equal(one.pending,'implement');
 const good=collect(one.flow,report(),fingerprint);assert.equal(good.flow.phase,'publish');assert.equal(good.state,'QA');assert.equal(good.pending,null);
});
test('한 회차에서 같은 원인의 증상이 여러 개여도 반복은 한 번으로 센다',()=>{
 const r=report('code');r.findings.push({...r.findings[0],id:'F2'});
 const result=collect(flow(),r,fingerprint);assert.equal(result.flow.phase,'repair');assert.equal(result.flow.failures.length,1);
});
test('다른 후보·누락 AC·불완전 PASS를 거부한다',()=>{
 assert.throws(()=>collect(flow(),report(),'b'.repeat(64)),/지문/);
 const missing=report();missing.criteria[0].id='other';assert.throws(()=>collect(flow(),missing,fingerprint),/누락/);
 const bad=report('environment');bad.verdict='PASS';assert.throws(()=>collect(flow(),bad,fingerprint),/PASS/);
});
test('head/base 이동·필수 CI 실패·리뷰 차단은 자동 병합 불가',()=>{
 const f=collect(flow(),report(),fingerprint).flow;f.delivery={head:'h',base:'b'};
 const pr={headRefOid:'h',baseRefOid:'b',state:'OPEN',baseRefName:'main',isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}]};
 const checks=[{bucket:'pass'}];assert.equal(mergeGate(f,pr,checks).ready,true);
 for(const patch of [{headRefOid:'new'},{baseRefOid:'new'},{reviewDecision:'CHANGES_REQUESTED'},{isDraft:true},{isCrossRepository:true}]) assert.equal(mergeGate(f,{...pr,...patch},checks).ready,false);
 assert.equal(mergeGate(f,pr,[]).ready,false);assert.equal(mergeGate(f,pr,[{bucket:'skipping'}]).ready,false);
 assert.equal(mergeGate(f,pr,[{bucket:'fail'}]).blocked,true);
 assert.equal(mergeGate(f,{...pr,statusCheckRollup:[{status:'IN_PROGRESS'}]},[{bucket:'pending'}]).blocked,false);
 assert.equal(mergeGate(f,{...pr,statusCheckRollup:[{status:'COMPLETED',conclusion:'FAILURE'}]},checks).blocked,true);
 assert.equal(mergeGate(f,{...pr,mergeStateStatus:'BLOCKED'},checks).blocked,true);
});
