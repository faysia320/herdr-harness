// 대장 값으로 화면 문구를 계산한다. Herdr를 가져오지 않아 node로 바로 시험할 수 있다.
const IDLE_STAGE = { QUEUED: "research", RESEARCHING: "research", READY_TO_IMPLEMENT: "implement", IMPLEMENTING: "implement", QA: "qa" };
const RESULT = { ok: "완료", approved: "승인", revise: "수정 요청", rejected: "반려", "decision-needed": "결정 필요", "scope-violation": "범위 위반", empty: "결과 비어 있음", "no-result": "결과 없음", "fingerprint-mismatch": "지문 불일치", "skill-mismatch": "스킬 불일치", stopped: "중단" };
const TONE = { ok: "good", approved: "good", PASS: "good", "CONDITIONAL PASS": "warn", revise: "warn", stopped: "warn", BLOCKED: "warn", "decision-needed": "warn" };
const STATUS = { running: "진행 중", lost: "유실", stopped: "중단" };

const time = (at) => { const n = Date.parse(at ?? ""); return Number.isNaN(n) ? 0 : n; };
const activeRun = (task) => (task.current ? task.runs?.[task.current.run] : null);
const running = (task) => activeRun(task)?.status === "running";
const baseName = (path) => path.replace(/\/+$/, "").split("/").at(-1);

// Herdr readTextFile의 한도는 UTF-8 1 MiB다. 호스트에 Node의 Buffer를 요구하지 않는다.
export function ledgerCapacityNote(raw) {
  let bytes = 0;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && raw.charCodeAt(i + 1) >= 0xdc00 && raw.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  const ratio = bytes / (1 << 20);
  if (ratio < 0.75) return null;
  return `대장 용량 ${Math.ceil(bytes / 1024)} KiB / 1 MiB (${Math.floor(ratio * 100)}%) · ${ratio >= 0.9 ? "읽기 한도 임박" : "용량 주의"} · 프로젝트에서 과거 실행 이력의 분리 보관을 준비하세요.`;
}

export const span = (ms) => {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "1분 미만";
  if (m < 60) return `${m}분`;
  return m % 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${Math.floor(m / 60)}시간`;
};

// Lead CLI의 위임 전 검사(swh.mjs checkDispatch) 가운데 의존성·동시 실행 상한·파일 겹침만 옮겼다. 위임은 CLI가 다시 판정하므로 여기 값은 안내용이다.
// 실행 중·막힘·끝난 업무는 기다리는 상태가 아니라 null, 막는 조건이 없으면 []를 돌려준다.
export function waitReasons(task, ledger, maxParallel, exempt = []) {
  if (["DONE", "FAILED", "BLOCKED"].includes(task.state) || running(task)) return null;
  const tasks = ledger.tasks ?? {}, reasons = [];
  const pending = (task.depends ?? []).filter((id) => tasks[id]?.state !== "DONE");
  if (pending.length) reasons.push({ text: `선행 업무 대기: ${pending.join(", ")}` });
  const count = Object.values(tasks).filter(running).length;
  if (maxParallel && count >= maxParallel) reasons.push({ text: `동시 실행 상한 ${count}/${maxParallel}` });
  if ((task.pending ?? IDLE_STAGE[task.state]) === "implement") {
    for (const other of Object.values(tasks)) {
      if (other.id === task.id || !["IMPLEMENTING", "QA"].includes(other.state)) continue;
      const theirs = new Set([...(other.planned_files ?? []), ...(other.candidate?.paths ?? []).map((p) => p.path)]);
      const clash = (task.planned_files ?? []).filter((f) => !exempt.includes(f) && (theirs.has(f) || [...theirs].some((x) => x.endsWith("/") && f.startsWith(x))));
      if (!clash.length) continue;
      const shown = clash.slice(0, 2).map(baseName).join(", ");
      reasons.push({ text: `파일 겹침: ${other.id} · ${shown}${clash.length > 2 ? ` 외 ${clash.length - 2}개` : ""}`, tip: clash.join("\n") });
    }
  }
  return reasons;
}

// 실행별 소요 시간과 단계별 합계. 단계 사이 대기 시간은 넣지 않는다.
export function timeline(runs, now) {
  const rows = (runs ?? []).map((run) => {
    const started = time(run.started), live = run.status === "running";
    const end = live ? now : time(run.ended);
    const failed = run.outcome && !TONE[run.outcome];
    return {
      stage: run.stage, round: run.round ?? null, ms: started && end ? end - started : 0, live, note: run.note ?? null,
      result: run.outcome ? RESULT[run.outcome] ?? run.outcome : STATUS[run.status] ?? run.status ?? "",
      tone: live ? "live" : failed ? "bad" : TONE[run.outcome] ?? (STATUS[run.status] ? "warn" : null),
    };
  });
  const totals = new Map();
  for (const row of rows) totals.set(row.stage, (totals.get(row.stage) ?? 0) + row.ms);
  return { rows, totals: [...totals].map(([stage, ms]) => ({ stage, ms })) };
}

// 화면에서 고른 답을 Lead에게 전하는 문장. 결정함 기록은 Lead CLI만 하므로 해소 절차와 원문을 함께 보낸다.
export const answerKey = (p, r) => `${p.name}\u0000${r.id}\u0000${r.revision}`;
export function instructionMessage(task, instruction) {
  const text = String(instruction ?? "").trim();
  if (!text) return null;
  return `[사용자 지시 · Herdr 하네스 모드] 업무 ${task.id} (${task.title ?? task.id}). `
    + `화면에 표시된 막힘 사유: ${JSON.stringify(task.reason ?? "")}.\n`
    + `사용자 지시 원문: ${JSON.stringify(text)}\n`
    + `위 지시는 사용자가 업무 카드에서 직접 입력했다. 현재 업무 상태와 관련 결정 질문을 확인하고 기존 하네스 CLI 절차에 따라 처리하라. `
    + `전달만으로 승인·결정 해소·업무 재개가 기록된 것은 아니다. 별도 질문의 답으로 기록하려면 해당 질문과 revision이 맞는지 확인하라.`;
}
export function answerMessage(r, answer) {
  const text = String(answer ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return `[사용자 결정 · Herdr 하네스 모드] 질문 ${r.id}(revision ${r.revision})의 답: "${text}". `
    + `사용자가 하네스 모드 카드에서 직접 고른 답이다. 이 문장을 quote로, 출처를 'Herdr 하네스 모드 사용자 선택'으로 해 `
    + `decision resolve ${r.id} --revision ${r.revision} 로 기록한 뒤 그 결정대로 진행하라. revision이 바뀌었으면 기록하지 말고 사용자에게 다시 물어라.`;
}
