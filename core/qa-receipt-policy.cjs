// 독립 QA 실행 영수증 v2의 공유 계약. 발급기(core/qa-receipt-runner.mjs)와 저장소 CI(bin/verify-qa-receipt.mjs)가 같이 쓴다.
// CI가 release 없이 실행하므로 Node 내장 모듈과 git, 같은 폴더의 dev14.cjs만 쓴다.
// 서명하지 않는다. 지문은 후보와 검사 결과의 대응·누락을 확인할 뿐 발급자를 인증하지 않는다.
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { changes } = require('./dev14.cjs');

const kind = 'herdr-qa-receipt';
const marker = kind + ':v2';
const oid = /^[0-9a-f]{40}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hostNames = { win32: 'windows', linux: 'linux', darwin: 'macos' };
// 셸 없이 실행해도, heavy.mjs가 공백으로 이어 셸에 넘겨도 같은 뜻인 토큰만 받는다.
const token = /^[A-Za-z0-9_./:=@*+,-]+$/;
const relative = p => typeof p === 'string' && !/[\\:*?\x00-\x1f]/.test(p) && !p.startsWith('/') &&
  p.replace(/\/$/, '').split('/').every(part => part && part !== '.' && part !== '..');
const list = (value, ok) => Array.isArray(value) && value.length > 0 && value.every(ok) && new Set(value).size === value.length;

function validatePolicy(p) {
  const fail = message => { throw Error('QA 영수증 정책 오류: ' + message); };
  if (p?.version !== 1) fail('version 1이 필요하다.');
  if (!relative(p.output)) fail('output은 저장소 상대 경로여야 한다.');
  if (!Number.isSafeInteger(p.exempt_pr_max) || p.exempt_pr_max < 0) fail('exempt_pr_max는 0 이상의 정수여야 한다.');
  const platforms = Object.entries(p.platforms ?? {});
  if (!platforms.length) fail('platforms가 비었다.');
  for (const [id, spec] of platforms) {
    if (spec?.runner === 'host' ? !Object.values(hostNames).includes(id) :
      spec?.runner !== 'docker' || id !== 'linux' || !/^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/.test(spec.image ?? ''))
      fail('플랫폼은 host(windows·linux·macos) 또는 digest를 고정한 docker(linux)여야 한다: ' + id);
  }
  const checks = Object.entries(p.checks ?? {});
  if (!checks.length) fail('checks가 비었다.');
  for (const [id, spec] of checks) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(id) || !['tap', 'exit'].includes(spec?.result) ||
      !Array.isArray(spec.steps) || !spec.steps.length || !spec.steps.every(step => Array.isArray(step) && step.length && step.every(t => typeof t === 'string' && token.test(t))))
      fail('검사는 ID, result(tap·exit), 셸 특수문자 없는 steps 명령 배열이 필요하다: ' + id);
    // 검사별 실행 제한(ms). 생략하면 발급기 기본값(45분)이다. 실행기(runTree)가 받는 setTimeout 범위로 제한한다.
    if (spec.timeout_ms !== undefined && !(Number.isSafeInteger(spec.timeout_ms) && spec.timeout_ms > 0 && spec.timeout_ms <= 2147483647))
      fail('timeout_ms는 1~2147483647 사이 정수(ms)여야 한다: ' + id);
  }
  if (!Array.isArray(p.required) || !p.required.some(rule => rule?.paths === undefined)) fail('경로 조건 없는 기본 required 규칙이 필요하다.');
  for (const rule of p.required) {
    if (!list(rule?.checks, id => Object.hasOwn(p.checks, id)) || !list(rule.platforms, id => Object.hasOwn(p.platforms, id)) ||
      (rule.paths !== undefined && !list(rule.paths, relative)) || ![undefined, true, false].includes(rule.anyPlatform))
      fail('required 규칙은 선언된 checks·platforms, 저장소 상대 paths, 불리언 anyPlatform만 쓴다.');
  }
  return p;
}

function loadPolicy(file) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw Error('QA 영수증 정책을 읽을 수 없다: ' + error.message); }
  return validatePolicy(value);
}

// 변경 경로에 걸리는 규칙. 경로는 정확한 파일이거나 '/'로 끝나는 폴더다. 기본 규칙은 항상 적용한다.
// anyPlatform: true인 규칙은 나열한 플랫폼 중 하나에서 그 규칙의 checks가 모두 통과하면 된다(OR). 생략·false는 모든 플랫폼(AND)이다.
const appliedRules = (policy, paths) =>
  policy.required.filter(rule => !rule.paths || rule.paths.some(r => paths.some(p => r.endsWith('/') ? p.startsWith(r) : p === r)));

// 실행할 OS×검사 쌍의 합집합. pick(rule)이 규칙마다 실행할 플랫폼을 고른다. 기본은 나열한 모든 플랫폼이다.
function requiredPairs(policy, paths, pick = rule => rule.platforms) {
  const pairs = new Map();
  for (const rule of appliedRules(policy, paths))
    for (const platform of pick(rule)) for (const check of rule.checks) pairs.set(platform + '/' + check, { platform, check });
  const platforms = Object.keys(policy.platforms), checks = Object.keys(policy.checks);
  return [...pairs.values()].sort((a, b) => platforms.indexOf(a.platform) - platforms.indexOf(b.platform) || checks.indexOf(a.check) - checks.indexOf(b.check));
}

// 후보 지문: 영수증 기준 base와 from→tip의 raw 변경 행(경로, 양쪽 mode·blob, 상태). 이동은 삭제·추가 두 행이다.
// QA는 from=base, CI는 from=merge-base(main, PR head)로 계산한다. 독립적인 main 변경은 후보 경로의 행을 바꾸지 않는다.
function candidateBinding(git, base, from, tip) {
  if (!oid.test(base) || !oid.test(from)) throw Error('후보 기준 커밋 SHA가 올바르지 않다.');
  const rows = [...changes(git, from, tip)].map(([path, c]) => [path, c.raw])
    .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  return { base, count: rows.length, digest: sha256(JSON.stringify({ kind: 'herdr-qa-candidate', version: 1, base, rows })), paths: rows.map(r => r[0]) };
}

// node --test TAP 출력 끝의 요약. 요약이 끝에 없으면(잘림·중단) null이다.
function tapSummary(stdout) {
  if (typeof stdout !== 'string' || !/(?:^|\r?\n)TAP version 13\r?\n/.test(stdout)) return null;
  const m = /(?:^|\r?\n)# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)\r?\n# duration_ms (\d+(?:\.\d+)?)(?:\r?\n)*$/.exec(stdout);
  if (!m) return null;
  const [tests, pass, fail, cancelled, skipped, todo, durationMs] = m.slice(1).map(Number);
  return { tests, pass, fail, cancelled, skipped, todo, durationMs };
}
const tapPassed = s => Boolean(s) && Number.isSafeInteger(s.tests) && s.tests > 0 && s.pass === s.tests &&
  [s.fail, s.cancelled, s.skipped, s.todo].every(n => n === 0);

// PR 본문에 넣는 한 줄. 줄 맨 앞의 닫힌 HTML 주석이라 화면에 보이지 않고, 앞의 «남은 검증» 목록 판정도 바꾸지 않는다.
const encodeEnvelope = receipt => `<!-- ${marker} ${Buffer.from(JSON.stringify(receipt)).toString('base64url')} -->`;
function decodeEnvelope(body) {
  const lines = typeof body === 'string' ? body.split(/\r\n|\r|\n/).filter(line => line.includes(marker)) : [];
  if (!lines.length) throw Error(`PR 본문에 QA 실행 영수증(${marker})이 없다. 같은 runner로 발급한 envelope 줄을 본문에 넣는다.`);
  if (lines.length > 1) throw Error('PR 본문에 QA 실행 영수증 줄이 여러 개 있다. 마지막 발급분 한 줄만 남긴다.');
  const m = /^<!-- herdr-qa-receipt:v2 ([A-Za-z0-9_-]+) -->[ \t]*$/.exec(lines[0]);
  if (!m) throw Error('QA 실행 영수증 줄 형식이 다르다. 발급된 envelope 줄을 고치지 않고 줄 맨 앞에 넣는다.');
  try { return JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { throw Error('QA 실행 영수증을 해독할 수 없다(잘림·변조).'); }
}

// 한 OS×검사가 정확히 한 번, 정책과 같은 명령으로 통과했고 실행 환경이 기록됐는지. 문제 목록을 돌려준다.
function pairReasons(receipt, policy, platform, check) {
  const reasons = [], results = Array.isArray(receipt?.results) ? receipt.results : [];
  const label = platform + '/' + check, spec = policy.checks[check], found = results.filter(r => r?.platform === platform && r?.check === check);
  if (found.length !== 1) reasons.push((found.length ? '검사 결과 중복: ' : '필수 검사 결과 없음: ') + label);
  else if (found[0].state !== 'passed' || found[0].exit !== 0) reasons.push('통과하지 않은 검사: ' + label);
  else if (JSON.stringify(found[0].steps) !== JSON.stringify(spec.steps)) reasons.push('정책과 다른 명령: ' + label);
  else if (spec.result === 'tap' && !tapPassed(found[0])) reasons.push('시험 수·실패 기록이 통과 조건과 다르다: ' + label);
  const env = receipt?.environments?.[platform], image = policy.platforms[platform].image;
  if (env?.os !== platform || typeof env.node !== 'string' || typeof env.git !== 'string' || (image && env.image !== image))
    reasons.push('실행 환경 기록 없음·불일치: ' + platform);
  return reasons;
}

// 적용되는 규칙을 모두 충족하는지. AND 규칙은 나열한 OS×검사 전부, OR 규칙은 한 플랫폼에서 그 규칙의 검사 전부가 통과해야 한다.
// OR 규칙에서 검사를 여러 OS에 나눠 통과한 것은 인정하지 않는다.
function verifyResults(receipt, policy, paths) {
  const reasons = [];
  for (const rule of appliedRules(policy, paths)) {
    const tries = rule.platforms.map(platform => [...new Set(rule.checks.flatMap(check => pairReasons(receipt, policy, platform, check)))]);
    if (!rule.anyPlatform) reasons.push(...tries.flat());
    else if (tries.every(t => t.length))
      reasons.push(`플랫폼 하나(${rule.platforms.join('|')})에서 ${rule.checks.join('·')} 통과 필요: ` + tries.flat().join('; '));
  }
  return [...new Set(reasons)];
}

// actions/checkout의 PR merge 커밋은 첫 부모가 실제 main, 둘째 부모가 PR head다. 이벤트의 base.sha는 늦게 갱신될 수 있어 마지막 대안이다.
function defaultMain(git, pr) {
  const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1);
  if (parents.length === 2 && parents[1] === pr.head.sha) return parents[0];
  for (const ref of ['refs/remotes/origin/' + pr.base?.ref, pr.base?.sha]) {
    try { return git('rev-parse', '--verify', '-q', ref + '^{commit}'); } catch { /* 다음 후보 */ }
  }
  throw Error('비교할 main 커밋을 찾을 수 없다. actions/checkout에 fetch-depth: 0을 지정한다.');
}

function verifyPullRequest({ git, event, policy, main }) {
  const pr = event?.pull_request;
  if (!Number.isSafeInteger(pr?.number) || !oid.test(pr.head?.sha ?? '')) return { status: 'fail', reasons: ['pull_request 이벤트의 PR 번호·head가 없다.'] };
  const result = { pr: pr.number, head: pr.head.sha };
  if (pr.number <= policy.exempt_pr_max) return { ...result, status: 'exempt', reasons: [] };
  const fail = reason => ({ ...result, status: 'fail', reasons: [reason] });
  let receipt;
  try { receipt = decodeEnvelope(pr.body); } catch (error) { return fail(error.message); }
  if (receipt?.kind !== kind || receipt.version !== 2 || !oid.test(receipt.base ?? '') || typeof receipt.candidate?.digest !== 'string')
    return fail('QA 실행 영수증 v2 형식이 아니다.');
  try { git('merge-base', '--is-ancestor', receipt.base, pr.head.sha); } catch { return fail('영수증 기준 커밋이 PR head의 조상이 아니다: ' + receipt.base); }
  const mainCommit = main ? git('rev-parse', '--verify', main + '^{commit}') : defaultMain(git, pr);
  const from = git('merge-base', mainCommit, pr.head.sha);
  const binding = candidateBinding(git, receipt.base, from, pr.head.sha);
  const reasons = [];
  if (binding.digest !== receipt.candidate.digest || binding.count !== receipt.candidate.count)
    reasons.push(`후보 지문 불일치(영수증 ${receipt.candidate.count}개 경로, PR ${binding.count}개 경로). PR 변경이 QA 뒤에 바뀌었거나 main이 후보 경로를 바꿨다. 같은 runner로 다시 발급한다.`);
  reasons.push(...verifyResults(receipt, policy, binding.paths));
  return { ...result, status: reasons.length ? 'fail' : 'pass', reasons, run: receipt.run ?? null, round: receipt.round ?? null,
    base: receipt.base, main: mainCommit, from, candidate: { digest: binding.digest, count: binding.count } };
}

module.exports = { kind, marker, hostNames, sha256, validatePolicy, loadPolicy, appliedRules, requiredPairs, candidateBinding, tapSummary, tapPassed,
  encodeEnvelope, decodeEnvelope, verifyResults, verifyPullRequest };
