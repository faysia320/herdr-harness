import { spawn, spawnSync } from 'node:child_process';
export function run(command, args, { cwd, input, timeout = 120000, env = process.env } = {}) {
  const r = spawnSync(command, args, { cwd, input, env, timeout, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.error ? (r.error.code === 'ETIMEDOUT' ? 124 : 127) : r.status ?? 1,
    stdout: r.stdout ?? '', stderr: r.error ? `${r.stderr ?? ''}\n${r.error.message}` : r.stderr ?? '' };
}

// 시간이 다 되면 자식이 띄운 프로세스까지 끝낸다. spawnSync는 직접 자식만 끝내 git 같은 손자가 고아로 남는다.
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGKILL'); } catch { /* 이미 끝났다 */ }
}
export function runTree(command, args, { cwd, input, timeout = 120000, env = process.env, signal } = {}) {
  if (!(Number.isInteger(timeout) && timeout > 0 && timeout <= 2147483647)) return Promise.resolve({ code: 127, stdout: '', stderr: '실행 timeout은 1~2147483647 범위의 정수(ms)여야 한다.\n' });
  if (signal?.aborted) return Promise.resolve({ code: 130, stdout: '', stderr: '실행 전에 취소됐다.\n' });
  return new Promise((done) => {
    // POSIX는 새 프로세스 그룹으로 띄워 그룹 전체를 끝낸다. Windows는 taskkill /T가 자식 트리를 따라간다.
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    const out = [], err = [];
    let timedOut = false, cancelled = false, failed = null;
    child.stdout.on('data', (b) => out.push(b)); child.stderr.on('data', (b) => err.push(b));
    child.on('error', (e) => { failed = e; });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeout);
    const cancel = () => { cancelled = true; killTree(child.pid); };
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('close', (status) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
      if (timedOut) done({ code: 124, stdout, stderr: `${stderr}\n실행 시간 한도 ${timeout}ms를 넘겨 하위 프로세스까지 종료했다.` });
      else if (cancelled) done({ code: 130, stdout, stderr: `${stderr}\n실행을 취소하고 하위 프로세스까지 종료했다.` });
      else if (failed) done({ code: 127, stdout, stderr: `${stderr}\n${failed.message}` });
      else done({ code: status ?? 1, stdout, stderr });
    });
  });
}
