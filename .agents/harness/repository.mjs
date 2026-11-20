import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const configPath = fileURLToPath(new URL('./config.json', import.meta.url));
export const config = JSON.parse(readFileSync(configPath, 'utf8'));
export const project = config.project.id;
export const repository = config.project.remote_pattern;
export const adapter = require('../../adapters/runtime.cjs');
export const now = () => new Date().toISOString();
export const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export const check = (ok, message) => { if (!ok) throw new Error(message); };
export function samePath(a, b) {
  const normalize = p => {
    const absolute = realpathSync.native(p);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  return normalize(a) === normalize(b);
}

export function command(cwd, file, args, encoding = 'utf8') {
  try {
    return execFileSync(file, args, {
      cwd, encoding, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 64 << 20,
    });
  } catch (error) {
    throw new Error(String(error.stderr || error.message).trim(), { cause: error });
  }
}
export function git(cwd, ...args) {
  const out = command(cwd, 'git', args);
  return out.includes('\0') ? out : out.trim();
}
export function hc(cwd, args) {
  const noJson = args[0] === 'run';
  const result = spawnSync('hc', noJson ? args : [...args, '--json'], { cwd, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (args[0] === 'get' && result.status === 3 && /"kind"\s*:\s*"not_found"/.test(result.stderr))
    return null;
  check(result.status === 0, result.error?.message ?? result.stderr?.trim() ?? 'Herdr 조회 실패');
  return JSON.parse(result.stdout);
}
export function context(cwd, herdr = hc) {
  const root = git(cwd, 'rev-parse', '--show-toplevel');
  check(samePath(resolve(dirname(configPath), '../..'), root), '어댑터와 원본 checkout이 다르다.');
  const expected = 'https://github.com/' + repository;
  const remote = url => url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  const push = git(root, 'remote', 'get-url', '--push', '--all', 'origin').split(/\r?\n/);
  check(push.length === 1 && remote(push[0]) === expected && remote(git(root, 'remote', 'get-url', 'origin')) === expected,
    'herdr-harness 원격 저장소가 아니다.');
  const stateDir = join(root, config.project.state_dir);
  const file = join(stateDir, 'harness-binding.json');
  const binding = adapter.binding(file);
  check(binding.project === project && samePath(binding.cwd, root), 'binding과 저장소가 다르다.');
  check(binding.adapterConfig && samePath(binding.adapterConfig, configPath) && binding.command?.length === 2 &&
    samePath(binding.command[0], process.execPath) && samePath(binding.command[1], join(dirname(configPath), 'hh.mjs')),
    'binding과 자체 어댑터 명령이 다르다.');
  const flow = input => adapter.workflow(file, { project, stateDir, ...input });
  const execution = input => adapter.executionPolicy(file, { project, stateDir, config, ...input });
  const release = name => require(join(binding.release, 'core', name));
  return {
    root, stateDir, file, binding, flow, execution, release,
    herdr: args => herdr(root, args),
    decisions: input => {
      check(!input.ledger.x_hh_decisions_initialized || existsSync(join(stateDir, 'decisions.json')), '기존 결정함 파일을 찾을 수 없다.');
      return adapter.bridge(file, { project, stateDir, ...input });
    },
  };
}

export function candidate(ctx, task) {
  const { worktree, base } = task;
  check(samePath(git(worktree, 'rev-parse', '--show-toplevel'), worktree) &&
    samePath(git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'), git(ctx.root, 'rev-parse', '--path-format=absolute', '--git-common-dir')) &&
    git(worktree, 'branch', '--show-current') === task.branch &&
    git(worktree, 'merge-base', base, 'HEAD') === base, '업무 작업공간·브랜치·기준을 확인할 수 없다.');
  check(!git(worktree, 'ls-files', '--unmerged'), '충돌을 먼저 해결해야 한다.');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const tree = ctx.release('verification-receipt.cjs').candidateTree(worktree);
  const changes = git(worktree, 'diff', '--raw', '--no-renames', '--no-abbrev', '-z', base, tree);
  const parts = changes ? changes.slice(0, -1).split('\0') : [];
  const paths = [];
  for (let i = 0; i < parts.length; i += 2) {
    const [, mode, oid, status] = /^:\d{6} (\d{6}) [0-9a-f]{40} ([0-9a-f]{40}) ([AMDT])$/.exec(parts[i]) ?? [];
    const path = parts[i + 1];
    check(path && !path.includes('\uFFFD') && (status === 'D' || ['100644', '100755', '120000'].includes(mode)), '지원하지 않는 파일 경로·Git mode다.');
    paths.push(status === 'D' ? { path, status: 'DELETED', mode: null, sha256: null } : {
      path, status, mode, sha256: adapter.hash(command(worktree, 'git', ['cat-file', 'blob', oid], 'buffer')),
    });
  }
  const fingerprint = adapter.hash(JSON.stringify({ head, base, paths: paths.map(p => [p.path, p.status, p.mode, p.sha256]) }));
  return { head, tree, x_base: base, fingerprint, paths };
}

export function verifyCommit(ctx, task) {
  const current = candidate(ctx, task);
  check(task.candidate?.tree === current.tree && current.tree === git(task.worktree, 'rev-parse', 'HEAD^{tree}'),
    '커밋 tree와 독립 QA 후보가 다르다.');
  check(!git(task.worktree, 'status', '--porcelain=v1', '--untracked-files=all'), '게시 작업공간에 미커밋 변경이 있다.');
  const anchor = { head: current.head, base: task.base, tree: current.tree };
  ctx.release('dev14.cjs').verifyPublication(
    (...args) => git(task.worktree, ...args),
    oid => command(task.worktree, 'git', ['cat-file', 'blob', oid], 'buffer'),
    { ...task.x_flow, delivery: anchor },
    { candidate: task.candidate, sensitivePaths: config.sensitive_paths },
  );
  return anchor;
}
