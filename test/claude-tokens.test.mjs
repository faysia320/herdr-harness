import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tokenEnvironment } from '../core/claude-tokens.mjs';
import { migrateConversation } from '../core/claude-conversations.mjs';

test('실행기는 계정 선택과 CLI 옵션을 보존하고 토큰을 실행 인자·세션 기록에 쓰지 않는다', () => {
  const source=readFileSync(new URL('../bin/claude-token-run.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
  const child=new EventEmitter(); child.pid=123; child.kill=()=>{};
  const calls=[], records=[];
  const processMock={argv:['node','launcher','--account','b','--','--resume','session-id','--model','opus'],env:{},on(){},exitCode:null};
  const api={
    process:processMock, console:{error:message=>{throw new Error(message);}},
    tokenStore:()=>({active:'a',configDir:'shared'}),
    readToken:key=>{assert.equal(key,'b');return 'secret-test-only';},
    tokenEnvironment:(key,token)=>({HERDR_CLAUDE_USAGE_DIR:'usage',CLAUDE_CODE_OAUTH_TOKEN:token}),
    tokenRecord:()=> 'record.json',homedir:()=> 'home',join,mkdirSync(){},dirname:()=>'.',
    writeFileSync:(path,content)=>records.push(content),unlinkSync(){},
    spawn:(exe,argv,options)=>{calls.push({exe,argv,options});return child;},
  };
  new Function(...Object.keys(api),source)(...Object.values(api));
  child.emit('spawn'); child.emit('exit',0);
  assert.deepEqual(calls[0].argv,['--resume','session-id','--model','opus']);
  assert.equal(calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN,'secret-test-only');
  assert.ok(!JSON.stringify(calls[0].argv).includes('secret-test-only'));
  assert.ok(!records.join('').includes('secret-test-only'));
  assert.equal(JSON.parse(records[0]).account,'b');
  assert.equal(processMock.exitCode,0);
});

test('토큰 선택은 자식 환경만 바꾸고 공통 설정 및 MCP 환경은 유지한다', () => {
  const inherited = { claude_config_dir: 'old-b', anthropic_api_key: 'old', CLAUDE_CODE_OAUTH_TOKEN: 'old', MCP_TEST: 'keep' };
  const store = { configDir: join(tmpdir(), 'common-config') };
  const a = tokenEnvironment('a', 'test-a', inherited, store);
  const b = tokenEnvironment('b', 'test-b', a, store);
  assert.equal(a.CLAUDE_CONFIG_DIR, b.CLAUDE_CONFIG_DIR);
  assert.equal(a.CLAUDE_CODE_OAUTH_TOKEN, 'test-a');
  assert.equal(b.CLAUDE_CODE_OAUTH_TOKEN, 'test-b');
  assert.equal(b.MCP_TEST, 'keep');
  assert.equal(b.anthropic_api_key, undefined);
  assert.equal(b.claude_config_dir, undefined);
  assert.notEqual(a.HERDR_CLAUDE_USAGE_DIR, b.HERDR_CLAUDE_USAGE_DIR);
  assert.equal(inherited.CLAUDE_CODE_OAUTH_TOKEN, 'old');
  // Default Claude config uses ~/.claude.json, not ~/.claude/.claude.json.
  assert.equal(tokenEnvironment('a', 'test', inherited, {configDir:join(homedir(),'.claude')}).CLAUDE_CONFIG_DIR, undefined);
});

test('Windows DPAPI 등록·선택은 credentials와 설정을 건드리지 않고 상태에 토큰을 노출하지 않는다', { skip: process.platform !== 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'harness-token-'));
  const env = {...Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase() !== 'PSMODULEPATH')), USERPROFILE: home, HOME: home};
  const module = new URL('../core/claude-tokens.mjs', import.meta.url).href;
  const secret = 'sk-ant-oat01-' + 'testonly'.repeat(5);
  try {
    mkdirSync(join(home,'.claude'),{recursive:true});
    writeFileSync(join(home,'.claude','.credentials.json'),'untouched');
    writeFileSync(join(home,'.claude','settings.json'),'untouched');
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      "$p=Join-Path $env:USERPROFILE '.config/herdr-harness/tokens'; New-Item -ItemType Directory -Force $p | Out-Null; ConvertTo-SecureString $env:TEST_TOKEN -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $p 'b.dpapi')"], {env:{...env,TEST_TOKEN:secret},windowsHide:true});
    const output = execFileSync(process.execPath,['--input-type=module','-e',`
      import assert from 'node:assert/strict';
      const m=await import(${JSON.stringify(module)});
      m.registerToken('b','B');
      assert.equal(m.readToken('b'), process.env.TEST_TOKEN);
      assert.equal(m.tokenUse('b').accounts[0].active,true);
      assert.throws(()=>m.tokenUse('a'),/등록/);
      assert.equal(m.tokenStore().active,'b');
      console.log(JSON.stringify(m.tokenStatus()));
    `],{env:{...env,TEST_TOKEN:secret},encoding:'utf8',windowsHide:true});
    assert.ok(!output.includes(secret));
    assert.ok(!readFileSync(join(home,'.config/herdr-harness/tokens/b.dpapi'),'utf8').includes(secret));
    assert.equal(readFileSync(join(home,'.claude/.credentials.json'),'utf8'),'untouched');
    assert.equal(readFileSync(join(home,'.claude/settings.json'),'utf8'),'untouched');
    writeFileSync(join(home,'.config/herdr-harness/tokens/b.dpapi'),'invalid encrypted value');
    const failed=spawnSync(process.execPath,[new URL('../bin/claude-token-run.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),'--','--version'],{env,encoding:'utf8',windowsHide:true});
    assert.equal(failed.status,2);
    assert.match(failed.stderr,/복호화 실패/);
    assert.ok(!failed.stderr.includes(secret));
  } finally { rmSync(home,{recursive:true,force:true}); }
});

test('이전 대화만 이관하고 목적지 사본을 백업하며 인증정보는 복사하지 않는다', () => {
  const root=mkdtempSync(join(tmpdir(),'harness-conversation-'));
  try {
    const from=join(root,'old'),to=join(root,'common');
    for(const dir of [from,to]) mkdirSync(join(dir,'projects','repo'),{recursive:true});
    writeFileSync(join(from,'projects/repo/session-1.jsonl'),'final conversation');
    writeFileSync(join(from,'projects/repo/other.jsonl'),'other');
    writeFileSync(join(from,'.credentials.json'),'secret');
    writeFileSync(join(to,'projects/repo/session-1.jsonl'),'older copy');
    migrateConversation({configDir:from,sessionId:'session-1'},to);
    assert.equal(readFileSync(join(to,'projects/repo/session-1.jsonl'),'utf8'),'final conversation');
    assert.ok(existsSync(join(to,'harness-migration-backups')));
    assert.ok(!existsSync(join(to,'projects/repo/other.jsonl')));
    assert.ok(!existsSync(join(to,'.credentials.json')));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
