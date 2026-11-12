import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEndpoint, profileFor } from '../core/herdr-browser.mjs';

test('브라우저 프로필 키는 상위 경로·절대 경로를 허용하지 않는다', () => {
  for (const key of ['../Default', 'C:/Chrome', '', 'a/b']) assert.throws(() => profileFor(key));
});

test('전용 프로필의 CDP 식별자가 일치하는 로컬 브라우저에만 연결한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-browser-'));
  try {
    writeFileSync(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/test-id\n');
    const response = (ws) => async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: ws, Browser: 'Chrome/test' }) });
    assert.ok(await readEndpoint(dir, response('ws://127.0.0.1:9222/devtools/browser/test-id')));
    for (const ws of ['ws://example.test:9222/devtools/browser/test-id', 'ws://127.0.0.1:9222/devtools/browser/other', 'ws://127.0.0.1:9223/devtools/browser/test-id']) {
      assert.equal(await readEndpoint(dir, response(ws)), null);
    }
    writeFileSync(join(dir, 'DevToolsActivePort'), '99999\n/devtools/browser/test-id\n');
    assert.equal(await readEndpoint(dir, () => { throw Error('must not request invalid port'); }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
