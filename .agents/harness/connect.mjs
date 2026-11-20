import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withInstallLock } from '../../scripts/install-lock.mjs';
import { atomic } from './ledger.mjs';
import { adapter, check, config, configPath, git, project, readJson } from './repository.mjs';

const { values } = parseArgs({ options: { active: { type: 'string' }, 'register-panel': { type: 'boolean' } } });
try {
  check(values.active, '사용법: connect.mjs --active STORE/active.json [--register-panel]');
  const activePath = resolve(values.active);
  const store = dirname(activePath);
  const root = git(dirname(configPath), 'rev-parse', '--show-toplevel');
  const file = join(root, config.project.state_dir, 'harness-binding.json');
  console.log(JSON.stringify(withInstallLock(store, () => {
    const active = readJson(activePath);
    check(active.version === 1 && /^[a-f0-9]{64}$/.test(active.manifestHash) &&
      resolve(active.release) === join(store, 'releases', active.manifestHash), '활성 release 위치가 올바르지 않다.');
    const manifest = adapter.verify(active.release, active.manifestHash);
    check(manifest.files['core/dev14.cjs'] && manifest.files['core/verification-receipt.cjs'], 'DEV-14와 QA 영수증 지원 릴리스가 필요하다.');
    const current = existsSync(file) ? readFileSync(file) : null;
    if (current) check(JSON.parse(current).project === project, '현재 연결이 다른 프로젝트에 속한다.');
    const record = values['register-panel'] ? readJson(active.recordPath) : null;
    const panel = record ? join(record.modPath, 'projects.json') : null;
    const projects = panel ? readJson(panel) : null;
    if (panel) {
      check(record.manifestHash === active.manifestHash && Array.isArray(projects.projects), '설치된 Herdr 프로젝트 설정이 올바르지 않다.');
      check(!projects.projects.some(p => p.name === project && resolve(p.root) !== resolve(root)), '다른 경로의 herdr-harness 패널 연결이 이미 있다.');
    }
    const binding = { version: 1, project, release: active.release, manifestHash: active.manifestHash,
      command: [process.execPath, join(dirname(configPath), 'hh.mjs')], cwd: root, adapterConfig: configPath, timeout: 1800000 };
    atomic(file, JSON.stringify(binding, null, 2) + '\n');
    try {
      if (panel && !projects.projects.some(p => p.name === project && resolve(p.root) === resolve(root))) {
        projects.projects.push({ name: project, root });
        atomic(panel, JSON.stringify(projects, null, 2) + '\n');
      }
    } catch (error) {
      if (current) atomic(file, current);
      else rmSync(file);
      throw error;
    }
    return { file, panel, manifestHash: binding.manifestHash };
  }), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 2; }
