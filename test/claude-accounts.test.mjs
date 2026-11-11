import test from 'node:test';
import assert from 'node:assert/strict';
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
