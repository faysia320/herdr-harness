const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
function candidateTree(cwd) {
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-proof-'));
  const git=(args,env=process.env)=>execFileSync('git',args,{cwd,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
  try {
    const index=path.join(scratch,'index'),real=path.resolve(cwd,git(['rev-parse','--git-path','index']));
    const env={...process.env,GIT_INDEX_FILE:index};
    if(fs.existsSync(real))fs.copyFileSync(real,index);else git(['read-tree','HEAD'],env);
    git(['add','-A'],env);
    git(['rm','-r','--cached','-q','--ignore-unmatch','--','docs/tasks','docs/projects'],env);
    // add가 작업 바이트를 기록한 index의 지문이다. 큰 저장소의 기존 blob 존재 여부를 다시 읽지 않는다.
    // 실제 게시·병합 때는 커밋 blob/tree를 별도로 검증한다.
    return git(['write-tree','--missing-ok'],env);
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
module.exports={candidateTree,verifyReceipt};
