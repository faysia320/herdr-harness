import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const {candidateTree,verifyReceipt}=createRequire(import.meta.url)('../core/verification-receipt.cjs');
test('QA runner 증거는 같은 후보·시각·완료 결과만 통과시키고 index를 보존한다',t=>{
 const cwd=mkdtempSync(join(tmpdir(),'herdr-receipt-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd,windowsHide:true,stdio:'pipe'});
 git('init','-q');writeFileSync(join(cwd,'.gitignore'),'target/\n');writeFileSync(join(cwd,'a.txt'),'one\n');git('add','.gitignore','a.txt');
 const index=readFileSync(join(cwd,'.git/index')),tree=candidateTree(cwd);assert.deepEqual(readFileSync(join(cwd,'.git/index')),index);
 const dir=join(cwd,'target/sw-verify');mkdirSync(dir,{recursive:true});
 const receipt={version:1,role:'qa',stable:true,tree,base:'base',scope:'changed-paths',completedAt:'2026-11-17T01:00:00Z',checks:[{id:'test',state:'passed'}]};
 const save=r=>writeFileSync(join(dir,'latest-qa.json'),JSON.stringify(r));save(receipt);
 assert.equal(verifyReceipt(cwd,'2026-11-17T00:00:00Z','base').tree,tree);
 renameSync(dir,join(cwd,'target/vdp-verify'));
 assert.throws(()=>verifyReceipt(cwd,'2026-11-17T00:00:00Z','base'),/ENOENT/);
 assert.equal(verifyReceipt(cwd,'2026-11-17T00:00:00Z','base','target/vdp-verify/latest-qa.json').tree,tree);
 assert.throws(()=>verifyReceipt(cwd,'2026-11-17T00:00:00Z','base','../latest-qa.json'),/경로/);
 renameSync(join(cwd,'target/vdp-verify'),dir);
 assert.throws(()=>verifyReceipt(cwd,'2026-11-17T02:00:00Z','base'),/불완전/);
 save({...receipt,checks:[{id:'test',state:'skipped'}]});assert.throws(()=>verifyReceipt(cwd,'2026-11-17T00:00:00Z','base'),/불완전/);
 save({...receipt,base:'wrong'});assert.throws(()=>verifyReceipt(cwd,'2026-11-17T00:00:00Z','base'),/불완전/);
 save(receipt);writeFileSync(join(cwd,'a.txt'),'two\n');assert.throws(()=>verifyReceipt(cwd,'2026-11-17T00:00:00Z','base'),/불완전/);
});
test('미커밋 QA 후보의 v2 지문은 게시 커밋과 같고 무시 경로의 QA 산출물은 후보에 들어가지 않는다',t=>{
 const {candidateBinding}=createRequire(import.meta.url)('../core/qa-receipt-policy.cjs');
 const cwd=mkdtempSync(join(tmpdir(),'herdr-receipt-v2-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const git=(...args)=>{const out=execFileSync('git',args,{cwd,windowsHide:true,encoding:'utf8',stdio:'pipe'});return out.includes('\0')?out:out.trim();};
 git('init','-q');git('config','user.name','v2');git('config','user.email','v2@example.invalid');git('config','core.autocrlf','false');
 writeFileSync(join(cwd,'.gitignore'),'target/hh-verify/\n');writeFileSync(join(cwd,'a.txt'),'one\n');writeFileSync(join(cwd,'gone.txt'),'x\n');
 git('add','-A');git('commit','-q','-m','base');const base=git('rev-parse','HEAD');
 writeFileSync(join(cwd,'a.txt'),'two\n');rmSync(join(cwd,'gone.txt'));writeFileSync(join(cwd,'new.txt'),'new\n');
 mkdirSync(join(cwd,'target/hh-verify/receipts/r1'),{recursive:true});writeFileSync(join(cwd,'target/hh-verify/receipts/r1/receipt.json'),'{}');
 const qa=candidateBinding(git,base,base,candidateTree(cwd));
 assert.deepEqual([qa.count,qa.paths],[3,['a.txt','gone.txt','new.txt']]);
 git('add','-A');git('commit','-q','-m','publish');
 assert.equal(candidateBinding(git,base,base,git('rev-parse','HEAD')).digest,qa.digest);
});
test('v2 후보 publishTree는 B 대비 실제 변경에만 과정 문서 정책을 적용하고 선언 없는 저장소는 docs/tasks·docs/projects를 기본으로 본다',t=>{
 const {publishTree}=createRequire(import.meta.url)('../core/verification-receipt.cjs');
 const cwd=mkdtempSync(join(tmpdir(),'herdr-receipt-publish-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd,windowsHide:true,encoding:'utf8',stdio:'pipe'}).trim();
 git('init','-q');git('config','user.name','p');git('config','user.email','p@example.invalid');git('config','core.autocrlf','false');
 for(const f of ['keep','edit','gone'])mkdirSync(join(cwd,'docs/tasks',f),{recursive:true}),writeFileSync(join(cwd,'docs/tasks',f,'a.md'),'one\n');
 writeFileSync(join(cwd,'a.txt'),'one\n');git('add','-A');git('commit','-q','-m','base');const base=git('rev-parse','HEAD');
 writeFileSync(join(cwd,'a.txt'),'two\n');writeFileSync(join(cwd,'docs/tasks/edit/a.md'),'two\n');rmSync(join(cwd,'docs/tasks/gone/a.md'));
 mkdirSync(join(cwd,'docs/projects/new'),{recursive:true});writeFileSync(join(cwd,'docs/projects/new/a.md'),'new\n');
 const index=readFileSync(join(cwd,'.git/index')),tree=publishTree(cwd,base);
 assert.deepEqual(readFileSync(join(cwd,'.git/index')),index);
 // 바뀌지 않은 추적 문서는 행이 없고, 수정·신규는 게시 대상이 아니며, 삭제는 실제 행 그대로 남는다.
 assert.deepEqual(git('diff','--name-status','--no-renames',base,tree).split('\n'),['M\ta.txt','D\tdocs/tasks/gone/a.md']);
 // v1 candidateTree(HH 수집기·정리 경로)는 기존처럼 두 문서 폴더 전체를 뺀다.
 assert.match(git('diff','--name-status',base,candidateTree(cwd)),/D\tdocs\/tasks\/keep\/a\.md/);
});
