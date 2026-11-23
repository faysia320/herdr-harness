const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const artifacts=require('./artifact-policy.cjs');
// 임시 index를 실제 index의 mode·blob·stage와 skip-worktree 표시만으로 채운다. stat 캐시는 옮기지 않으므로
// 같은 길이·같은 초 mtime으로 바뀐 미스테이지 파일도 뒤이은 add -A가 작업 트리 내용을 다시 읽는다.
// 경로는 원시 바이트로 한 번에 넘겨 파일별 Git 프로세스를 만들지 않는다. 실제 index가 없으면 HEAD에서 시작한다.
function seedIndex(cwd, env) {
  const git=(args,e,input)=>execFileSync('git',args,{cwd,env:e,input,windowsHide:true,stdio:[input===undefined?'ignore':'pipe','pipe','pipe'],maxBuffer:256<<20,timeout:30000});
  const real=path.resolve(cwd,git(['rev-parse','--git-path','index'],process.env).toString('utf8').trim());
  if(!fs.existsSync(real)){git(['read-tree','HEAD'],env);return;}
  const out=git(['ls-files','-s','-t','-z'],process.env),info=[],skip=[];
  for(let at=0;at<out.length;){
    const end=out.indexOf(0,at),rec=out.subarray(at,end);at=end+1;
    info.push(rec.subarray(2),Buffer.of(0));
    if(rec[0]===0x53)skip.push(rec.subarray(rec.indexOf(9)+1),Buffer.of(0));
  }
  if(info.length)git(['update-index','-z','--index-info'],env,Buffer.concat(info));
  if(skip.length)git(['update-index','-z','--skip-worktree','--stdin'],env,Buffer.concat(skip));
}
function candidateTree(cwd) {
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-proof-'));
  const git=(args,env=process.env)=>execFileSync('git',args,{cwd,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
  try {
    const env={...process.env,GIT_INDEX_FILE:path.join(scratch,'index')};
    seedIndex(cwd,env);
    git(['add','-A'],env);
    git(['rm','-r','--cached','-q','--ignore-unmatch','--','docs/tasks','docs/projects'],env);
    // add가 작업 바이트를 기록한 index의 지문이다. 큰 저장소의 기존 blob 존재 여부를 다시 읽지 않는다.
    // 실제 게시·병합 때는 커밋 blob/tree를 별도로 검증한다.
    return git(['write-tree','--missing-ok'],env);
  } finally { fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
}
// QA 실행 영수증 v2(발급기)의 후보 tree. CI 검증기가 실제 게시 커밋에서 보는 B→PR head 행과 같아지도록,
// 과정 문서 폴더를 통째로 빼지 않고 기준 커밋 B 대비 실제 변경에만 과정 산출물 게시 정책(artifact-policy violations)을 적용한다.
// 바뀌지 않은 추적 문서는 그대로 두어 행을 만들지 않는다. 게시 금지인 신규(A)는 빼고, 금지인 수정(M·T)은 B의 mode·blob으로 되돌린다.
// 삭제(D)와 보존 예외·commit:true의 변경은 실제 행 그대로 둔다. 선언이 없는 저장소는 docs/tasks·docs/projects를 기본 과정 문서 폴더로 본다.
// 실제 index와 v1 candidateTree는 바꾸지 않는다.
function processViolations(cwd, changes) {
  const file=path.join(cwd,'.agents','harness','config.json');
  const local=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  if(artifacts.configure(local).declared) return artifacts.violations(local,changes);
  return changes.filter(c=>c.status!=='D'&&/^docs\/(tasks|projects)\//.test(c.path));
}
function publishTree(cwd, base) {
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-proof-'));
  const git=(args,env=process.env,input)=>execFileSync('git',args,{cwd,env,input,encoding:'utf8',windowsHide:true,stdio:[input===undefined?'ignore':'pipe','pipe','pipe'],maxBuffer:64<<20,timeout:30000});
  try {
    const env={...process.env,GIT_INDEX_FILE:path.join(scratch,'index')};
    seedIndex(cwd,env);
    git(['add','-A'],env);
    const parts=git(['diff-index','--cached','--raw','--no-renames','--no-abbrev','-z',base],env).split('\0');
    const rows=[];
    for(let i=0;i+1<parts.length;i+=2){
      const [,mode,oid,status]=/^:(\d{6}) \d{6} ([0-9a-f]{40}) [0-9a-f]{40} ([A-Z])/.exec(parts[i])??[];
      if(status)rows.push({status,path:parts[i+1],mode,oid});
    }
    const blocked=new Set(processViolations(cwd,rows).map(v=>v.path));
    // update-index --index-info: mode 0은 index에서 제거, 그 밖은 B의 mode·blob으로 복원한다.
    const info=rows.filter(r=>blocked.has(r.path)).map(r=>(r.status==='A'?'0 '+'0'.repeat(40):r.mode+' '+r.oid)+'\t'+r.path+'\0').join('');
    if(info)git(['update-index','-z','--index-info'],env,info);
    return git(['write-tree','--missing-ok'],env).trim();
  } finally { fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
}
function verifyReceipt(cwd, since, base, receipt = 'target/sw-verify/latest-qa.json') {
  // 어댑터가 지정한 저장소 내부 runner 경로만 읽는다. 기존 SW 호출의 기본 경로는 유지한다.
  if (typeof receipt !== 'string' || !/^target\/[a-z0-9-]+\/latest-qa\.json$/.test(receipt)) throw new Error('QA runner 영수증 경로가 올바르지 않다.');
  const file=path.join(cwd,receipt);
  const r=JSON.parse(fs.readFileSync(file,'utf8'));
  if(r.version!==1 || r.role!=='qa' || !r.stable || !base || r.base!==base || r.scope!=='changed-paths' || !Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(r.completedAt)) || Date.parse(r.completedAt)<Date.parse(since)
    || !Array.isArray(r.checks) || !r.checks.length || r.checks.some(c=>!['passed','reused','unneeded'].includes(c.state))
    || r.tree!==candidateTree(cwd)) throw new Error('현재 후보의 독립 QA runner 증거가 없거나 불완전하다.');
  return {tree:r.tree,completedAt:r.completedAt,checks:r.checks};
}
module.exports={candidateTree,publishTree,verifyReceipt};
