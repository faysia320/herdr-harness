import { openSync, closeSync, fstatSync, readSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metricsRoot, metricRecord } from '../core/metrics.mjs';
import { preparationRoot, preparationStatus } from '../core/preparation.mjs';
import { slotRoot, status } from '../core/heavy-slots.mjs';

const limit = 200;
const byteLimit = 256 * 1024;
const policy = JSON.parse(readFileSync(new URL('../policy/execution.json', import.meta.url), 'utf8'));

// 끝에서 블록 단위로 읽는다. 지나치게 긴 행이나 UTF-8 문자 중간에서 시작한 첫 조각은 버린다.
function recentLines(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, floor = Math.max(0, size - byteLimit);
    let position = size, newlines = 0;
    const chunks = [];
    while (position > floor && newlines <= limit) {
      const length = Math.min(8192, position - floor), chunk = Buffer.alloc(length);
      position -= length;
      const count = readSync(fd, chunk, 0, length, position);
      if (count !== length) return []; // 조회 중 파일이 잘렸다. 다음 조회에서 다시 읽는다.
      for (const byte of chunk) if (byte === 10) newlines++;
      chunks.push(chunk);
    }
    const lines = Buffer.concat(chunks.reverse()).toString('utf8').split('\n');
    if (position > 0) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-limit);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function percentiles(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return [0.50, 0.95].map(p => values[Math.ceil(p * values.length) - 1]);
}

function projectMetrics(dir) {
  const projects = new Map();
  for (const expected of ['preparation', 'deps-install']) {
    for (const line of recentLines(join(dir, expected + '.jsonl'))) {
      let row;
      try {
        const { v, kind, at, pid, ...data } = JSON.parse(line);
        if (v !== 1 || kind !== expected || typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || !Number.isInteger(pid) || pid <= 0) continue;
        metricRecord(kind, data); // 기록 CLI와 같은 필드 규약을 적용한다.
        row = data;
      } catch { continue; }
      if (!projects.has(row.project)) projects.set(row.project, {
        project: row.project, waits: [], runs: [], missed: 0, nonzero: 0, noExit: 0, installs: 0, totalMs: 0, methods: {},
      });
      const group = projects.get(row.project);
      if (expected === 'preparation') {
        group.waits.push(row.wait_ms);
        if (row.acquired) group.runs.push(row.run_ms);
        else group.missed++;
        if (row.exit === null) group.noExit++;
        else if (row.exit !== 0) group.nonzero++;
      } else {
        group.installs++;
        group.totalMs += row.install_ms;
        group.methods[row.import_method] = (group.methods[row.import_method] ?? 0) + 1;
      }
    }
  }
  return [...projects.values()].sort((a, b) => a.project.localeCompare(b.project)).map(g => ({
    project: g.project, preparations: g.waits.length, acquired: g.runs.length,
    wait: percentiles(g.waits), run: percentiles(g.runs), missed: g.missed, nonzero: g.nonzero, noExit: g.noExit,
    installs: g.installs, installMean: g.installs ? Math.round(g.totalMs / g.installs) : null, methods: g.methods,
  }));
}

function slot(free, holder, alive) {
  if (free) return { state: 'free' };
  if (alive === null) return { state: 'unknown' };
  return { state: alive ? 'busy' : 'stale', pid: holder.pid, started: holder.started ?? null };
}

export function resourceStatus(env = process.env) {
  const prep = preparationStatus(preparationRoot(env));
  const preparation = slot(prep.free, prep.holder, prep.alive);
  if (typeof prep.holder?.project === 'string') preparation.project = prep.holder.project;
  const heavy = status(slotRoot(env), policy.resources.heavy_slots).map(h => slot(h.free, h, h.alive));
  return { preparation, heavy, projects: projectMetrics(metricsRoot(env)), limit };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(resourceStatus())); }
  catch (err) { console.error(err.message); process.exitCode = 2; }
}
