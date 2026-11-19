// The receipt is the original QA scope. Git objects, not the current checkout,
// establish what a later PR head and squash commit actually contain.
const { createHash } = require('node:crypto');
const oid = /^[0-9a-f]{40}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function sensitive(path, extra) {
  const parts = path.toLowerCase().split('/');
  const name = parts.at(-1);
  return extra.some(p => path.toLowerCase() === p.toLowerCase() || path.toLowerCase().startsWith(p.toLowerCase() + '/')) ||
    parts.some(p => /^(?:\.github|\.cargo|\.agents|\.claude|\.husky|\.config|config|configs|contracts?|schemas?|patches|migrations|ci)$/.test(p)) ||
    parts.some(p => /(?:^|[-._])(?:contracts?|schemas?|configs?)(?:[-._]|$)/.test(p)) ||
    /(?:^|\/)(?:ui-builder\/backend|ui-builder-backend|scripts\/verify)(?:\/|$)/i.test(path) ||
    /\.(?:proto|graphql|gql|idl|avsc)$/.test(name) ||
    /(?:\.lockb?$|(?:^|[.-])lock[.-]|(?:^|[.-])(?:config|contract|schema)(?:[.-]|$)|^tsconfig|^jsconfig)/.test(name) ||
    /^(?:package\.json|cargo\.toml|build\.rs|rust-toolchain(?:\.toml)?|pnpm-workspace\.yaml|\.npmrc|\.gitattributes|\.gitmodules|\.gitignore|codeowners|go\.(?:mod|sum)|pyproject\.toml|requirements.*\.txt|dockerfile.*|(?:docker-)?compose\.ya?ml|makefile|\.env(?:\..*)?)$/.test(name);
}

function changes(git, base, tip) {
  const raw = git('diff', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '-z', base, tip, '--');
  const fields = raw.split('\0');
  if (fields.pop() !== '' || fields.length % 2) throw Error('Git 변경 경로 목록이 불완전하다.');
  const paths = new Map();
  for (let i = 0; i < fields.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMDT])$/.exec(fields[i]);
    const path = fields[i + 1];
    if (!match || !path || path.includes('\uFFFD') || paths.has(path)) throw Error('Git 경로·모드를 해석할 수 없다.');
    paths.set(path, { mode: match[2], blob: match[4], status: match[5], raw: fields[i] });
  }
  return paths;
}

function verifyPublication(git, blob, flow, options) {
  const anchor = flow.delivery.original ?? flow.delivery;
  const c = options.candidate;
  if (![anchor.base, anchor.head, anchor.tree].every(s => oid.test(s)) ||
      !oid.test(c?.head) || c.x_base !== anchor.base || !Array.isArray(c.paths) || !c.paths.length ||
      c.fingerprint !== flow.verification.candidate) throw Error('QA 후보와 최초 게시 기준이 다르다.');
  const fingerprint = digest(JSON.stringify({ head: c.head, base: c.x_base,
    paths: c.paths.map(p => [p.path, p.status, p.mode, p.sha256]) }));
  if (fingerprint !== c.fingerprint || git('rev-parse', anchor.head + '^{tree}') !== anchor.tree ||
      git('merge-base', anchor.base, anchor.head) !== anchor.base) throw Error('최초 게시 tree·QA 지문을 검증할 수 없다.');
  const paths = changes(git, anchor.base, anchor.head);
  if (paths.size !== c.paths.length || new Set(c.paths.map(p => p.path)).size !== paths.size) throw Error('QA와 게시 경로 목록이 다르다.');
  for (const p of c.paths) {
    const entry = paths.get(p.path);
    if (!entry || (entry.status === 'D' ? p.status !== 'DELETED' || p.mode !== null || p.sha256 !== null :
      !['100644','100755','120000'].includes(entry.mode) || entry.mode !== p.mode ||
      entry.status !== p.status || digest(blob(entry.blob)) !== p.sha256)) throw Error('QA와 게시 바이트·모드·삭제 상태 불일치: ' + p.path);
  }
  const extra = options.sensitivePaths ?? [];
  if (!Array.isArray(extra) || extra.some(p => typeof p !== 'string' || /[\\*?:\x00-\x1f]/.test(p) ||
      p.split('/').some(part => !part || part === '.' || part === '..'))) throw Error('민감 경로는 저장소 상대 파일·폴더 이름이어야 한다.');
  return { original: { base: anchor.base, head: anchor.head, tree: anchor.tree }, paths, extra };
}

function checkScope(git, publication, base) {
  const { original, paths, extra } = publication;
  if (base === original.base) return [];
  if (git('merge-base', '--all', original.head, base) !== original.base) return ['기존 QA 갈림점이 변경됐다.'];
  const upstream = changes(git, original.base, base);
  const qaPaths = [...paths.keys()];
  const overlap = [...upstream.keys()].filter(p => qaPaths.some(q => {
    const a = p.toLowerCase(), b = q.toLowerCase();
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  }));
  const protectedPaths = [...new Set([...upstream.keys(), ...qaPaths])].filter(p => sensitive(p, extra));
  return [...overlap.map(p => 'QA 경로 겹침: ' + p), ...protectedPaths.map(p => '민감 경로 변경: ' + p)];
}

function syncHistory(git, publication, head, base) {
  if (!oid.test(base) || !oid.test(head)) throw Error('PR head/base SHA 오류');
  const { original } = publication;
  const heads = new Set([head]);
  let cursor = head, newerBase = base;
  while (cursor !== original.head) {
    const parents = git('show', '-s', '--format=%P', cursor).split(' ');
    if (parents.length !== 2 || !parents.every(s => oid.test(s))) return { reasons: ['게시 이후 일반 커밋 또는 rebase가 있다.'] };
    const [previous, syncBase] = parents;
    if (git('merge-base', newerBase, syncBase) !== syncBase) return { reasons: ['동기화 부모가 main 계보와 다르다.'] };
    const reasons = checkScope(git, publication, syncBase);
    if (reasons.length) return { reasons };
    if (git('merge-tree', '--write-tree', previous, syncBase) !== git('rev-parse', cursor + '^{tree}')) return { reasons: ['동기화 커밋에 예상 밖의 변경이 있다.'] };
    heads.add(previous);
    cursor = previous;
    newerBase = syncBase;
  }
  return { heads, reasons: checkScope(git, publication, base) };
}

function candidateInTree(git, publication, base, tree) {
  const actual = changes(git, base, tree);
  return actual.size === publication.paths.size &&
    [...publication.paths].every(([p, expected]) => actual.get(p)?.raw === expected.raw);
}

function checksAtHead(gh, repo, head, required, configured) {
  if (!required.length || !required.every(c => c.bucket === 'pass' && c.state === 'SUCCESS')) return false;
  if (!configured.length || !configured.every(c => required.some(r => r.name === c.context))) return false;
  const pages = JSON.parse(gh('api','--paginate','--slurp',`repos/${repo}/commits/${head}/check-runs?filter=latest&per_page=100`));
  const runs = pages.flatMap(p => p.check_runs);
  const missing = required.filter(c => !runs.some(r => r.head_sha === head && r.name === c.name &&
    configured.every(rule => rule.context !== c.name || !rule.app || rule.app === r.app?.id) &&
    r.status === 'completed' && r.conclusion === 'success' && c.link && [r.details_url,r.html_url].includes(c.link)));
  if (!missing.length) return true;
  if (missing.some(c => configured.some(rule => rule.context === c.name && rule.app))) return false;
  const status = JSON.parse(gh('api',`repos/${repo}/commits/${head}/status?per_page=100`));
  return status.sha === head && missing.every(c => {
    const latest = status.statuses.find(s => s.context === c.name);
    return latest?.state === 'success' && (latest.target_url || '') === (c.link || '');
  });
}

module.exports = { verifyPublication, syncHistory, candidateInTree, checksAtHead };
