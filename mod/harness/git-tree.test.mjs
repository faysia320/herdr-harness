import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { graphRows } from './git-data.js';
const source = fs.readFileSync(new URL('./git-tree.js', import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export class GitTree','class GitTree');
function fixture(loader, sync = async () => '') {
  const clicks = new Map(), sizes = new Map(), texts = [], jobs = [];
  const element = () => { let id; const e = new Proxy({}, {get:(_,name)=>(...args)=>{
    if(name==='id')id=args[0]; if(name==='on_click')clicks.set(id,args[0]);
    if(name==='on_size_change')sizes.set(id,args[0]);
    if(name==='when' && args[0])args[1](e); if(name==='child' && typeof args[0]==='string')texts.push(args[0]);
    return e;
  }}); return e; };
  const api = {div:element,svg:element,h_flex:element,v_flex:element,PathBuilder:{fill:element,stroke:element},Background:{linear_gradient:element},window:{paint_path:element},exec:()=>{},theme:()=>new Proxy({}, {get:()=> '#808080'}),settings:()=>({zoom:1.2}),loadGit:loader,syncGit:sync};
  const GitTree = new Function(...Object.keys(api),`${source}; return GitTree;`)(...Object.values(api));
  const cx={notify(){},spawn(fn){jobs.push(fn(cx));}};
  const view = new GitTree(), projects=[{root:'fixture',name:'fixture'}];
  const render=()=>{clicks.clear();texts.length=0;view.render(projects,cx);};
  return {view,projects,cx,clicks,sizes,texts,jobs,render};
}
const commit={hash:'a'.repeat(40),parents:['b'.repeat(40)],refs:['HEAD -> main'],author:'작성자',date:'2026-11-09T10:00:00+09:00',subject:'제목',message:'제목\n\n전체 설명'};
const data={branch:'main',head:commit.hash,dirty:1,upstream:'origin/main',ahead:0,behind:1,...graphRows([commit])};
test('Git 탭 실제 render는 로드·필터·선택·닫기 핸들러를 연결한다', async ()=>{
  const modes=[],s=fixture(async (_exec,root,all)=>{modes.push(all);assert.equal(root,'fixture');return data;});
  s.render();await Promise.all(s.jobs);s.render();
  s.sizes.get('git-tree')({width:480},s.cx);assert.equal(s.view.width,400);s.render();
  assert.ok(s.texts.includes('제목')); assert.ok(s.texts.includes('변경 1'));
  s.clicks.get(`git-commit-${commit.hash}`)({},s.cx);s.render();assert.ok(s.texts.includes(commit.message));
  s.clicks.get('git-detail-close')({},s.cx);s.render();assert.equal(s.view.selected,null);
  s.clicks.get('git-current')({},s.cx);s.render();await Promise.all(s.jobs);s.render();
  assert.deepEqual(modes,[true,false]);
  s.clicks.get('git-all')({},s.cx);s.render();assert.deepEqual(modes,[true,false]);
});
test('갱신 실패는 기존 그래프+오류를 남기고 다른 저장소 캐시와 섞지 않는다', async ()=>{
  let fail=false;const s=fixture(async()=>{if(fail)throw Error('접근 실패');return data;});
  s.render();await Promise.all(s.jobs);fail=true;
  s.view.refresh(s.projects[0],s.cx,true);await Promise.all(s.jobs);s.render();
  assert.ok(s.texts.includes('제목'));assert.ok(s.texts.some(x=>x.includes('마지막 정상 기록 표시')));
  s.projects[0]={name:'other',root:'other'};s.render();await Promise.all(s.jobs);s.render();assert.equal(s.texts.includes('제목'),false);
});
test('Fetch·Pull은 명시 클릭으로만 실행하고 중복 요청을 막으며 완료 후 갱신한다', async () => {
  let finish, loads=0; const calls=[];
  const s=fixture(async()=>{loads++;return data;},async(_exec,root,kind,branch)=>{calls.push({root,kind,branch});await new Promise(r=>{finish=r;});return '완료';});
  s.render();await Promise.all(s.jobs);s.render();assert.equal(calls.length,0);
  s.clicks.get('git-fetch')({},s.cx);s.view.sync(s.projects[0],'pull','main',s.cx);s.render();
  assert.equal(s.clicks.has('git-fetch'),false);assert.equal(s.clicks.has('git-pull'),false);assert.equal(calls.length,1);
  finish();await Promise.all(s.jobs);await Promise.all(s.jobs);s.render();
  assert.equal(loads,2);assert.ok(s.texts.includes('Fetch 완료 · 원격 이력을 갱신했습니다.'));
  assert.deepEqual(calls[0],{root:'fixture',kind:'fetch',branch:'main'});
  s.clicks.get('git-pull')({},s.cx);finish();await Promise.all(s.jobs);await Promise.all(s.jobs);s.render();
  assert.equal(calls[1].kind,'pull');assert.ok(s.texts.includes('Pull 완료 · 현재 브랜치를 동기화했습니다.'));
});
test('원격 작업 실패는 표시하고 upstream 없는 Pull은 실행 버튼을 붙이지 않는다', async () => {
  const s=fixture(async()=>({...data,upstream:null}),async()=>{throw Error('인증 실패\n상세');});
  s.render();await Promise.all(s.jobs);s.render();assert.equal(s.clicks.has('git-pull'),false);
  s.clicks.get('git-fetch')({},s.cx);await Promise.all(s.jobs);await Promise.all(s.jobs);s.render();
  assert.ok(s.texts.includes('실패 · 인증 실패'));assert.equal(s.view.operations.get('fixture').busy,false);
});
