import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from '../scripts/build.mjs';
import { metricRecord } from '../core/metrics.mjs';
import { resourceStatus } from '../bin/resource-status.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-resource-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const metrics = join(root, 'metrics'), prep = join(root, 'prep'), heavy = join(root, 'heavy');
  const env = { HERDR_PREPARATION_DIR: prep, HERDR_HEAVY_DIR: heavy, HERDR_METRICS_DIR: metrics };
  return { root, prep, heavy, metrics, env };
}
const preparation = (project, wait_ms, run_ms, acquired = true, exit = 0) =>
  metricRecord('preparation', { project, wait_ms, run_ms, acquired, exit, command: 'dispatch' });
const install = (project, install_ms, import_method) => metricRecord('deps-install',
  { project, worktree: '작업', trigger: 'first-use', install_ms, import_method, result: 'ok' });

test('배포된 읽기 전용 자원 조회는 빈 상태 폴더를 만들지 않는다', t => {
  const f = fixture(t), cli = join(build().release, 'bin/resource-status.mjs');
  const value = JSON.parse(execFileSync(process.execPath, [cli], { env: { ...process.env, ...f.env }, encoding: 'utf8' }));
  assert.equal(value.preparation.state, 'free');
  assert.deepEqual(value.heavy.map(s => s.state), ['free', 'free']);
  assert.deepEqual(value.projects, []);
  assert.deepEqual(readdirSync(f.root), []);
});

test('점유·죽은 잠금·깨진 잠금을 구분하고 명령 원문과 토큰을 노출하거나 잠금을 고치지 않는다', t => {
  const f = fixture(t);
  mkdirSync(f.prep); mkdirSync(f.heavy);
  const holder = { project: 'SW', pid: process.pid, started: new Date().toISOString(), token: 'private-token', command: 'private-command' };
  const file = join(f.prep, 'active.json');
  writeFileSync(file, JSON.stringify(holder));
  writeFileSync(join(f.heavy, 'slot-0.json'), JSON.stringify({ ...holder, pid: 2147483647 }));
  writeFileSync(join(f.heavy, 'slot-1.json'), '{');
  const r = resourceStatus(f.env);
  assert.deepEqual(r.preparation, { state: 'busy', pid: holder.pid, started: holder.started, project: 'SW' });
  assert.deepEqual(r.heavy.map(s => s.state), ['stale', 'unknown']);
  assert.doesNotMatch(JSON.stringify(r), /private-/);
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(holder));
  assert.equal(readFileSync(join(f.heavy, 'slot-1.json'), 'utf8'), '{');
  writeFileSync(file, '{');
  assert.deepEqual(resourceStatus(f.env).preparation, { state: 'unknown' });
});

test('최근 물리 행에서만 프로젝트별 p50/p95, 미획득, 종료 코드, 평균 설치와 방식을 센다', t => {
  const f = fixture(t); mkdirSync(f.metrics);
  const rows = [JSON.stringify(preparation('이전', 0, 0)), 'not json'];
  // 마지막 200개 물리 행만 본다. 손상 행도 이 한도를 소비한다.
  for (let i = 1; i <= 193; i++) rows.push(JSON.stringify(preparation('SW', i, i * 10)));
  rows.push(JSON.stringify(preparation('SW', 5000, 0, false, null)), JSON.stringify(preparation('SW', 150, 15, true, 124)),
    '{', 'null', JSON.stringify({ ...preparation('오류', 1, 1), run_ms: -1 }),
    JSON.stringify({ ...preparation('오류', 1, 1), v: 2 }), JSON.stringify(preparation('VDP', 35, 0, false, 130)));
  writeFileSync(join(f.metrics, 'preparation.jsonl'), rows.join('\r\n') + '\r\n');
  const deps = [install('SW', 3000, 'hardlink'), install('SW', 6000, 'unknown'), install('SW', 1500, 'hardlink'), install('VP', 50, 'copy')];
  writeFileSync(join(f.metrics, 'deps-install.jsonl'), deps.map(JSON.stringify).join('\n'));
  const projects = resourceStatus(f.env).projects;
  assert.deepEqual(projects.map(g => g.project), ['SW', 'VDP', 'VP']);
  const [sw, vdp, vp] = projects;
  assert.deepEqual([sw.preparations, sw.acquired, sw.missed, sw.nonzero, sw.noExit], [195, 194, 1, 1, 1]);
  assert.deepEqual(sw.wait, [98, 185]);
  assert.deepEqual(sw.run, [960, 1840]);
  assert.deepEqual([sw.installMean, sw.installs, sw.methods], [3500, 3, { hardlink: 2, unknown: 1 }]);
  assert.deepEqual([vdp.run, vdp.nonzero, vp.wait], [null, 1, null]);
});

test('매우 긴 손상 행도 뒤쪽의 UTF-8 정상 행을 보존하고 바이트 한도 앞의 기록은 제외한다', t => {
  const f = fixture(t); mkdirSync(f.metrics);
  const rows = [JSON.stringify(install('이전', 1, 'clone')), 'x'.repeat(300 * 1024), JSON.stringify(install('프로젝트', 5, 'copy')), '{"부분":'];
  writeFileSync(join(f.metrics, 'deps-install.jsonl'), rows.join('\n'));
  assert.deepEqual(resourceStatus(f.env).projects.map(p => [p.project, p.installs]), [['프로젝트', 1]]);
});
