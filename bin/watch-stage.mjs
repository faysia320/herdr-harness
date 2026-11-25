#!/usr/bin/env node
// 조사·설계·구현·QA 단계 전환을 모델 없이 기다린다. Lead의 기존 CLI(show·collect·decision list·dispatch)와
// 그 잠금·신원·의존성 검사를 그대로 쓴다. 대장을 직접 쓰지 않고 새 상태·필드를 만들지 않는다.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparationStatus } from '../core/preparation.mjs';

const STAGES = ['research', 'architect', 'implement', 'qa'];
// 산출물 대기: HH stderr «아직 실행 중이다», SW stderr·VDP stdout JSON·VP stdout «아직 작업 중»(모두 exit 2).
const WAITING = /아직 (?:실행|작업) 중/;
// 감시기 여러 개가 같은 대장을 쓰면 잠금이 겹친다. 아무것도 바뀌지 않았으므로 다음 주기에 다시 시도한다.
const BUSY = /대장 잠금이 사용 중/;
const json = text => { try { return JSON.parse(text); } catch { return undefined; } };

// 반환 {code, result}. code 1은 Lead·사용자 판단이 필요한 정지 또는 대기 상한, 2는 CLI 오류·예상 밖 응답이다.
// slotFree는 준비 슬롯이 비었는지 알려 준다. 사용 중이면 launcher의 순서 대기에 들어가지 않고 여기서 마감을 보며 기다린다.
export async function watch({ id, hh, cli, sleep, now, deadline, interval = 30000, slotFree = () => true, log = () => {} }) {
  const dispatched = [];
  const stop = (code, t, reason) => ({ code, result: { id, state: t?.state ?? null, pending: t?.pending ?? null,
    phase: t?.x_flow?.phase ?? null, awaiting: t?.awaiting ?? null, dispatched, reason } });
  const fail = (what, r, t) => stop(2, t, `${what} 실패(exit ${r.code}): ${`${r.stderr}\n${r.stdout}`.trim().slice(0, 500)}`);
  let r, t;
  const show = () => { r = cli(['show', id]); const v = r.code === 0 ? json(r.stdout) : undefined; t = v?.id ? v : undefined; return t; };
  const late = what => now() >= deadline ? stop(1, t, `대기 상한 도달: ${what}`) : undefined;
  show();
  for (;;) {
    if (!t) return fail('show', r);
    if (['DONE', 'FAILED', 'BLOCKED'].includes(t.state)) return stop(1, t, `상태 ${t.state}`);
    // AC 승인·결정·진단·게시 차단 등은 awaiting으로, 게시(publish) 이후는 v2 phase로 드러난다.
    if (t.awaiting) return stop(1, t, `대기 ${t.awaiting}`);
    const phase = t.x_flow?.phase;
    if (phase && !['work', 'repair'].includes(phase)) return stop(1, t, `phase ${phase}`);
    if (t.current) {
      const c = cli(['collect', id]), out = json(c.stdout);
      if (c.code === 9 || out?.status === 'blocked') return stop(1, t, `에이전트가 사람 확인을 기다린다: ${(out?.note ?? c.stdout).trim().slice(0, 300)}`);
      if (c.code !== 0 && !(c.code === 2 && WAITING.test(c.stdout + c.stderr)) && !BUSY.test(c.stdout + c.stderr)) return fail('collect', c, t);
      const before = JSON.stringify(t.current);
      // 수집으로 회차가 닫히면 바로 다음 분기로 간다. 같은 회차가 남아 있으면 기다린 뒤 다시 수집한다.
      if (show() && JSON.stringify(t.current) === before) {
        const again = () => late('같은 명령으로 다시 감시한다.');
        if (again()) return again();
        await sleep(interval);
        if (again()) return again();
        show();
      }
      continue;
    }
    if (!STAGES.includes(t.pending)) return stop(1, t, '자동 위임할 다음 단계가 없다.');
    const skip = () => late(`${t.pending} 위임을 시작하지 않았다.`);
    if (skip()) return skip();
    const d = cli(['decision', 'list']), list = d.code === 0 ? json(d.stdout) : undefined;
    const requests = Array.isArray(list) ? list : list?.requests;
    if (!Array.isArray(requests)) return fail('decision list', d, t);
    const open = requests.filter(q => q?.status !== 'resolved' && (!q?.task || String(q.task).toUpperCase() === id));
    if (open.length) return stop(1, t, `열린 결정: ${open.map(q => q?.id).join(', ')}`);
    // 결정 조회·슬롯 대기 동안 마감이 지났으면 위임하지 않는다.
    if (skip()) return skip();
    if (!slotFree()) {
      log({ id, waiting: 'preparation-slot', pending: t.pending });
      await sleep(interval);
      if (skip()) return skip();
      show();
      continue;
    }
    // HH dispatch는 업무 ID만, SW·VDP·VP는 ID와 단계를 받는다.
    const g = cli(hh ? ['dispatch', id] : ['dispatch', id, t.pending]);
    if (g.code !== 0 && BUSY.test(g.stdout + g.stderr)) {
      log({ id, waiting: 'ledger-lock', pending: t.pending });
      await sleep(interval);
      if (skip()) return skip();
      show();
      continue;
    }
    if (g.code !== 0) return fail(`dispatch ${t.pending}`, g, t);
    dispatched.push(t.pending);
    log({ id, dispatched: t.pending });
    show();
  }
}

const main = import.meta.main ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (main) {
  const [file, id, minutes = '120'] = process.argv.slice(2);
  try {
    if (!file || !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+$/.test(id ?? '') || !/^\d+$/.test(minutes) || +minutes < 1 || +minutes > 1440)
      throw new Error('사용법: watch-stage.mjs <binding> <업무-ID> [최대 대기 분 1..1440]');
    const { binding } = createRequire(import.meta.url)('../adapters/runtime.cjs');
    const path = resolve(file), b = binding(path), launcher = fileURLToPath(new URL('./harness.mjs', import.meta.url));
    // 준비 슬롯 대기가 있는 dispatch를 자르지 않게 별도 제한시간을 두지 않는다. adapter 제한시간은 harness.mjs가 적용한다.
    const cli = args => {
      const p = spawnSync(process.execPath, [launcher, '--binding', path, ...args], { cwd: b.cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
      return { code: p.error ? null : p.status, stdout: p.stdout ?? '', stderr: p.error?.message ?? p.stderr ?? '' };
    };
    // launcher와 같은 환경(HERDR_PREPARATION_DIR)의 슬롯을 본다. 확인과 launcher 획득 사이에 다른 준비가 끼면 launcher가 기다린다.
    const { code, result } = await watch({ id, hh: b.project === 'herdr-harness', cli, now: Date.now, deadline: Date.now() + Number(minutes) * 60000,
      slotFree: () => preparationStatus().free,
      sleep: ms => new Promise(done => setTimeout(done, ms)), log: x => console.error(JSON.stringify(x)) });
    console.log(JSON.stringify(result));
    process.exitCode = code;
  } catch (e) { console.log(JSON.stringify({ id: id ?? null, reason: e.message })); process.exitCode = 2; }
}
