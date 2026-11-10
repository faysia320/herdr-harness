// 끝난 업무의 상세 이력을 대장 밖으로 옮기는 공통 규칙. 대장 쓰기와 잠금은 프로젝트 CLI가 맡는다.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const raw = fs.readFileSync(path.join(__dirname, '../policy/ledger.json'));
const defaults = JSON.parse(raw);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
const ENDED = ['DONE', 'FAILED'];
const safe = /^[A-Za-z0-9._-]+$/;
const pick = (object, keys) => Object.fromEntries(keys.filter((k) => object[k] !== undefined).map((k) => [k, object[k]]));
const ms = (at) => { const v = Date.parse(at ?? ''); return Number.isFinite(v) ? v : null; };
const fileOf = (id) => {
  if (!safe.test(id ?? '')) fail(`보관할 업무 ID가 올바르지 않다: ${id}`);
  return defaults.archive.replace('{id}', id);
};
const bytesOf = (task) => `${JSON.stringify(task, null, 2)}\n`;
// FAILED→QUEUED로 다시 연 업무는 같은 ID로 다시 끝날 수 있다. 기존 보관본과 내용이 다르면 지문을 붙인 이름으로 따로 둔다.
const versionOf = (id, sha) => fileOf(id).replace(/\.json$/, `.${sha.slice(0, 12)}.json`);
const fileFor = (task) => {
  const file = task.x_archive?.file;
  if (file !== fileOf(task.id) && file !== versionOf(task.id, task.x_archive?.sha256 ?? '')) fail(`보관 파일 경로가 올바르지 않다: ${file}`);
  return file;
};

// 대상: 끝난 지 min_age_hours가 지났고, 최근 끝난 keep_recent건이 아니며, 남은 업무가 의존하지 않고, 호출자가 붙잡지 않은 업무.
// 호출자는 worktree가 남은 업무(게시·정리 전)와 미해소 질문이 걸린 업무를 keep으로 넘긴다.
function plan(ledger, options = {}) {
  if (defaults.version !== 1 || !ledger?.tasks) fail('대장 보관 정책 또는 대장 형식이 올바르지 않다.');
  const now = ms(options.now ?? new Date().toISOString()) ?? fail('기준 시각이 올바르지 않다.');
  const minAge = (options.min_age_hours ?? defaults.min_age_hours) * 3600000;
  const keepRecent = options.keep_recent ?? defaults.keep_recent;
  const keep = new Set(options.keep ?? []);
  const tasks = Object.values(ledger.tasks);
  const needed = new Set(tasks.filter((t) => !ENDED.includes(t.state)).flatMap((t) => t.depends ?? []));
  const ended = tasks.filter((t) => ENDED.includes(t.state) && !t.x_archive).sort((a, b) => (ms(b.updated) ?? 0) - (ms(a.updated) ?? 0));
  const recent = new Set(ended.slice(0, keepRecent).map((t) => t.id));
  return ended.filter((t) => !recent.has(t.id) && !needed.has(t.id) && !keep.has(t.id) && !t.current
    && ms(t.updated) !== null && now - ms(t.updated) >= minAge).map((t) => t.id);
}

// 화면이 쓰는 요약만 대장에 남긴다. 마지막 실행과 마지막 전이는 목록 표시용으로 유지한다.
function summarize(task, file, at) {
  const bytes = bytesOf(task), last = (task.runs ?? []).at(-1);
  return {
    ...pick(task, defaults.summary), current: null,
    runs: last ? [pick(last, defaults.run_summary)] : [], history: (task.history ?? []).slice(-1),
    x_archive: { file, sha256: digest(bytes), at, runs: (task.runs ?? []).length, history: (task.history ?? []).length },
  };
}

// 보관 파일을 먼저 쓰고 새 대장을 돌려준다. 호출자는 같은 잠금 안에서 돌려받은 대장을 원자 저장한다.
// 같은 내용의 보관 파일은 재사용한다. 기존 파일은 덮어쓰지 않고, 내용이 다르면 지문을 붙인 새 파일에 쓴다.
function archive(ledger, stateDir, options = {}) {
  if (!path.isAbsolute(stateDir ?? '')) fail('상태 폴더는 절대 경로여야 한다.');
  const at = options.now ?? new Date().toISOString();
  const ids = options.ids ?? plan(ledger, options);
  const next = { ...ledger, tasks: { ...ledger.tasks } }, moved = [];
  const where = (file) => path.join(stateDir, ...file.split('/'));
  for (const id of ids) {
    const task = ledger.tasks[id];
    if (!task || !ENDED.includes(task.state) || task.x_archive) fail(`보관할 수 없는 업무다: ${id}`);
    const bytes = bytesOf(task), sha = digest(bytes);
    let file = fileOf(id);
    if (fs.existsSync(where(file)) && digest(fs.readFileSync(where(file))) !== sha) file = versionOf(id, sha);
    const target = where(file);
    if (fs.existsSync(target)) { if (digest(fs.readFileSync(target)) !== sha) fail(`이미 다른 내용의 보관 파일이 있다: ${file}`); }
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(`${target}.tmp`, bytes); fs.renameSync(`${target}.tmp`, target);
    }
    next.tasks[id] = summarize(task, file, at);
    moved.push(id);
  }
  const size = (l) => Buffer.byteLength(JSON.stringify(l, null, 2));
  return { ledger: next, moved, before: size(ledger), after: size(next) };
}

// show 등 상세 조회용. 지문이 다르면 보관본을 신뢰하지 않는다.
function restore(task, stateDir) {
  if (!task?.x_archive) return task;
  const target = path.join(stateDir, ...fileFor(task).split('/'));
  const bytes = fs.readFileSync(target);
  if (digest(bytes) !== task.x_archive.sha256) fail(`보관 파일 지문이 대장과 다르다: ${task.x_archive.file}`);
  return JSON.parse(bytes);
}

module.exports = { plan, archive, restore, policy: { ...defaults, sha256: digest(raw) } };
