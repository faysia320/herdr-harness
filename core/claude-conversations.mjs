import { existsSync, readdirSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Called only after the old process has stopped. Authentication and settings
// never move; only this conversation and its subagent transcripts are copied.
export function migrateConversation(session, target) {
  if (!session?.configDir || resolve(session.configDir) === resolve(target)) return;
  if (!/^[\w-]+$/.test(session.sessionId)) throw new Error('대화 ID 형식이 올바르지 않습니다.');
  const projects = join(session.configDir, 'projects');
  const folders = readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory());
  const name = `${session.sessionId}.jsonl`;
  const matches = folders.filter(d => existsSync(join(projects, d.name, name)));
  if (matches.length !== 1) throw new Error('이전 대화 파일을 하나로 식별하지 못했습니다. 기존 기록은 보존했습니다.');
  const from = join(projects, matches[0].name), to = join(target, 'projects', matches[0].name);
  mkdirSync(to, { recursive: true });
  const backup = join(target, 'harness-migration-backups', `${session.sessionId}-${Date.now()}`);
  for (const item of [name, session.sessionId]) {
    const source = join(from, item), destination = join(to, item);
    if (!existsSync(source)) continue;
    if (existsSync(destination)) {
      mkdirSync(backup, { recursive: true });
      cpSync(destination, join(backup, item), { recursive: true });
    }
    if (item === name) copyFileSync(source, destination);
    else cpSync(source, destination, { recursive: true });
  }
}
