import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { browserRoot, ensureBrowser, projectId, browserDiscovery } from '../core/herdr-browser.mjs';

try {
  const [mode = 'mcp', key = projectId()] = process.argv.slice(2);
  if (!['mcp', 'open'].includes(mode)) throw new Error('Usage: herdr-browser.mjs [mcp|open] [project-key]');
  const entry = join(browserRoot(), 'tools/node_modules/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js');
  if (mode === 'mcp' && !existsSync(entry)) throw new Error('Install chrome-devtools-mcp into LOCALAPPDATA/HerdrBrowser/tools first');
  if (mode === 'open') console.log(JSON.stringify(await ensureBrowser(key)));
  else {
    const discovery = await browserDiscovery(key);
    const server = spawn(process.execPath, [entry, '--browserUrl', discovery.url, '--no-usage-statistics', '--no-performance-crux'], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' },
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill());
    server.on('error', (error) => { console.error(error.message); process.exitCode = 1; void discovery.close(); });
    server.on('exit', (code) => { process.exitCode = code ?? 1; void discovery.close(); });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
