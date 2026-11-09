import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, parseStatus, graphRows, loadGit, READ } from './git-data.js';
const hash = (c) => c.repeat(40);
const commit = (id, parents = []) => ({ hash: id, parents });

test('한글·여러 줄 커밋 메시지와 HEAD·원격·태그를 보존한다', () => {
  const rows = parseLog(`\x1e${hash('a')}\x1f${hash('b')}\x1f이진영\x1f2026-11-09T10:00:00+09:00\x1fHEAD -> main, origin/main, tag: v1\x1f제목\n\n상세 설명\n`);
  assert.equal(rows[0].subject, '제목'); assert.equal(rows[0].message, '제목\n\n상세 설명');
  assert.equal(rows[0].refs.length, 3); assert.equal(rows[0].author, '이진영');
  assert.throws(() => parseLog('malformed'));
});
test('분기·병합이 같은 부모로 합류하고 무관한 레인은 이어진다', () => {
  const { rows, width } = graphRows([commit('merge', ['a', 'b']), commit('a', ['base']), commit('b', ['base']), commit('base')]);
  assert.equal(width, 2);
  assert.notEqual(rows[0].parents[0].lane, rows[0].parents[1].lane);
  assert.equal(rows[1].rails.length, 1);
  assert.equal(rows[2].parents[0].lane, rows[3].lane);
  assert.equal(rows[3].parents.length, 0);
  assert.ok(rows.slice(1).every((r) => r.incoming));
});
test('여러 tip·octopus 병합·잘린 이력의 부모를 잃지 않는다', () => {
  const { rows } = graphRows([commit('tip', ['old']), commit('merge', ['a', 'b', 'c']), commit('a', ['old']), commit('b', ['old']), commit('c', ['old'])]);
  assert.equal(new Set(rows[1].parents.map((p) => p.lane)).size, 3);
  assert.ok(rows.slice(2).every((r) => r.parents[0].hash === 'old'));
  assert.equal(rows[4].parents[0].lane, rows[0].parents[0].lane);
});
test('status는 추적 상태와 변경 파일을 분리하고 빈 저장소를 지원한다', async () => {
  assert.deepEqual(parseStatus('# branch.oid a\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 M. file\n? new\n'), { branch:'main', head:'a', upstream:'origin/main', ahead:2, behind:1, dirty:2 });
  let calls = 0;
  const data = await loadGit(async () => { calls++; return { code:0, stdout:'# branch.oid (initial)\n# branch.head main\n' }; }, 'fixture');
  assert.equal(calls, 1); assert.deepEqual(data.rows, []);
});
test('Git 실행은 인자 배열 읽기 전용이며 오류를 빈 기록으로 감추지 않는다', async () => {
  const calls=[];
  const result = await loadGit(async (command,args,options) => {
    calls.push({command,args,options});
    return {code:0, stdout:args.includes('status') ? '# branch.oid a\n# branch.head (detached)\n' : `\x1e${hash('a')}\x1f\x1fAuthor\x1f2026-11-09\x1fHEAD\x1fmessage\n`};
  }, 'D:/space and 한글', false);
  assert.equal(result.rows.length, 1); assert.equal(calls[1].args.includes('--all'), false);
  for(const c of calls){ assert.equal(c.command,'git'); assert.deepEqual(c.args.slice(0, READ.length),READ); assert.equal(c.options.cwd,'D:/space and 한글'); }
  await assert.rejects(loadGit(async () => ({code:128,stderr:'not a git repository'}),'fixture'), /not a git repository/);
});
