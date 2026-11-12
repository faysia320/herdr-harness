// 사용량 표시만 담당한다. 로그인·계정 전환은 Claude CLI의 /login을 사용한다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function status() {
  return { mode: 'manual-login', accounts: [{ key: 'claude', label: 'Claude', usageFile: join(homedir(), '.claude', 'usage-cache.json') }] };
}

export function codexUsage(root = join(homedir(), '.codex', 'sessions')) {
  const newest = (dir, depth) => {
    let names;
    try { names = readdirSync(dir).sort().reverse(); } catch { return []; }
    if (depth === 0) return names.filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n));
    for (const n of names) { const found = newest(join(dir, n), depth - 1); if (found.length) return found; }
    return [];
  };
  const files = newest(root, 3).map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(0, 5)) {
    const text = readFileSync(f, 'utf8'), lines = text.slice(Math.max(0, text.length - 400000)).split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"rate_limits"')) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const rl = ev.payload?.rate_limits;
      if (!rl) continue;
      const out = { updated: Math.floor(Date.parse(ev.timestamp) / 1000) || null, plan: rl.plan_type ?? null, five_hour: null, seven_day: null };
      for (const w of [rl.primary, rl.secondary]) {
        if (!w || typeof w.used_percent !== 'number') continue;
        out[w.window_minutes >= 1440 ? 'seven_day' : 'five_hour'] = { used: w.used_percent, reset: w.resets_at ?? null };
      }
      return out;
    }
  }
  return null;
}
