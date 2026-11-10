import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../scripts/build.mjs';
import { run } from '../core/process.js';
const require = createRequire(import.meta.url);
const { configure, resolve, violations, archive } = require('../core/artifact-policy.cjs');
const { artifactPolicy } = require('../adapters/runtime.cjs');
const sw = () => ({ process_artifacts: { paths: ['docs/projects/{slug}/'] } });

test('선언하지 않은 저장소는 기존처럼 동작하고 선언하면 기본으로 커밋하지 않는다', () => {
  assert.equal(configure({}).declared, false);
  assert.throws(() => violations({}, ['docs/projects/a/README.md']), /선언/);
  const c = configure(sw());
  assert.deepEqual([c.declared, c.commit, c.archive], [true, false, 'tasks/{id}/artifacts']);
  assert.deepEqual(c.evidence.map((e) => e.key), ['qa', 'checks', 'limits', 'models']);
});

test('기본과 다른 커밋 여부·보존 예외에는 사유가 필요하고 공용 폴더는 과정 문서로 선언할 수 없다', () => {
  assert.throws(() => configure({ process_artifacts: { paths: ['docs/projects/{slug}/'], commit: true } }), /reason/);
  assert.equal(configure({ process_artifacts: { paths: ['docs/projects/{slug}/'], commit: true, reason: '감사 보관 의무' } }).commit, true);
  for (const paths of [[], ['docs/projects/'], ['/abs/{slug}/'], ['docs/../{slug}/'], ['docs/{name}/'], ['docs\\{slug}\\'], ['docs/{slug}']]) {
    assert.throws(() => configure({ process_artifacts: { paths } }), undefined, JSON.stringify(paths));
  }
  assert.throws(() => configure({ process_artifacts: { ...sw().process_artifacts, exempt: [{ path: 'docs/projects/SW-0021/' }] } }), /reason/);
  assert.throws(() => configure({ process_artifacts: { ...sw().process_artifacts, extra: 1 } }), /paths·commit/);
});

test('PR 변경 중 과정 문서의 추가·수정만 위반이고 삭제·색인·보존 예외는 통과한다', () => {
  const local = sw(); local.process_artifacts.exempt = [{ path: 'docs/projects/SW-0021/', reason: '사용자 보존 결정' }];
  const found = violations(local, [
    { status: 'A', path: 'docs/projects/sw-0060-x/README.md' },
    { status: 'M', path: 'docs/projects/sw-0059-y/qa-report.md' },
    { status: 'R100', path: 'docs\\projects\\sw-0061\\implementation.md' },
    { status: 'D', path: 'docs/projects/sw-0058/README.md' },
    { status: 'M', path: 'docs/projects/README.md' },
    { status: 'M', path: 'docs/projects/SW-0021/README.md' },
    'docs/areas/development/README.md',
  ]);
  assert.deepEqual(found.map((v) => v.path), ['docs/projects/sw-0060-x/README.md', 'docs/projects/sw-0059-y/qa-report.md', 'docs/projects/sw-0061/implementation.md']);
  const vp = { process_artifacts: { paths: ['docs/tasks/{date}-{slug}/'] } };
  assert.equal(violations(vp, ['docs/tasks/20261110-fix/research.md']).length, 1);
  assert.equal(violations(vp, ['docs/tasks/README.md']).length, 0);
  assert.deepEqual(violations({ process_artifacts: { paths: ['docs/projects/{slug}/'], commit: true, reason: '예외' } }, ['docs/projects/a/README.md']), []);
});

test('업무 경로 값은 경로 구분자 없이 채우고 빠진 값은 거부한다', () => {
  assert.deepEqual(resolve(sw(), { slug: 'sw-0060-x' }), ['docs/projects/sw-0060-x/']);
  for (const slug of [undefined, '../x', 'a/b', '']) assert.throws(() => resolve(sw(), { slug }), /slug/);
});

test('미커밋 과정 문서를 상태 폴더로 보관하고 이전 회차 보관본을 지우지 않는다', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'herdr-artifacts-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const wt = join(temp, 'wt'), stateDir = join(temp, 'state'), dir = join(wt, 'docs/projects/sw-0060-x');
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '- 조사: 완료\n'); writeFileSync(join(dir, 'qa-report.r1.md'), 'r1\n'); writeFileSync(join(dir, 'evidence/log.txt'), 'ok\n');
  const input = { id: 'SW-0060', worktree: wt, stateDir, vars: { slug: 'sw-0060-x' }, at: '2026-11-10T00:00:00.000Z' };
  const first = archive(sw(), input);
  assert.deepEqual(first.copied, ['docs/projects/sw-0060-x/README.md', 'docs/projects/sw-0060-x/evidence/log.txt', 'docs/projects/sw-0060-x/qa-report.r1.md']);
  const dest = join(stateDir, 'tasks/SW-0060/artifacts');
  assert.equal(readFileSync(join(dest, 'docs/projects/sw-0060-x/README.md'), 'utf8'), '- 조사: 완료\n');
  rmSync(join(dir, 'qa-report.r1.md')); writeFileSync(join(dir, 'README.md'), '- 조사: 완료\n- 구현: 완료\n');
  const second = archive(sw(), input);
  assert.equal(second.total, 3);
  assert.ok(existsSync(join(dest, 'docs/projects/sw-0060-x/qa-report.r1.md')));
  const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'));
  assert.match(readFileSync(join(dest, 'docs/projects/sw-0060-x/README.md'), 'utf8'), /구현/);
  assert.equal(Object.keys(manifest.files).length, 3);
  for (const bad of [{ ...input, id: '../x' }, { ...input, worktree: 'relative' }]) assert.throws(() => archive(sw(), bad));
});

test('보관 대상·원본 경로에 junction이 있으면 쓰거나 읽기 전에 거부한다', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'herdr-artifacts-link-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const wt = join(temp, 'wt'), stateDir = join(temp, 'state'), outside = join(temp, 'outside'), dir = join(wt, 'docs/projects/x');
  mkdirSync(dir, { recursive: true }); mkdirSync(outside); mkdirSync(join(stateDir, 'tasks/SW-1'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'new\n'); writeFileSync(join(outside, 'README.md'), 'keep\n');
  const input = { id: 'SW-1', worktree: wt, stateDir, vars: { slug: 'x' } };
  // 상태 폴더 안의 보관 위치가 밖을 가리키면 외부 파일을 덮어쓰지 않는다.
  symlinkSync(outside, join(stateDir, 'tasks/SW-1/artifacts'), 'junction');
  assert.throws(() => archive(sw(), input), /링크/);
  assert.equal(readFileSync(join(outside, 'README.md'), 'utf8'), 'keep\n');
  unlinkSync(join(stateDir, 'tasks/SW-1/artifacts'));
  // 원본 업무 폴더가 밖을 가리키면 그 내용을 보관하지 않는다.
  rmSync(dir, { recursive: true }); symlinkSync(outside, dir, 'junction');
  assert.throws(() => archive(sw(), input), /링크/);
  assert.equal(existsSync(join(stateDir, 'tasks/SW-1/artifacts/docs/projects/x/README.md')), false);
});

test('binding으로 고정한 과정 산출물 규칙은 Node·Python용 JSON 진입점에서 같고 경계 변조를 거부한다', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'herdr-artifact-binding-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const built = build(), file = join(stateDir, 'harness-binding.json');
  writeFileSync(file, JSON.stringify({ version: 1, project: 'fixture', release: built.release, manifestHash: built.manifestHash }));
  const input = { action: 'violations', project: 'fixture', stateDir, config: sw(), changes: ['docs/projects/a/README.md', 'src/a.js'] };
  const direct = artifactPolicy(file, input);
  const r = run(process.execPath, ['adapters/runtime.cjs', file, 'artifacts'], { input: JSON.stringify(input) });
  assert.equal(r.code, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), direct);
  assert.deepEqual(direct.map((v) => v.path), ['docs/projects/a/README.md']);
  assert.equal(artifactPolicy(file, { ...input, action: 'config' }).commit, false);
  assert.throws(() => artifactPolicy(file, { ...input, project: 'other' }), /경계/);
  assert.throws(() => artifactPolicy(file, { ...input, action: 'typo' }), /동작/);
});
