import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { limitStopped, SHARED_DIRS } from '../core/claude-accounts.mjs';

test('한도 도달 화면만 한도로 멈춤으로 보고 작업 중이거나 오래된 줄은 무시한다', () => {
  for (const text of ['Claude usage limit reached. Your limit will reset at 3pm (Asia/Seoul).', "You've hit your limit · resets 3pm", '5-hour limit reached ∙ resets 11am', "You've reached your weekly limit"]) {
    assert.equal(limitStopped(`작업 로그\n${text}\n> `, 'idle'), true, text);
    assert.equal(limitStopped(text, 'working'), false, text);
  }
  assert.equal(limitStopped('구현 완료. receipt를 남겼다.\n> ', 'done'), false);
  // 오래전에 지나간 줄(마지막 15줄 밖)은 지금 상태로 보지 않는다.
  assert.equal(limitStopped(`Claude usage limit reached\n${'줄\n'.repeat(20)}> `, 'idle'), false);
});

test('다른 계정에서 같은 대화를 이어 가도록 대화 기록 폴더를 공유한다', () => {
  assert.ok(SHARED_DIRS.includes('projects'));
  assert.ok(!SHARED_DIRS.includes('.credentials.json'));
});

test('새 계정은 인증·식별자를 복제하지 않고 기존 계정 설정은 보존한다', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-accounts-'));
  const write = (path, value) => writeFileSync(path, JSON.stringify(value));
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  try {
    mkdirSync(join(home, '.claude'));
    write(join(home, '.claude.json'), {
      machineID: 'device-a', anonymousId: 'anonymous-a', oauthAccount: { emailAddress: 'a@example.test' },
      userID: 'user-a', cachedAccount: {}, hasCompletedOnboarding: true,
    });
    write(join(home, '.claude', '.credentials.json'), { secret: 'must-not-copy' });
    write(join(home, '.claude', 'settings.json'), { remoteControlAtStartup: true, model: 'original' });
    const moduleUrl = new URL('../core/claude-accounts.mjs', import.meta.url).href;
    const run = (code) => execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { homedir } from 'node:os';
      import assert from 'node:assert/strict';
      assert.equal(homedir(), ${JSON.stringify(home)});
      const { setup, syncSettings } = await import(${JSON.stringify(moduleUrl)});
      ${code}
    `], { env: { ...process.env, USERPROFILE: home, HOME: home }, windowsHide: true });
    run("setup('b')");
    const config = join(home, '.claude-b', '.claude.json');
    assert.deepEqual(read(config), { hasCompletedOnboarding: true });
    assert.equal(read(join(home, '.claude-b', 'settings.json')).remoteControlAtStartup, true);
    assert.throws(() => read(join(home, '.claude-b', '.credentials.json')), { code: 'ENOENT' });

    const own = { machineID: 'device-b', anonymousId: 'anonymous-b', oauthAccount: { emailAddress: 'b@example.test' } };
    write(config, own);
    write(join(home, '.claude-b', '.credentials.json'), { secret: 'keep-b' });
    write(join(home, '.claude-b', 'settings.json'), { remoteControlAtStartup: false, model: 'old' });
    write(join(home, '.claude', 'settings.json'), { remoteControlAtStartup: true, model: 'updated' });
    run("setup('b'); syncSettings((await import('node:path')).join(homedir(), '.claude-b'))");
    assert.deepEqual(read(config), own);
    assert.deepEqual(read(join(home, '.claude-b', '.credentials.json')), { secret: 'keep-b' });
    assert.deepEqual(read(join(home, '.claude-b', 'settings.json')), { remoteControlAtStartup: false, model: 'updated' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
