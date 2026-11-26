import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync,readdirSync,renameSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const {candidateTree,verifyReceipt}=createRequire(import.meta.url)('../core/verification-receipt.cjs');
test('QA runner 증거는 같은 후보·시각·완료 결과만 통과시키고 index를 보존한다',t=>{
 const cwd=mkdtempSync(join(tmpdir(),'herdr-receipt-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd,windowsHide:true,stdio:'pipe'});
 // 같은 길이 수정(26행)이 시각에 따라 갈리지 않도록 a.txt의 mtime을 과거 정각으로 고정한다.
 const fixed=new Date('2001-01-01T00:00:00Z');git('init','-q');git('config','core.trustctime','false');
 writeFileSync(join(cwd,'.gitignore'),'target/\n');writeFileSync(join(cwd,'a.txt'),'one\n');utimesSync(join(cwd,'a.txt'),fixed,fixed);git('add','.gitignore','a.txt');
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
 save(receipt);writeFileSync(join(cwd,'a.txt'),'two\n');utimesSync(join(cwd,'a.txt'),fixed,fixed);assert.throws(()=>verifyReceipt(cwd,'2026-11-17T00:00:00Z','base'),/불완전/);
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
test('같은 길이·같은 초 mtime으로 바뀐 미스테이지 파일도 v1·v2 후보에 작업 내용으로 들어가고 skip-worktree는 유지된다',t=>{
 const {publishTree}=createRequire(import.meta.url)('../core/verification-receipt.cjs');
 const {candidateBinding}=createRequire(import.meta.url)('../core/qa-receipt-policy.cjs');
 const cwd=mkdtempSync(join(tmpdir(),'herdr-receipt-racy-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const git=(...args)=>{const out=execFileSync('git',args,{cwd,windowsHide:true,encoding:'utf8',stdio:'pipe'});return out.includes('\0')?out:out.trim();};
 git('init','-q');git('config','user.name','r');git('config','user.email','r@example.invalid');git('config','core.autocrlf','false');git('config','core.trustctime','false');
 // 시각에 의존하지 않도록 내용과 함께 mtime을 같은 과거 정각으로 고정한다. index 기록 시각보다 과거라 git은 stat 캐시를 믿는다.
 const fixed=new Date('2001-01-01T00:00:00Z'),put=(f,s)=>{writeFileSync(join(cwd,f),s);utimesSync(join(cwd,f),fixed,fixed);};
 put('a.txt','one\n');put('sparse.txt','s\n');git('add','-A');git('commit','-q','-m','base');const base=git('rev-parse','HEAD');
 git('update-index','--skip-worktree','sparse.txt');rmSync(join(cwd,'sparse.txt'));
 put('a.txt','two\n');const expected=git('hash-object','a.txt'),index=readFileSync(join(cwd,'.git/index'));
 const v1=candidateTree(cwd),v2=publishTree(cwd,base);
 assert.deepEqual(readFileSync(join(cwd,'.git/index')),index);
 assert.deepEqual([git('rev-parse',v1+':a.txt'),git('rev-parse',v2+':a.txt')],[expected,expected]);
 // skip-worktree로 작업 트리에 없는 파일은 삭제로 세지 않는다.
 assert.deepEqual(git('diff','--name-status','--no-renames',base,v2).split('\n'),['M\ta.txt']);
 const qa=candidateBinding(git,base,base,v2);assert.deepEqual([qa.count,qa.paths],[1,['a.txt']]);
 // 실제 index도 같은 stat 캐시를 가지므로 게시 add 전에는 다른 고정 시각으로 바꿔 작업 내용을 기록하게 한다.
 const later=new Date('2002-01-01T00:00:00Z');utimesSync(join(cwd,'a.txt'),later,later);git('update-index','--no-skip-worktree','sparse.txt');git('checkout','--','sparse.txt');git('add','-A');git('commit','-q','-m','publish');
 assert.equal(candidateBinding(git,base,base,git('rev-parse','HEAD')).digest,qa.digest);
});
test('receipt-tree-check: 임시 객체 저장소에서 다시 계산해 일치·불일치·문서 밖 차이·후보 지문을 돌려주고 공유 objects·index를 바꾸지 않는다',t=>{
 const req=createRequire(import.meta.url),{workflow,hash}=req('../adapters/runtime.cjs'),{privateObjects,publishTree}=req('../core/verification-receipt.cjs'),{candidateBinding}=req('../core/qa-receipt-policy.cjs');
 const temp=mkdtempSync(join(tmpdir(),'herdr-receipt-check-'));t.after(()=>rmSync(temp,{recursive:true,force:true}));
 // 이 시험에 필요한 모듈만 담은 고정 release와 binding.
 const release=join(temp,'release'),files={};mkdirSync(join(release,'core'),{recursive:true});mkdirSync(join(release,'policy'));
 for(const f of ['core/verification-receipt.cjs','core/qa-receipt-policy.cjs','core/dev14.cjs','core/artifact-policy.cjs','core/atomic-rename.cjs','policy/artifacts.json']){const raw=readFileSync(new URL('../'+f,import.meta.url));writeFileSync(join(release,f),raw);files[f]=hash(raw);}
 // workflow 진입점이 먼저 읽는 core/workflow.cjs는 이 동작에 쓰지 않으므로 빈 모듈로 둔다.
 writeFileSync(join(release,'core/workflow.cjs'),'module.exports={};\n');files['core/workflow.cjs']=hash('module.exports={};\n');
 const manifest=JSON.stringify({format:1,files});writeFileSync(join(release,'manifest.json'),manifest);
 const state=join(temp,'state');mkdirSync(state);const file=join(state,'harness-binding.json');
 writeFileSync(file,JSON.stringify({version:1,project:'fixture',release,manifestHash:hash(manifest)}));
 const cwd=join(temp,'repo');mkdirSync(cwd);
 const git=(...args)=>execFileSync('git',args,{cwd,windowsHide:true,encoding:'utf8',stdio:'pipe'}).trim();
 git('init','-q');git('config','user.name','c');git('config','user.email','c@example.invalid');git('config','core.autocrlf','false');
 mkdirSync(join(cwd,'docs/tasks/t'),{recursive:true});writeFileSync(join(cwd,'docs/tasks/t/a.md'),'one\n');writeFileSync(join(cwd,'a.txt'),'one\n');
 git('add','-A');git('commit','-q','-m','base');const base=git('rev-parse','HEAD');
 writeFileSync(join(cwd,'a.txt'),'two\n');writeFileSync(join(cwd,'docs/tasks/t/a.md'),'two\n');
 // 발급기처럼 임시 저장소에서 기대 tree·지문을 얻는다. 공유 objects에는 후보 객체가 없다.
 const store=privateObjects(cwd);let tree,expected;
 try{tree=publishTree(cwd,base,store.env);expected=candidateBinding((...a)=>execFileSync('git',a,{cwd,env:store.env,encoding:'utf8',windowsHide:true,stdio:'pipe'}),base,base,tree);}finally{store.remove();}
 assert.throws(()=>git('cat-file','-e',tree));
 const objects=()=>readdirSync(join(cwd,'.git/objects'),{recursive:true}).sort(),before=objects(),index=readFileSync(join(cwd,'.git/index'));
 const check=extra=>workflow(file,{project:'fixture',stateDir:state,action:'receipt-tree-check',worktree:cwd,base,tree,...extra});
 const ok=check();
 assert.deepEqual(ok,{match:true,tree,outside:[],binding:expected});
 assert.deepEqual(ok.binding.paths,['a.txt']);
 assert.equal(check({tree:'0'.repeat(40)}).match,false);
 // 과정 문서 밖 게시 금지 신규 파일(정책 선언 저장소)은 v1에는 있고 v2에서 빠져 문서 밖 차이로 잡힌다.
 mkdirSync(join(cwd,'.agents/harness'),{recursive:true});writeFileSync(join(cwd,'.agents/harness/config.json'),JSON.stringify({process_artifacts:{paths:['process/{id}/']}}));
 mkdirSync(join(cwd,'process/T-1'),{recursive:true});writeFileSync(join(cwd,'process/T-1/x.md'),'x\n');
 const moved=check();
 assert.equal(moved.match,false);
 assert.deepEqual(moved.outside,['process/T-1/x.md']);
 assert.deepEqual(objects(),before);
 assert.deepEqual(readFileSync(join(cwd,'.git/index')),index);
});
