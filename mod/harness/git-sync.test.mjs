import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { syncGit } from './git-data.js';

test('Pull은 현재 브랜치·upstream 재검증 뒤에만 실행한다', async () => {
  for (const status of ['# branch.head other\n# branch.upstream origin/other\n','# branch.head (detached)\n','# branch.head main\n']) {
    let calls=0;
    await assert.rejects(syncGit(async()=>{calls++;return {code:0,stdout:status};},'fixture','pull','main'));
    assert.equal(calls,1);
  }
  await assert.rejects(syncGit(()=>{throw Error('실행하면 안 됨');},'fixture','push'),/지원하지/);
});

test('격리 Git: Fetch는 HEAD 유지, Pull은 ff-only, 로컬 변경·갈라진 이력은 보존', async (t) => {
  const root=mkdtempSync(join(tmpdir(),'herdr-git-sync-'));
  // 시험에서 만든 정확한 임시 폴더만 정리한다.
  t.after(()=>{const target=resolve(root);assert.ok(target.startsWith(resolve(tmpdir())+sep+'herdr-git-sync-'));rmSync(target,{recursive:true,force:true});});
  const remote=join(root,'remote.git'), seed=join(root,'seed'), local=join(root,'local');mkdirSync(seed);
  const exec=async(command,args,options)=>{const r=spawnSync(command,args,{cwd:options.cwd,encoding:'utf8',windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});return {code:r.status ?? 1,stdout:r.stdout ?? '',stderr:r.stderr ?? String(r.error ?? '')};};
  const git=(cwd,...args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const identity=(cwd)=>{git(cwd,'config','user.name','Herdr test');git(cwd,'config','user.email','test@example.invalid');};
  git(root,'init','--bare','--initial-branch=main',remote);git(seed,'init','--initial-branch=main');identity(seed);
  writeFileSync(join(seed,'file.txt'),'initial\n');git(seed,'add','.');git(seed,'commit','-m','initial');git(seed,'remote','add','origin',remote);git(seed,'push','-u','origin','main');
  git(root,'clone',remote,local);identity(local);const initial=git(local,'rev-parse','HEAD');
  writeFileSync(join(seed,'next.txt'),'next\n');git(seed,'add','.');git(seed,'commit','-m','next');git(seed,'push');
  const next=git(seed,'rev-parse','HEAD');await syncGit(exec,local,'fetch','main');
  assert.equal(git(local,'rev-parse','HEAD'),initial);assert.equal(git(local,'rev-parse','origin/main'),next);
  await syncGit(exec,local,'pull','main');assert.equal(git(local,'rev-parse','HEAD'),next);
  writeFileSync(join(local,'file.txt'),'local uncommitted\n');
  writeFileSync(join(seed,'file.txt'),'remote update\n');git(seed,'add','.');git(seed,'commit','-m','remote update');git(seed,'push');
  await assert.rejects(syncGit(exec,local,'pull','main'));
  assert.equal(readFileSync(join(local,'file.txt'),'utf8'),'local uncommitted\n');assert.equal(git(local,'rev-parse','HEAD'),next);
  git(local,'add','.');git(local,'commit','-m','local divergence');const diverged=git(local,'rev-parse','HEAD');
  await assert.rejects(syncGit(exec,local,'pull','main'));
  assert.equal(git(local,'rev-parse','HEAD'),diverged);assert.equal(git(local,'stash','list'),'');
});
