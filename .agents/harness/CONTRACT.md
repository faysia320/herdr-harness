# Herdr 하네스 공통 계약

- 계약 버전: 1
- 문서 개정: 2 (2026-11-25, 업무 흐름은 v2만 쓴다)
- 적용 저장소: smart-workspace(`SW`), v-project(`VP`), vms-design-platform(`VDP`)
- 정본과 사본: 정본은 herdr-harness 저장소의 `.agents/harness/CONTRACT.md`다. 세 저장소의 같은 경로 사본은 정본과 바이트 단위로 같다. 각 Lead가 같은 커밋의 정본을 복사하고 SHA-256을 대조한다.
- 버전: `계약 버전`은 대장 `version`이며 대장·사건·실행 기록 형식이 호환되지 않게 바뀔 때만 올린다. 그 밖의 개정은 `문서 개정`을 올린다.
- 범위: 대장·사건·실행 기록의 형식과 상태 전이 의미. 단계 스킬과 산출물 경로는 저장소 규칙을 따르고 config로 선언한다.

## 1. 상태

`QUEUED`, `RESEARCHING`, `READY_TO_IMPLEMENT`, `IMPLEMENTING`, `QA`, `DONE`, `BLOCKED`, `FAILED`

| 현재 | 허용되는 다음 상태 |
|---|---|
| QUEUED | RESEARCHING, BLOCKED, FAILED |
| RESEARCHING | READY_TO_IMPLEMENT, RESEARCHING(architect REVISE), BLOCKED, FAILED |
| READY_TO_IMPLEMENT | IMPLEMENTING, BLOCKED, FAILED |
| IMPLEMENTING | QA, BLOCKED, FAILED |
| QA | DONE(병합 증명 또는 종결), READY_TO_IMPLEMENT(코드 결함 repair), BLOCKED, FAILED |
| BLOCKED | `resume_state` 또는 사람이 지정한 상태, FAILED |
| FAILED | QUEUED |
| DONE | (없음) |

- CLI는 이 표 밖의 전이를 거부한다.
- 같은 상태로 다시 설정하면 `updated`만 바꾸고 사건·history를 남기지 않는다.
- BLOCKED는 사람 결정이 필요한 상태다. 진입 직전 상태를 `resume_state`에 남긴다.
- 예외로 다른 업무가 끝나기를 기다리려고 멈출 때는 중단 사유를 `선행 대기 <ID>[, <ID>]: <사유>`로 시작한다(CLI가 붙이는 `중단: `·`사용자 중단: ` 접두어 뒤). Herdr는 표식의 업무가 모두 DONE이 될 때까지 이 막힘을 결정함에서 빼고 진행 목록에 «선행 대기»로 보인다. 표식의 업무가 모두 DONE이 되거나 하나라도 FAILED·미등록이면 다시 사람 확인 대상으로 보인다.
- FAILED는 실행 실패 재시도 상한(`limits.max_retries`, 기본 0)을 넘었거나 사람이 `fail`을 실행한 경우에만 진입한다. 재시도를 쓰지 않는 저장소는 실행 실패를 BLOCKED로 보낸다.
- 업무 흐름은 `x_flow`(`version: 2`)가 정한다. QA 수집은 원인별로 나눈다. 반복·repair 상한은 공통 release의 `policy/workflow.json`이다.

| QA 수집 | 상태 | `x_flow.phase` |
|---|---|---|
| `PASS` | QA 유지 | `publish`(게시·CI 대기, 게시 권한이 없으면 로컬 종결 대기) |
| 코드 결함 | READY_TO_IMPLEMENT | `repair` |
| 환경·시험·검증·결정 원인만 있음 | BLOCKED | `blocked` |
| 같은 원인 반복 또는 repair 상한 초과 | BLOCKED | `diagnose` |

- DONE은 main 병합 증명(`x_flow.phase: merged`) 또는 근거가 남은 종결(`x_flow.phase: closed`, 종류는 `x_flow.closure.kind`)이다. 종결은 사용자 승인 병합, 정책 예외, 게시 권한 없는 업무의 로컬 종결이다. 승인 병합 종결은 표에 없는 상태에서도 DONE을 기록하며 history의 `closure`로 일반 전이와 구분한다. DONE은 배포·운영 확인을 뜻하지 않는다.
- 과거 기록(`x_flow` 없음)의 DONE은 그때의 로컬 독립 QA 통과이고, `x_closure`가 있으면 사용자 결정 종결이다. `CONDITIONAL PASS`도 과거 기록에서만 읽는다.

## 2. 파일 위치

- 설정: `.agents/harness/config.json`
- 상태 폴더 `S`: `<원본 루트>/<project.state_dir>` (기본 `.claude/state/<project.id>-harness`, Git 제외)
- `S/ledger.json`, `S/ledger.lock`, `S/events.jsonl`
- `S/tasks/<ID>/<stage>-r<round>.prompt.md`, 선택 `S/tasks/<ID>/<stage>-r<round>.receipt.json`

## 3. 대장 `ledger.json`

```json
{ "version": 1, "project": "<project.id>", "seq": 0,
  "lead": { "terminal": null, "attached_at": null, "previous": null },
  "tasks": { "<ID>": {} } }
```

- `version`은 필수다. 다른 값이면 CLI가 읽기를 거부한다.
- `project`가 config의 `project.id`와 다르면 거부한다.
- `seq`는 마지막으로 발급한 번호다.
- 쓰기는 잠금을 잡은 뒤 `ledger.json.tmp`에 쓰고 원자적으로 교체한다. 읽기는 잠금 없이 한다.
- 대장은 그 저장소의 Lead CLI만 쓴다. 대시보드·mod는 읽기만 한다.

## 4. 업무 task

| 필드 | 타입 | 의미 |
|---|---|---|
| `id` | string | `<task_prefix>-<seq를 id_width 자리로>` |
| `project` | string | `project.id` |
| `title` | string | 제목 |
| `description` | string | 요청 원문 |
| `itsm` | string\|null | ITSM 티켓 번호 |
| `profile` | string | 저장소 config가 정의한 프로필 이름 |
| `priority` | int | **클수록 먼저**, 기본 0 |
| `depends` | string[] | 먼저 DONE이어야 하는 업무 ID |
| `dir` | string | 단계 산출물 폴더, 저장소 상대 경로 |
| `branch`, `worktree`, `base_sha` | string\|null | 작업 브랜치, worktree 절대 경로, 기준 커밋 |
| `state` | enum | 1장 상태 |
| `pending` | string\|null | 다음에 위임할 단계 |
| `awaiting` | string\|null | 사람 대기 종류: `ac-approval`, `decision`, `permission` 등 |
| `rework` | int | 코드 결함 repair 횟수. 과거 기록은 QA 재작업 횟수 |
| `retries` | int | 현재 단계 실행 실패 재시도 횟수 |
| `resume_state` | enum\|null | BLOCKED 해제 시 돌아갈 상태 |
| `blocked_reason` | string\|null | BLOCKED·FAILED 사유, 사람이 읽는 문장 |
| `current` | `{stage, run}`\|null | 진행 중 실행. `run`은 `runs`의 0부터 세는 위치 |
| `runs` | run[] | 5장 |
| `candidate` | object\|null | `{head, fingerprint, paths[]}` 구현 후보 |
| `planned_files` | string[] | 병렬 겹침 판단용 수정 예정 경로 |
| `artifacts` | object | `{research, architect, implementation, qa_report}`, 저장소 상대 경로 |
| `approval` | object\|null | `{by, at, quote, scope}` 사람 AC 승인 기록 |
| `overrides` | object | `{<stage>: {model, effort, reason}}` |
| `created`, `updated` | string | 6장 시각 |
| `history` | `{at, from, to, why}`[] | 상태 전이 이력 |

- `x_flow`는 공통 v2 진행 기록이고 형식은 공통 release의 `core/workflow.cjs`가 정한다. 새 업무는 모두 `x_flow.version: 2`를 가진다.
- 저장소 고유 필드는 `x_` 접두사로만 추가한다(예: `x_acceptance`, `x_tests`). 대시보드는 `x_` 필드를 몰라도 동작해야 한다.
- 보관 처리는 `archived: true`로 하고 목록에서 숨긴다.

## 5. 실행 run

- `stage`(`research`·`architect`·`implement`·`qa`), `round`(같은 단계 회차, 1부터)
- `cli`(`codex`·`claude`), `model`, `effort`, hc `name`·`address`
- `prompt`(지시서 절대 경로), `receipt`(경로 또는 null)
- `started`, `ended`(진행 중이면 null), `status`(`running`·`done`·`lost`·`stopped`)
- `outcome`(아래 코드값 또는 null), `note`(사람이 읽는 보충 문장)
- `fingerprint_start`, `fingerprint_end`, `evidence: {transcript, models[], efforts[], skill, skill_loaded}`

`outcome` 코드값: `ok`, `approved`, `revise`, `rejected`, `decision-needed`, `scope-violation`, `empty`, `no-result`, `fingerprint-mismatch`, `skill-mismatch`, `stopped`, `PASS`, `FAIL`, `BLOCKED`. 과거 기록에는 `CONDITIONAL PASS`가 있다.

## 6. 시각과 ID

- 시각은 UTC ISO-8601 밀리초 `Z`다(예: `2026-11-03T03:01:52.424Z`). 표시할 때만 로컬 시각으로 바꾼다.
- ID 접두사·자릿수, hc 터미널 접두사는 config `project.task_prefix`, `project.id_width`, `project.terminal_prefix`로 정한다.
- hc 라벨은 `harness.project`, `harness.task`, `harness.stage`를 붙인다. CLI는 터미널을 끄거나 지우기 전에 `harness.project`가 자기 것인지 확인한다.

## 7. 사건 `events.jsonl`

한 줄에 JSON 하나를 append만 한다.

```json
{"at":"…Z","project":"<id>","task":"<ID>|null","event":"state","from":"QA","to":"DONE","why":"병합 증명·main 포함 확인"}
```

| `event` | 추가 필드 |
|---|---|
| `add` | `title` |
| `state` | `from`, `to`, `why` |
| `dispatch` | `stage`, `round`, `name`, `cli`, `model` |
| `collect` | `stage`, `round`, `outcome` |
| `worktree` | `branch`, `worktree`, `base_sha` |
| `set` | `field`, `value` |
| `lead` | `terminal`, `previous` |

`state` 사건은 대장 저장이 성공한 뒤에 쓴다.

## 8. 단계 산출물

- 경로와 표지 줄 이름은 저장소 config `artifacts`에 선언한다. 저장소 스킬 계약을 그대로 쓴다.
- 공통 판정 어휘:
  - research: `결정 대기: 없음|있음`
  - architect: `APPROVE|REVISE|REJECT`
  - implement: `완료|막힘`
  - qa: `PASS|FAIL|BLOCKED`
- CLI는 산출물 mtime이 run `started` 이후일 때만 수집한다.
- QA를 다시 할 때 이전 보고서를 `qa-report.r<round>.md`로 보존한다.
- QA PASS 수집 조건: 판정이 `PASS`이고 `fingerprint_start`와 `fingerprint_end`가 후보 `fingerprint`와 같으며 동결한 AC·필수 검사가 모두 보고됐다. PASS 수집은 DONE이 아니다.
- AC 승인은 세 저장소 모두 조건부 자동이다.
  - 자동 승인: research가 근거 준비 완료(`EVIDENCE READY` 등 저장소 표지)이고 `결정 대기: 없음`이며 등록 시 `--confirm-ac`를 주지 않았으면, CLI가 승인 근거 문구를 research 산출물에 쓰고 `approval: {by: "auto", …}`를 남긴 뒤 READY_TO_IMPLEMENT로 보낸다.
  - 그 밖에는 BLOCKED(`awaiting: ac-approval`)로 두고, 사람이 승인하면 `approval: {by: "user", quote, …}`를 남긴다.
  - `approval`이 없으면 implement를 위임하지 않는다.

## 9. 호환성

- 버전이 다른 대장은 CLI가 쓰지 않고, 대시보드는 "지원하지 않는 계약"으로 표시한다.
- 대장 형식 이전(version 없음 → 1)의 대장은 변환하지 않고 보관한 뒤 새로 시작한다.
- `x_flow` 없는 업무는 과거 기록이다. 상세·이력·보관·복원만 지원하고 위임·수집·게시하지 않으며 v2로 변환하지 않는다. 새 전이 규칙을 과거 history에 소급하지 않는다.
- 각 저장소 테스트는 CLI가 만든 대장·사건이 이 계약을 지키는지 검사한다.
