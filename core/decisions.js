// Node와 Herdr가 함께 쓰는 순수 결정함 계약. 업무 승인·대장 전이는 수행하지 않는다.
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && Boolean(v.trim());
const fail = (s) => { throw new Error(s); };
export function validateDecisions(data, project) {
  if (!object(data) || data.version !== 1 || data.project !== project || !object(data.requests)) fail('결정함 버전·프로젝트·형식이 맞지 않는다.');
  for (const [id, r] of Object.entries(data.requests)) {
    if (!object(r) || r.id !== id || !['open', 'resolved'].includes(r.status) || !text(r.question) || !text(r.source)
      || !Number.isInteger(r.revision) || r.revision < 1 || !(r.task === null || typeof r.task === 'string')
      || !Array.isArray(r.options) || r.options.some((o) => !text(o?.label) || typeof o.impact !== 'string')
      || (r.reason != null && typeof r.reason !== 'string') || (r.recommendation != null && typeof r.recommendation !== 'string')
      || (r.status === 'resolved' && (!text(r.resolution?.quote) || !text(r.resolution?.source)))) fail('기존 결정함 질문 형식이 올바르지 않아 보존했다.');
  }
  return data;
}
export function decisionInbox(raw, project) {
  if (raw === null) return { status: 'missing', requests: [], note: '질문별 결정함이 아직 연결되지 않았습니다. Lead 보고도 함께 확인하세요.' };
  try { return { status: 'ready', requests: Object.values(validateDecisions(JSON.parse(raw), project).requests), note: null }; }
  catch { return { status: 'error', requests: [], note: '질문별 결정함을 읽지 못했습니다. 미해소 질문이 없다는 뜻은 아닙니다.' }; }
}
const required = (v, name) => {
  if (!text(v) || v.length > 8000) fail(`${name}은 비어 있지 않은 8000자 이하 문자열이어야 한다.`);
  return v.trim();
};
export function changeDecision(data, { action, id, input, revision, by, at, tasks }) {
  if (!['request', 'resolve'].includes(action)) fail('decision list|request|resolve 명령을 사용한다.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id ?? '') || ['__proto__', 'constructor', 'prototype'].includes(id)) fail('질문 KEY는 영숫자로 시작하는 1~80자 식별자여야 한다.');
  const source = required(input?.source, 'source(질문 또는 실제 답변 출처)');
  const previous = Object.hasOwn(data.requests, id) ? data.requests[id] : null;
  let next;
  if (action === 'request') {
    const task = input.task ?? null;
    if (task !== null && (typeof task !== 'string' || !Object.hasOwn(tasks, task.toUpperCase()))) fail(`${task} 작업이 없다.`);
    const options = input.options ?? [];
    if (!Array.isArray(options) || options.length > 8) fail('options는 최대 8개 선택지 배열이어야 한다.');
    const fields = { task, kind: required(input.kind ?? 'decision', 'kind'), question: required(input.question, 'question'), source,
      options: options.map((o) => ({ label: required(o?.label, '선택지 label'), impact: o.impact ? required(o.impact, '선택지 impact') : '' })),
      recommendation: input.recommendation ? required(input.recommendation, 'recommendation') : null,
      reason: input.reason ? required(input.reason, 'reason') : null };
    if (previous?.status === 'resolved') fail('해소된 질문을 다시 열 수 없다. 새로운 질문 KEY로 등록한다.');
    if (previous && Object.keys(fields).every((k) => JSON.stringify(previous[k]) === JSON.stringify(fields[k]))) return previous;
    if (previous && Number(revision) !== previous.revision) fail('질문 revision이 달라 수정하지 않았다. decision list로 다시 확인한다.');
    next = { id, ...fields, status: 'open', revision: (previous?.revision ?? 0) + 1, created: previous?.created ?? at, updated: at, by, resolution: null };
  } else {
    if (!previous) fail('등록되지 않은 질문이다.');
    const quote = required(input.quote, 'quote(실제 답변 원문)');
    if (previous.status === 'resolved') {
      if (previous.resolution.quote === quote && previous.resolution.source === source) return previous;
      fail('이미 해소된 질문이다. 기존 답변을 덮어쓰지 않는다.');
    }
    if (Number(revision) !== previous.revision) fail('질문 revision이 달라 해소하지 않았다. 최신 질문에 대한 답변인지 확인한다.');
    next = { ...previous, status: 'resolved', revision: previous.revision + 1, updated: at, resolution: { quote, source, by, at } };
  }
  Object.defineProperty(data.requests, id, { value: next, enumerable: true, configurable: true, writable: true });
  return next;
}
