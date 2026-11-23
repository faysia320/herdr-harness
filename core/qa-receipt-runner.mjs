// 독립 QA 실행 영수증 v2 발급기. 저장소 정책이 요구한 검사를 대상 OS마다 공용 heavy 슬롯에서 하나씩 실행하고,
// 모두 통과하고 후보가 그대로일 때만 receipt.json과 PR 본문용 envelope.txt를 쓴다.
// Docker·이미지·사본 준비에 실패하면 영수증 없이 BLOCKED, 검사가 실패하면 FAIL이다. 하네스 독립 QA와 하네스 밖 PR이 같은 함수를 쓴다.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release as osRelease } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { runTree } from './process.js';

const require = createRequire(import.meta.url);
const { publishTree } = require('./verification-receipt.cjs');
const { renameRetry } = require('./atomic-rename.cjs');
const contract = require('./qa-receipt-policy.cjs');
export const runnerId = { id: 'herdr-qa-receipt', version: 1 };
export const hostName = () => contract.hostNames[process.platform] ?? process.platform;
// Docker 단계의 종료 코드 중 시험 실패가 아니라 실행 환경 문제인 것(docker run 오류, 사본 준비 실패).
const environmentCodes = new Set([90, 125, 126, 127]);
const tail = text => String(text ?? '').trim().split(/\r?\n/).slice(-3).join(' / ');

function gitIn(cwd) {
  return (...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: 60000 });
    if (r.error || r.status !== 0) throw Error('git ' + args[0] + ' 실패: ' + (r.error?.message ?? r.stderr.trim()));
    return r.stdout.includes('\0') ? r.stdout : r.stdout.trim();
  };
}
const version = command => {
  const r = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return r.status === 0 ? r.stdout.trim().replace(/^git version /, '') : null;
};
function atomicWrite(file, text) {
  writeFileSync(file + '.tmp', text);
  renameRetry(file + '.tmp', file);
}
class Blocked extends Error {}

// 컨테이너 안에서 실행하는 단계 스크립트. 읽기 전용 /input의 후보 tree 사본을 쓰기 가능한 /tmp에 풀고,
// Git이 다시 계산한 tree가 후보 tree와 같을 때만 정책 명령을 셸 없이 순서대로 실행한다.
function containerPhase() {
  const { execFileSync, spawnSync } = require('node:child_process');
  const fs = require('node:fs'), os = require('node:os');
  const started = Date.now();
  const input = JSON.parse(fs.readFileSync('/input/input.json', 'utf8'));
  const work = fs.mkdtempSync('/tmp/hh-qa-');
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
  try {
    run('tar', ['-xf', '/input/candidate.tar']);
    run('git', ['init', '-q']);
    run('git', ['add', '-A', '-f']);
    const tree = run('git', ['write-tree']);
    if (tree !== input.tree) throw Error('사본 tree ' + tree + '가 후보 tree ' + input.tree + '와 다르다.');
    run('git', ['-c', 'user.name=herdr-qa', '-c', 'user.email=qa@herdr.invalid', 'commit', '-q', '-m', 'candidate']);
    const distro = (fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]*)/m) ?? [])[1] ?? null;
    console.error('HH-QA-ENV ' + JSON.stringify({ os: 'linux', distro, release: os.release(), arch: process.arch, node: process.version,
      git: run('git', ['--version']).replace(/^git version /, ''), prepMs: Date.now() - started }));
  } catch (error) {
    console.error('HH-QA-PREP ' + error.message);
    process.exit(90);
  }
  for (const step of input.steps) {
    const r = spawnSync(step[0], step.slice(1), { cwd: work, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

// 호스트 검사는 정책 명령을 &&로 이어 heavy 슬롯 하나에서 실행한다. HH의 hh-suite는 기존 QA runner 명령과 같다.
export const heavyArgv = (heavy, steps) => [process.execPath, heavy, '--', ...steps.flatMap((step, i) => i ? ['&&', ...step] : step)];

async function hostCheck(ctx, platform, check) {
  if (ctx.hostOs !== platform) throw new Blocked(`이 PC(${ctx.hostOs})에서는 ${platform} 호스트 검사를 실행할 수 없다.`);
  const argv = heavyArgv(ctx.heavy, ctx.policy.checks[check].steps);
  const started = Date.now();
  const r = await ctx.exec(argv[0], argv.slice(1), { cwd: ctx.worktree, env: ctx.env, timeout: ctx.policy.checks[check].timeout_ms ?? ctx.timeout });
  return { argv, ...r, ms: Date.now() - started, env: { os: platform, release: osRelease(), arch: arch(), node: version('node'), git: version('git') } };
}

async function dockerCheck(ctx, platform, check) {
  const image = ctx.policy.platforms[platform].image;
  const docker = (args, timeout) => ctx.exec('docker', args, { cwd: ctx.worktree, env: ctx.env, timeout });
  const prepared = Date.now();
  const server = await docker(['version', '--format', '{{.Server.Os}}'], 60000);
  if (server.code !== 0 || server.stdout.trim() !== 'linux') throw new Blocked('Docker Linux 엔진에 연결할 수 없다: ' + tail(server.stderr || server.stdout));
  if ((await docker(['image', 'inspect', '--format', '{{.Id}}', image], 60000)).code !== 0) {
    const pulled = await docker(['pull', image], 30 * 60 * 1000);
    if (pulled.code !== 0) throw new Blocked('Linux 이미지를 준비할 수 없다: ' + image + ' ' + tail(pulled.stderr));
  }
  // 작업 사본 파일을 그대로 복사하지 않는다. 확정한 후보 tree를 Git에서 꺼내 줄 끝·실행 비트를 Git 기준으로 맞춘다.
  const input = join(ctx.out, platform + '-' + check);
  mkdirSync(input, { recursive: true });
  const archive = spawnSync('git', ['archive', '--format=tar', '-o', join(input, 'candidate.tar'), ctx.tree], { cwd: ctx.worktree, encoding: 'utf8', windowsHide: true });
  if (archive.status !== 0) throw new Blocked('후보 tree를 꺼낼 수 없다: ' + tail(archive.stderr));
  writeFileSync(join(input, 'phase.cjs'), `(${containerPhase})();\n`);
  writeFileSync(join(input, 'input.json'), JSON.stringify({ tree: ctx.tree, steps: ctx.policy.checks[check].steps }));
  const imageMs = Date.now() - prepared;
  const name = ('hh-qa-' + ctx.run + '-' + platform + '-' + check).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100);
  // heavy.mjs는 인수를 공백으로 이어 셸에 넘긴다. 동적 값은 정책이 검증한 image, 회차 이름, 따옴표로 감싼 ASCII 출력 경로뿐이다.
  // --init: 단계 스크립트가 PID 1이면 고아 손자 프로세스를 거두지 않아 좀비가 남는다. GitHub runner처럼 init이 거두게 한다.
  const argv = [process.execPath, ctx.heavy, '--', 'docker', 'run', '--rm', '--init', '--name', name, '--user', 'node',
    '--mount', `"type=bind,source=${input},target=/input,readonly"`, image, 'node', '/input/phase.cjs'];
  const started = Date.now();
  try {
    const r = await ctx.exec(argv[0], argv.slice(1), { cwd: ctx.worktree, env: ctx.env, timeout: ctx.policy.checks[check].timeout_ms ?? ctx.timeout });
    let env = null;
    const line = /^HH-QA-ENV (.+)$/m.exec(r.stderr)?.[1];
    try { env = line ? JSON.parse(line) : null; } catch { env = null; }
    if (environmentCodes.has(r.code) || (r.code === 0 && !env))
      throw new Blocked('Linux 컨테이너 실행·사본 준비 실패(exit ' + r.code + '): ' + tail(/^HH-QA-PREP (.+)$/m.exec(r.stderr)?.[1] ?? r.stderr));
    return { argv, ...r, ms: Date.now() - started, imageMs, env: env && { ...env, image } };
  } finally {
    // 시간 초과·중단으로 남은 컨테이너를 지운다. --rm으로 이미 없으면 실패를 무시한다. 사본 tar는 로그와 함께 보관하지 않는다.
    await docker(['rm', '-f', name], 60000);
    rmSync(input, { recursive: true, force: true });
  }
}

// OR(anyPlatform) 규칙은 이 PC에서 실행할 수 있는 플랫폼 하나만 고른다. AND 규칙이 이미 요구한 플랫폼, 이 PC의 host, Docker Linux 순이다.
function pickPlatforms(policy, paths, hostOs) {
  const fixed = new Set(contract.appliedRules(policy, paths).filter(rule => !rule.anyPlatform).flatMap(rule => rule.platforms));
  const runnable = p => policy.platforms[p].runner === 'docker' || p === hostOs;
  return rule => {
    if (!rule.anyPlatform) return rule.platforms;
    const options = rule.platforms.filter(runnable);
    const chosen = options.find(p => fixed.has(p)) ?? options.find(p => policy.platforms[p].runner === 'host') ?? options[0];
    if (!chosen) throw new Blocked(`이 PC(${hostOs})에서 실행할 수 있는 플랫폼이 없다(${rule.platforms.join('|')} 중 하나, 검사 ${rule.checks.join('·')}).`);
    return [chosen];
  };
}

export async function issueReceipt({ worktree, base, run, round = null, heavy, release = null, policyFile = 'policy/qa-receipt.json',
  hostOs = hostName(), exec = runTree, env = process.env, timeout = 45 * 60 * 1000, now = () => new Date().toISOString() }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(run ?? '')) throw Error('run은 영문·숫자·_.-로 된 회차 식별자여야 한다.');
  if (round !== null && !(Number.isSafeInteger(round) && round > 0)) throw Error('round는 양의 정수여야 한다.');
  if (!heavy || !existsSync(heavy)) throw Error('공용 heavy 슬롯 실행기(bin/heavy.mjs)를 찾을 수 없다: ' + heavy);
  const git = gitIn(worktree);
  const policy = contract.loadPolicy(resolve(worktree, policyFile));
  const rel = policy.output.replace(/\/$/, '') + '/' + run;
  // 후보 tree에 들어가지 않는 무시 경로에만 쓴다. 추적·미무시 경로에 쓰면 후보 지문이 바뀐다.
  if (spawnSync('git', ['check-ignore', '-q', '--', rel + '/receipt.json'], { cwd: worktree, windowsHide: true }).status !== 0)
    throw Error('정책 output 경로가 Git 무시 대상이 아니다: ' + rel);
  const commit = git('rev-parse', '--verify', base + '^{commit}');
  try { git('merge-base', '--is-ancestor', commit, 'HEAD'); } catch { throw Error('기준 커밋이 작업공간 HEAD의 조상이 아니다: ' + base); }
  const out = join(worktree, ...rel.split('/'));
  // 재시도를 시작하면 같은 회차의 이전 결과·영수증부터 지운다. 이전 PASS가 새 실행의 결과처럼 남지 않는다.
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const startedAt = now();
  // 후보는 B 대비 실제 변경에 과정 산출물 게시 정책을 적용한 tree다. CI가 게시 커밋에서 다시 세는 행과 같다.
  const tree = publishTree(worktree, commit);
  const binding = contract.candidateBinding(git, commit, commit, tree);
  const ctx = { worktree, policy, run, heavy, exec, timeout, hostOs, out, tree,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT')) };
  const environments = {}, results = [], outputs = [], phases = [], reasons = [];
  let status = 'PASS', pairs = [];
  try { pairs = contract.requiredPairs(policy, binding.paths, pickPlatforms(policy, binding.paths, hostOs)); } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    status = 'BLOCKED';
    reasons.push(error.message);
  }
  for (const { platform, check } of pairs) {
    const spec = policy.checks[check];
    let r;
    try {
      r = await (policy.platforms[platform].runner === 'host' ? hostCheck : dockerCheck)(ctx, platform, check);
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      status = 'BLOCKED';
      reasons.push(platform + '/' + check + ': ' + error.message);
      phases.push({ platform, check, state: 'blocked' });
      break;
    }
    const log = [JSON.stringify({ argv: r.argv, exit: r.code, run, tree, stdoutLength: r.stdout.length }), r.stdout, r.stderr].join('\n');
    const file = join(out, platform + '-' + check + '.log');
    writeFileSync(file, log);
    outputs.push({ platform, check, argv: r.argv, code: r.code, stdout: r.stdout, stderr: r.stderr, log: file });
    const tap = spec.result === 'tap' ? contract.tapSummary(r.stdout) : null;
    const passed = r.code === 0 && (spec.result !== 'tap' || contract.tapPassed(tap));
    const { durationMs, ...counts } = tap ?? {};
    results.push({ platform, check, steps: spec.steps, state: passed ? 'passed' : 'failed', exit: r.code, ...counts,
      ms: r.ms, ...(tap ? { testMs: Math.round(durationMs) } : {}), logDigest: contract.sha256(log) });
    phases.push({ platform, check, state: passed ? 'passed' : 'failed', exit: r.code, ms: r.ms, ...(r.imageMs !== undefined ? { imageMs: r.imageMs } : {}),
      ...(r.env?.prepMs !== undefined ? { prepMs: r.env.prepMs } : {}), ...(tap ? { testMs: Math.round(durationMs), tests: tap.tests } : {}) });
    if (r.env) environments[platform] = r.env;
    if (!passed) {
      status = 'FAIL';
      reasons.push(platform + '/' + check + ': ' + (r.code === 124 ? '시간 한도 초과' : 'exit ' + r.code + (tap ? `, tests ${tap.tests} pass ${tap.pass} fail ${tap.fail}` : '')) + ' (' + file + ')');
      break;
    }
  }
  if (status === 'PASS' && publishTree(worktree, commit) !== tree) {
    status = 'BLOCKED';
    reasons.push('검사 도중 후보가 바뀌었다. 후보를 고정한 뒤 다시 발급한다.');
  }
  const completedAt = now();
  const summary = { status, run, round, base: commit, tree, candidate: { digest: binding.digest, count: binding.count }, startedAt, completedAt, phases, reasons };
  atomicWrite(join(out, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  if (status !== 'PASS') return { ...summary, out, outputs };
  const receipt = { kind: contract.kind, version: 2, run, round, runner: runnerId, release, base: commit,
    candidate: { digest: binding.digest, count: binding.count }, tree, startedAt, completedAt, environments, results };
  const envelope = contract.encodeEnvelope(receipt);
  atomicWrite(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  atomicWrite(join(out, 'envelope.txt'), envelope + '\n');
  return { ...summary, out, outputs, receipt, envelope };
}

// heavy.mjs가 설치 release 안에 있으면 그 manifest 지문(폴더 이름)을 영수증 release로 남긴다.
// 저장소 사본(policy/qa-receipt-files.json)으로 발급하면 null이다. release는 선택 기록이고 CI 검증은 보지 않는다.
export function releaseOf(heavy) {
  const dir = dirname(dirname(resolve(heavy)));
  return /^[0-9a-f]{64}$/.test(basename(dir)) && existsSync(join(dir, 'manifest.json')) ? basename(dir) : null;
}
