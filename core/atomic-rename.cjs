// 원자 저장의 마지막 단계(임시 파일 → 대상 rename) 공용 도우미. 임시 파일 생성·정리는 호출자가 맡는다.
// Windows에서 다른 프로세스(백신·색인·편집기)가 대상 파일을 잠시 열고 있으면 rename이 EPERM·EACCES·EBUSY로 실패한다.
// 그 경우만 100ms 간격으로 최대 20회(약 2초) 다시 시도하고, 끝내 실패하면 마지막 오류를 던진다. 다른 오류는 바로 던진다.
const fs = require('node:fs');

const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameRetry(from, to, { retries = 20, delay = 100 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (e) { if (!transient.has(e.code) || attempt >= retries) throw e; pause(delay); }
  }
}

module.exports = { renameRetry };
