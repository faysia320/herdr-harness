import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { slotRoot, acquire, release, status } from '../core/heavy-slots.mjs';

// 사용법: node heavy.mjs -- <명령>  (전체 시험·빌드를 공용 슬롯 안에서 실행)
//         node heavy.mjs status
const policy = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../policy/execution.json'), 'utf8'));
const slots = policy.resources.heavy_slots, dir = slotRoot();
const args = process.argv.slice(2);

if (args[0] === 'status') console.log(JSON.stringify({ dir, slots: status(dir, slots) }, null, 2));
else {
  const command = (args[0] === '--' ? args.slice(1) : args).join(' ').trim();
  if (!command) { console.error('사용법: node heavy.mjs -- <명령> | node heavy.mjs status'); process.exit(2); }
  const info = { pid: process.pid, cwd: process.cwd(), command, started: new Date().toISOString() };
  const slot = await acquire(dir, slots, info, {
    onWait: (waited, holders) => {
      if (waited % 60000) return;
      const busy = holders.filter((h) => !h.free).map((h) => `pid ${h.pid} ${h.cwd} «${h.command}» ${h.started}부터`).join(' / ');
      console.error(`[heavy] 슬롯 ${slots}개가 모두 사용 중이라 대기한다(${waited / 1000}초 경과): ${busy}`);
    },
  });
  console.error(`[heavy] 슬롯 ${slot.index + 1}/${slots}에서 실행: ${command}`);
  const child = spawn(command, { shell: true, stdio: 'inherit', windowsHide: true });
  const stop = () => child.kill();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, stop);
  const finish = (code) => { release(slot); process.exit(code); };
  child.on('error', (error) => { console.error(error.message); finish(1); });
  child.on('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
}
