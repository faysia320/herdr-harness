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
    return git(['write-tree'],env);
  } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
}
function verifyReceipt(cwd, since, base) {
  const file=path.join(cwd,'target/sw-verify/latest-qa.json');
  const r=JSON.parse(fs.readFileSync(file,'utf8'));
  if(r.version!==1 || r.role!=='qa' || !r.stable || !base || r.base!==base || r.scope!=='changed-paths' || !Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(r.completedAt)) || Date.parse(r.completedAt)<Date.parse(since)
    || !Array.isArray(r.checks) || !r.checks.length || r.checks.some(c=>!['passed','reused','unneeded'].includes(c.state))
    || r.tree!==candidateTree(cwd)) throw new Error('현재 후보의 독립 QA runner 증거가 없거나 불완전하다.');
  return {tree:r.tree,completedAt:r.completedAt,checks:r.checks};
}
module.exports={candidateTree,verifyReceipt};
