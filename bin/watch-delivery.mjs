#!/usr/bin/env node
// CI 대기는 모델 없이 한다. Lead의 기존 CLI 잠금·신원 검사를 그대로 사용한다.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const { binding } = createRequire(import.meta.url)('../adapters/runtime.cjs');
const [file, id, minutes='120'] = process.argv.slice(2);
if (!file || !/^[A-Z][A-Z0-9]*-\d+$/.test(id ?? '') || !/^\d+$/.test(minutes) || +minutes<1 || +minutes>1440) throw new Error('사용법: watch-delivery.mjs <binding> <업무-ID> [최대 대기 분 1..1440]');
const b=binding(file), end=Date.now()+Number(minutes)*60000;
let finished=false;
while (Date.now()<end) {
  const r=spawnSync(process.execPath,[join(b.release,'bin/harness.mjs'),'--binding',file,'flow-deliver',id,'--apply'],{cwd:b.cwd,encoding:'utf8',windowsHide:true,timeout:180000});
  if (r.error || r.status!==0) { console.error(r.error?.message ?? r.stderr); process.exitCode=2; break; }
  const result=JSON.parse(r.stdout); console.log(JSON.stringify(result));
  if (result.phase!=='ci') {finished=true;break;}
  await new Promise(resolve=>setTimeout(resolve,30000));
}
if(!finished && !process.exitCode) {console.error(JSON.stringify({phase:'timeout',id,reason:'CI 대기 상한 도달: 상태 확인 후 같은 명령으로 재개한다.'}));process.exitCode=2;}
