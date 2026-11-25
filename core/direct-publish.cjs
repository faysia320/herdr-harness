// QA PASS 업무를 모델 없이 커밋·push·PR 생성까지 올린다. 판단은 어댑터의 게시 검사와 PR CI·flow-deliver가 한다.
// 어긋나면 되돌리거나 고치지 않고 단계·확보한 SHA·PR 번호와 함께 던진다. 같은 명령을 다시 실행하면 확인된 커밋·PR을 재사용한다.
// 호출 계약은 README «명령 하나로 PR 게시»에 있다. 어댑터는 자기 Lead 잠금 안에서 부르고, 훅은 그 어댑터의 검사 처리기를 직접 부른다.
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { changes } = require('./dev14.cjs');
const { marker, decodeEnvelope, candidateBinding } = require('./qa-receipt-policy.cjs');
const { remainingVerification, missingRemaining } = require('./workflow.cjs');

const check = (ok, message) => { if (!ok) throw new Error(message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();

function execute(cwd, file, args, { input, encoding = 'utf8', timeout = 300000 } = {}) {
  const r = spawnSync(file, args, { cwd, input, encoding, timeout, windowsHide: true, shell: false, maxBuffer: 64 << 20,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });
  check(!r.error && r.status === 0, file + ' ' + (args[0] ?? '') + ' 실패: ' + (r.error?.message ?? String(r.stderr || r.stdout).trim()));
  return r.stdout;
}

// 보고서 자유 문장은 목록 항목 하나로 만들고 HTML·코드·멘션으로 해석되지 않게 한다. 뒤의 «남은 검증» 줄이 가려지지 않는다.
const plain = text => oneLine(text).replace(/^[-*+#>\s]+/, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/`/g, "'")
  .replace(/[\\*[\]~]/g, '\\$&').replace(/@(?=\w)/g, '@&#8203;');
// CI 봉투 해독기는 식별자가 든 줄을 모두 봉투로 센다. 보고서 글의 식별자는 화면 표시를 그대로 두고 원문만 끊어 실제 봉투 줄만 세게 한다.
const code = text => '`' + oneLine(text).replace(/`/g, "'").replaceAll(marker, marker.replace(':', '`&#58;`')) + '`';
const unmark = text => text.replaceAll(marker, marker.replace(':', '<!-- -->:'));

function renderBody(task, { summary, qa }) {
  const { plan, verification: v } = task.x_flow;
  const limits = (v.limitations ?? []).filter(l => l.kind === 'limitation');
  const unverified = v.criteria.filter(c => c.status === 'unverified');
  const left = remainingVerification(plan, v);
  return unmark([
    '## 요약', '', '- ' + task.id + ' · ' + plain(task.title), ...summary.split(/\r?\n/).filter(s => s.trim()).map(s => '- ' + plain(s)), '',
    '## 독립 QA', '', '- 판정: PASS (' + (qa.round ? qa.round + '회차, ' : '') + code(qa.token) + ')', '- 후보 지문: ' + code(v.candidate),
    '- 기준 커밋: ' + code(task.base), ...v.criteria.map(c => '- ' + plain(c.id) + ' ' + c.status + ': ' + plain(c.evidence)), '',
    '## 실행 검사', '', ...v.checks.map(c => '- ' + plain(c.id) + ' ' + c.status + ': ' + code(c.command) + ' — ' + plain(c.evidence)), '',
    '## 한계', '', ...(limits.length || unverified.length ? [...limits.map(l => '- ' + l.id + ' (' + l.severity + '): ' + plain(l.note)),
      ...unverified.map(c => '- ' + plain(c.id) + ': 독립 QA에서 확인하지 못함')] : ['- 없음']), '',
    '## 남은 검증', '', ...(left.length ? left.map(r => '- [ ] ' + r.line) : ['- 없음']), '',
  ].join('\n'));
}

// task: 대장의 v2 업무(id·title·worktree·branch·base·candidate·runs·x_flow).
// options: repository(owner/name), envelope('required'|'none'), base(기본 main), trailers, summary·qa({round,token}) 덮어쓰기.
// hooks: checkCandidate·checkCommitted(어긋나면 던진다) 필수, prepare(과정 문서 보관)·envelope(봉투 한 줄)·body(본문 보강)·attach(PR 번호) 선택.
function publish(task, options, hooks, exec = execute) {
  const flow = task.x_flow, paths = task.candidate?.paths, target = options.base ?? 'main';
  const run = (file, args, opts) => exec(task.worktree, file, args, opts);
  const git = (...args) => { const out = run('git', args); return out.includes('\0') ? out : out.trim(); };
  const list = (...args) => git('diff', '--name-only', '--no-renames', '-z', ...args).split('\0').filter(Boolean);
  const done = { stage: '게시 자격', head: null, pr: null };
  try {
    check(flow?.version === 2 && flow.phase === 'publish' && flow.verification?.verdict === 'PASS' && !flow.delivery &&
      typeof flow.authorization === 'string' && flow.authorization.trim() && Array.isArray(paths) && paths.length &&
      flow.verification.candidate === task.candidate.fingerprint, '독립 QA PASS와 게시 승인이 있는 v2 게시 대기 업무만 게시한다.');
    const qaRun = (task.runs ?? []).filter(r => r.stage === 'qa' && r.outcome === 'PASS').at(-1);
    const qa = options.qa ?? { round: qaRun?.round, token: qaRun?.token };
    const summary = options.summary ?? (task.runs ?? []).filter(r => r.stage === 'implement' && r.outcome === 'ok').at(-1)?.note;
    const title = oneLine(task.title), trailers = (options.trailers ?? ['Published-by: herdr-harness']).map(oneLine);
    const message = title + '\n\n' + task.id + '\n독립 QA 회차 ' + qa.token + ' PASS\n후보 지문: ' + task.candidate.fingerprint + '\n\n' + trailers.join('\n') + '\n';
    check(qa.token && summary?.trim() && title, 'PASS한 QA 회차·구현 요약·업무 제목이 필요하다.');
    check(['required', 'none'].includes(options.envelope), '봉투 정책은 required 또는 none이다.');
    check(task.branch !== target && git('branch', '--show-current') === task.branch, '업무 작업공간의 브랜치가 다르다.');
    const canonical = url => url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '').toLowerCase();
    const urls = git('remote', 'get-url', '--push', '--all', 'origin').split(/\r?\n/);
    check(urls.length === 1 && canonical(urls[0]) === ('https://github.com/' + options.repository).toLowerCase(), 'origin push 주소가 게시 저장소와 다르다.');

    done.stage = 'QA 영수증 봉투';
    const envelope = options.envelope === 'required' ? String(hooks.envelope?.() ?? '').trim() : null;
    const receipt = envelope === null ? null : decodeEnvelope(envelope);
    check(!receipt || !/[\r\n]/.test(envelope) && receipt.run === qa.token && receipt.base === task.base, '봉투가 승인된 QA 회차·기준 커밋의 발급분이 아니다.');

    done.stage = 'PR 본문';
    let body = renderBody(task, { summary, qa });
    if (hooks.body) body = hooks.body(body);
    const marked = () => body.split(/\r\n|\r|\n/).filter(line => line.includes(marker));
    if (receipt && !marked().length) body = body.trimEnd() + '\n\n' + envelope + '\n';
    check(receipt ? marked().length === 1 && marked()[0].trimEnd() === envelope : !marked().length, 'PR 본문의 봉투 줄이 봉투 정책과 다르다.');
    const missing = missingRemaining(flow.plan, body, flow.verification);
    check(!missing.length, 'PR 본문 «남은 검증»에 빠진 줄: ' + missing.map(m => m.line).join(' / '));
    check(body.length <= 65000, 'PR 본문이 GitHub 한도를 넘는다.');

    done.stage = '후보 대조';
    const assertTree = tree => {
      const rows = changes(git, task.base, tree);
      check(rows.size === paths.length && paths.every(p => {
        const row = rows.get(p.path);
        return row && (row.status === 'D' ? p.status === 'DELETED' : row.status === p.status && row.mode === p.mode &&
          sha256(run('git', ['cat-file', 'blob', row.blob], { encoding: 'buffer' })) === p.sha256);
      }), '게시할 tree와 QA 후보의 경로·mode·바이트가 다르다.');
      if (!receipt) return;
      const bound = candidateBinding(git, task.base, task.base, tree);
      check(bound.digest === receipt.candidate?.digest && bound.count === receipt.candidate.count, '봉투의 후보 지문이 게시할 tree와 다르다.');
    };
    // 이전 시도가 만든 커밋이 있으면 새로 커밋하지 않고 아래 커밋 검사로 같은 후보인지 확인한다.
    const reusedCommit = git('rev-parse', 'HEAD') !== task.candidate.head;
    // QA 전에 이미 커밋한 후보(HEAD가 QA HEAD이고 작업 트리가 깨끗함)는 커밋을 건너뛴다.
    let committed = false;
    if (!reusedCommit) {
      hooks.prepare?.();
      hooks.checkCandidate();
      committed = git('rev-parse', 'HEAD') === task.candidate.head && !git('status', '--porcelain=v1', '--untracked-files=all');
    }
    if (!reusedCommit && !committed) {
      const names = new Set(paths.map(p => p.path)), unstaged = new Set(list());
      const unrelated = list('--cached', 'HEAD').filter(p => !names.has(p) || unstaged.has(p));
      check(!unrelated.length, '후보와 무관하거나 일부만 stage된 경로가 있다: ' + unrelated.join(', '));
      done.stage = '커밋';
      // 경로를 pathspec이 아닌 리터럴로 넘긴다. 삭제와 패턴 문자가 있는 이름도 그대로 처리한다.
      run('git', ['update-index', '--add', '--remove', '--replace', '-z', '--stdin'], { input: paths.map(p => p.path + '\0').join('') });
      assertTree(git('write-tree'));
      run('git', ['commit', '-q', '--cleanup=whitespace', '-F', '-'], { input: message });
    }
    done.head = git('rev-parse', 'HEAD');
    done.stage = '커밋 대조';
    // push는 조상까지 공개한다. QA 당시 HEAD 자체이거나 그 바로 위에 이 명령이 만든 커밋 하나일 때만 올린다.
    const [header, ...text] = git('cat-file', 'commit', done.head).split('\n\n');
    check(committed ? done.head === task.candidate.head :
      header.split('\n').filter(l => l.startsWith('parent ')).join() === 'parent ' + task.candidate.head && text.join('\n\n').trim() === message.trim(),
      'QA 당시 HEAD ' + task.candidate.head + ' 바로 위에 이 명령이 만든 게시 커밋 하나가 아니다(부모·커밋 메시지 불일치).');
    assertTree(git('rev-parse', done.head + '^{tree}'));
    hooks.checkCommitted();

    done.stage = '기존 PR 조회';
    const same = text => String(text ?? '').replace(/\r\n/g, '\n').trimEnd();
    const open = JSON.parse(run('gh', ['pr', 'list', '--repo', options.repository, '--head', task.branch, '--state', 'open',
      '--json', 'number,url,isCrossRepository,isDraft,headRefOid,baseRefName,body'])).filter(p => !p.isCrossRepository);
    // 이미 커밋된 후보의 열린 PR은 재구현 전 head·본문일 수 있다. 일반 push로 head를 올리고 본문을 갱신해 재사용한다.
    check(open.length <= 1 && open.every(p => p.baseRefName === target && !p.isDraft && (committed || p.headRefOid === done.head && same(p.body) === same(body))),
      '업무 브랜치의 열린 PR이 이번 게시와 다르다: ' + open.map(p => '#' + p.number).join(', '));
    let pr = open[0];
    done.pr = pr?.number ?? null;
    if (!pr || committed) {
      done.stage = 'push';
      // 사용자의 push.followTags 설정을 물려받지 않고 승인된 업무 브랜치만 올린다.
      run('git', ['push', '--no-follow-tags', 'origin', done.head + ':refs/heads/' + task.branch]);
      done.stage = pr ? 'PR 본문 갱신' : 'PR 생성';
      const scratch = mkdtempSync(join(tmpdir(), 'herdr-publish-'));
      try {
        writeFileSync(join(scratch, 'body.md'), body);
        if (!pr) {
          const out = run('gh', ['pr', 'create', '--repo', options.repository, '--base', target, '--head', task.branch, '--title=' + title,
            '--body-file', join(scratch, 'body.md')]);
          const [url, number] = /https:\/\/github\.com\/\S+\/pull\/(\d+)/.exec(out) ?? [];
          check(url, '만든 PR 주소를 확인할 수 없다: ' + out.trim());
          pr = { url, number: Number(number) };
        } else if (same(pr.body) !== same(body)) {
          run('gh', ['pr', 'edit', String(pr.number), '--repo', options.repository, '--body-file', join(scratch, 'body.md')]);
        }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
    done.pr = pr.number;
    done.stage = 'PR 연결';
    const attached = hooks.attach?.(pr.number);
    return { pr: pr.number, url: pr.url, head: done.head, reusedCommit: reusedCommit || committed, reusedPr: open.length === 1, ...(attached ? { attached } : {}) };
  } catch (error) {
    error.message = '게시 중단(' + done.stage + '): ' + error.message + (done.head ? ' [커밋 ' + done.head + ']' : '') + (done.pr ? ' [PR #' + done.pr + ']' : '');
    throw error;
  }
}

module.exports = { publish, renderBody, execute };
// Node 밖(Python) 어댑터용: stdin JSON {task, options, commands:{훅: argv}}. attach는 부르지 않고 {pr,url,head}를 돌려준다.
if (require.main === module) {
  try {
    const { task, options, commands } = JSON.parse(readFileSync(0, 'utf8'));
    const hooks = Object.fromEntries(['prepare', 'checkCandidate', 'checkCommitted', 'envelope', 'body'].filter(k => commands?.[k])
      .map(k => [k, input => execute(task.worktree, commands[k][0], commands[k].slice(1), { input })]));
    check(hooks.checkCandidate && hooks.checkCommitted, 'checkCandidate·checkCommitted 명령이 필요하다.');
    process.stdout.write(JSON.stringify(publish(task, options, hooks)) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 2; }
}
