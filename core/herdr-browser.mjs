import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

export const browserRoot = () => join(process.env.LOCALAPPDATA, 'HerdrBrowser');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export function projectId(cwd = process.cwd()) {
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true });
  const root = git.status === 0 ? dirname(git.stdout.trim()) : resolve(cwd);
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'project';
  const hash = createHash('sha256').update(root.replaceAll('\\', '/').toLowerCase()).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

export function profileFor(key, root = browserRoot()) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) throw new Error('Invalid browser project key');
  return join(root, 'profiles', key);
}

// Puppeteer resolves /json/version again whenever its browser disconnects.
// Keep discovery stable while Chrome's port and browser ID change on restart.
export async function browserDiscovery(key, ensure = ensureBrowser) {
  let pending;
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/json/version' || req.headers.origin) {
      res.writeHead(404).end(); return;
    }
    try {
      pending ??= ensure(key).finally(() => { pending = null; });
      const browser = await pending;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ Browser: browser.browser, webSocketDebuggerUrl: browser.wsEndpoint }));
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end(`Dedicated Chrome could not start: ${error.message}`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }) };
}

// Only attach to the browser endpoint recorded by this dedicated profile.
export async function readEndpoint(profile, request = fetch) {
  try {
    const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[a-z0-9-]+$/i.test(path)) return null;
    const url = `http://127.0.0.1:${Number(port)}`;
    const response = await request(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const info = await response.json(), ws = new URL(info.webSocketDebuggerUrl);
    if (ws.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(ws.hostname) || ws.port !== String(Number(port)) || ws.pathname !== path) return null;
    return { url, wsEndpoint: ws.href, browser: info.Browser };
  } catch { return null; }
}

function chromePath() {
  const paths = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).map((p) => join(p, 'Google/Chrome/Application/chrome.exe'));
  const found = paths.find(existsSync);
  if (!found) throw new Error('Google Chrome executable not found');
  return found;
}

export async function ensureBrowser(key = projectId()) {
  const profile = profileFor(key);
  mkdirSync(profile, { recursive: true });
  const lock = join(profile, '.herdr-launch-lock');
  const owner = join(lock, 'pid');
  let locked = false;
  for (let i = 0; i < 100; i++) {
    const existing = await readEndpoint(profile);
    if (existing) return { key, profile, ...existing, reused: true };
    try { mkdirSync(lock); locked = true; writeFileSync(owner, String(process.pid)); break; }
    catch (error) {
      if (locked) { try { unlinkSync(owner); } catch {} try { rmdirSync(lock); } catch {} throw error; }
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(owner, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (e) {
            if (e.code === 'ESRCH') { unlinkSync(owner); rmdirSync(lock); }
          }
        }
      } catch { /* Another launcher is creating or releasing its lock. */ }
      await pause(200);
    }
  }
  if (!locked) throw new Error('Another browser launch is still in progress');
  try {
    const existing = await readEndpoint(profile);
    if (existing) return { key, profile, ...existing, reused: true };
    const browser = spawn(chromePath(), [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--new-window', 'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', reject); });
    browser.unref();
    for (let i = 0; i < 100; i++) {
      const endpoint = await readEndpoint(profile);
      if (endpoint) return { key, profile, ...endpoint, reused: false };
      await pause(200);
    }
    throw new Error('Dedicated Chrome did not expose its debugging endpoint');
  } finally { unlinkSync(owner); rmdirSync(lock); }
}
