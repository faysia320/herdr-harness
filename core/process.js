import { spawnSync } from 'node:child_process';
export function run(command, args, { cwd, input, timeout = 120000, env = process.env } = {}) {
  const r = spawnSync(command, args, { cwd, input, env, timeout, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.error ? (r.error.code === 'ETIMEDOUT' ? 124 : 127) : r.status ?? 1,
    stdout: r.stdout ?? '', stderr: r.error ? `${r.stderr ?? ''}\n${r.error.message}` : r.stderr ?? '' };
}
