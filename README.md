# Herdr Harness

개인 AI 개발 하네스의 단계별 위임 정책, 공통 결정함, 실행 진입점, Herdr mod를 함께 관리한다. 프로젝트의 스킬·산출물 검증·업무 데이터는 각 프로젝트에 남긴다.

Herdr 패널은 모든 로컬 저장소 공간에 표시한다. `projects.json`에 등록된 smart-workspace, vms-design-platform, v-project는 브리핑과 Git Tree를 제공하고, 나머지는 Git Tree 탭만 제공한다. 일반 저장소는 별도 등록 없이 공간의 첫 터미널 현재 경로를 사용한다. 전체 저장소 보기는 등록된 하네스 프로젝트에서만 제공한다.

## 관리 경계

| 여기에서 한 번 관리 | 프로젝트에서 관리 | 로컬에만 보관 |
|---|---|---|
| 질문 등록·수정·해소와 revision | 조사·구현·QA·architect 스킬 | `projects.json`, 설치 계획 |
| 모델·effort·Fast·프로필·재작업 상향·실행 한도 | 스킬 경로·호출명·품질 기준 | 고정 release 경로와 binding |
| 결정함 검증·원자 저장·mod 브리핑·Git Tree | 승인 근거·후보 지문·파일 겹침 판정 | 대장·결정 기록·실행 로그·인증 |
| 실행 결과·timeout·설치/복구 | 기존 CLI와 대장 writer·잠금 | UI 읽음 상태와 개인 설정 |
| 과정 산출물 커밋 여부·보관 위치·PR 검사·증거 항목 | 과정 문서 경로 선언·게시 지침·CI 스크립트 | 업무별 과정 산출물 보관본 |

세 프로젝트는 같은 위임 정책을 읽고 실제 실행 인자를 같은 resolver에서 만든다. Python의 안내 전용 `next`, JS의 자동 실행 등 CLI 인터페이스와 프로젝트별 산출물 검증은 유지한다. 공통 launcher가 binding에 지정된 프로젝트 CLI를 실행한다. `decision`은 공통 저장기를, `policy`와 위임은 공통 실행 정책을 사용한다.

```text
공통 launcher → 프로젝트 CLI (저장소·Lead 확인, 기존 ledger.lock)
                       ↓
                고정된 공통 decision-store → decisions.json
                       ↓
                공통 결정함 검증기 → Herdr mod
```

## 준비와 검증

Node.js 22 이상, Git, Herdr App이 필요하다. Python 프로젝트 CLI에는 기존 Python 환경도 필요하다. npm 외부 의존성은 없다. mod 아이콘은 Herdr가 제공하는 `workspace-chrome` mod를 사용한다.

```powershell
npm test
node scripts/build.mjs
```

build는 명시한 파일만 `dist/<manifest SHA-256>/`에 묶는다. `mod/harness/decisions.js`와 `contract.js`는 `core/`에서 생성하는 Git 제외 산출물이다. 직접 수정하지 않는다. manifest 내용은 파일명·버전·SHA-256이며 개인 경로나 실행 기록을 포함하지 않는다. 커밋 전 후보도 내용 해시로 고정할 수 있지만, 그것을 커밋·릴리스 게시라고 부르지 않는다.

프로젝트 adapter 통합 시험은 회사 소스를 이 저장소에 넣지 않고 로컬 checkout에서 임시 Git fixture로 읽는다. 아래 목록 파일도 `.local/`에 둔다.

```json
[{"name":"sw","kind":"node","root":"C:/example/project","cli":".agents/harness/swh.mjs"}]
```

```powershell
$env:HERDR_HARNESS_ADAPTERS = 'C:/example/herdr-harness/.local/adapters.json'
node --test test/adapters.integration.mjs
```

지원 fixture 이름은 `sw`, `vp`(kind `python`), `vdp`다. 실제 AI·공유 DB·운영 대장을 쓰지 않는다. 기존 회사 하네스 회귀 시험도 해당 checkout에서 실행한다. 세 CLI 회귀에는 build가 반환한 release 경로를 `HERDR_HARNESS_TEST_RELEASE`로 지정한다.

## 설치·업데이트

1. `examples/install.example.json`을 `.local/install.json`으로 복사해 로컬 경로를 채운다. 프로젝트 `command`는 공통 정책 bridge가 연결된 실제 CLI를, `adapterConfig`는 그 checkout의 `.agents/harness/config.json` 절대 경로를 가리켜야 한다. 설치 대상 mod는 `harness`다.
2. 테스트를 통과한 뒤 `node scripts/install.mjs .local/install.json`을 실행한다. `harness`와 같은 상위 폴더의 `harness-auto`도 함께 설치·백업·검증한다. 기존 layout의 `harness-auto` 블록이 공간 전환에 맞춰 패널을 표시한다.
3. staging native check → 소스·binding 백업 → 설치 → native check를 통과하면 active 기록을 바꾼다. `node scripts/verify-install.mjs <store>`로 실제 설치 파일 지문을 검증한다.
4. 기존 Lead가 새 CLI와 프로젝트의 `COMMON.md` 지침을 사용하는지 별도로 확인한다. 설치는 Lead에 메시지를 보내거나 현재 업무를 재시작하지 않는다.

각 상태 폴더의 `harness-binding.json`은 release 경로·manifest 지문·project ID·CLI command/cwd·adapterConfig만 담는다. 화면도 이 설정과 release의 공통 한도를 읽어 오래된 main 설정을 표시하지 않는다. 업무 내용·인증 정보는 넣지 않는다. 설치 프로그램은 프로젝트의 추적 파일을 수정하지 않으므로 회사 adapter 변경은 별도 브랜치로 검토·게시한다.

기존 `projects.json`은 보존하고 처음 설치에만 빈 설정을 만든다. 예시는 `examples/projects.example.json`이다. 업무 대장·결정 기록·Herdr 읽음 상태는 설치와 복구가 건드리지 않는다. 소스를 수정해도 설치본은 자동으로 바뀌지 않는다. 검증 후 명시적으로 재설치한다.

```powershell
node <release>/bin/harness.mjs --binding <상태폴더>/harness-binding.json decision list
node <release>/bin/harness.mjs --binding <상태폴더>/harness-binding.json policy --stage implement --profile normal --rework 1
node scripts/rollback.mjs <store>
```

rollback은 직전 소스·binding을 복원한다. 설치 이후 수동 변경이 있으면 덮어쓰지 않고 거부한다. 새 질문이나 사용자 설정은 되돌리지 않는다. 로컬 백업에는 이전 개인 파일 내용이 있으므로 store를 Git에 넣지 않는다.

## 위임 정책

정본은 [policy/execution.json](policy/execution.json) 하나다. 변경 후 검사·build·설치하면 세 프로젝트에 같은 정책이 적용된다. 새 CLI는 공통 설치가 없거나 지문이 다르면 실패하며 예전 모델로 조용히 돌아가지 않는다. 이미 실행 중인 에이전트는 유지하고 다음 위임부터 적용한다. 구 checkout의 직접 CLI 호출은 설치된 command를 우회하므로 Lead는 binding의 release와 공통 launcher를 사용한다.

| 단계 | 모델 | 기본 effort | Fast |
|---|---|---|---|
| 조사 | gpt-6-astra | high | 끔 |
| 구현 | claude-opus-5-5 | high | 끔 |
| QA | gpt-6.1-sol | xhigh | 끔 |
| 설계 검토 | claude-fable-5-2 | high | 끔 |

`simple`과 `normal`은 기본값, `complex`는 구현 xhigh(조사는 모든 프로필 high, QA는 모든 프로필 xhigh), `high-risk`는 complex에 설계 검토와 단독 구현을 추가한다. 옛 이름은 모든 저장소에서 같은 별칭으로 지원한다: ui-simple→simple, feature→normal, shared-component→complex, token/architecture/high→high-risk. 재작업마다 구현 effort를 한 단계 올려 max에서 멈춘다. 프로젝트별 동시 실행 4, 재작업 최대 2, 자동 실행 재시도 0이다.

사용자 지정 배치는 조사 Astra/high, 설계 Fable 5.2/high, 구현 Opus 5.5/high, QA Sol/xhigh다. 모든 단계에서 Fast를 끈다. 모델의 CLI가 바뀌면 표준 `.agents/skills`·`.claude/skills` 경로와 `$`·`/` 호출도 공통 resolver가 함께 맞춘다. 저장소별 스킬 이름·인자와 사용자 지정 경로는 유지한다. Codex workspace-write, Claude auto를 실행 인자로 지정한다. Codex 승인·네트워크 등 지정하지 않은 사용자 설정은 계속 상속하며 전역 설정을 쓰지 않는다. Fast 비활성화는 Codex의 `service_tier="default"`와 Claude의 `fastMode:false`로 명시한다([Codex 설정](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude Fast 설정](https://code.claude.com/docs/en/fast-mode)).

현재 세 저장소의 `execution_overrides`는 모두 `{}`다. 앞으로 의도적 예외가 필요하면 프로젝트 config에 `execution_overrides: {"reason":"구체적인 사유", "roles":{"implement":{"effort":"medium"}}, "limits":{"max_parallel":1}}`처럼 선언한다. roles에는 모델·effort·Fast·실행 모드만, limits에는 공통 한도만 허용한다. 예전 roles의 model/args나 별도 routing은 거부하므로 중복 설정이 조용히 살아남지 않는다. 적용 순서는 공통 역할 → 명시적 저장소 예외 → 프로필 effort → 재작업 상향 → 사유 있는 업무별 model/effort 예외다. run의 `x_execution_policy`에 정책 지문·release·예외·실제 요청 Fast를 남긴다. 이 기록은 요청값이며 실제 모델 사용 증거는 각 CLI의 evidence로 구분한다.

## 과정 산출물

업무 진행 중에 쓰는 과정 문서(Project README·implementation·qa-report 등)는 기본으로 main에 커밋하지 않는다. 정본은 [policy/artifacts.json](policy/artifacts.json)이고 판정·보관은 `core/artifact-policy.cjs`가 맡는다. 업무 PR 뒤에 과정 문서만 지우는 정리 PR을 따로 만들지 않기 위해서다.

- **선언**: 프로젝트 config에 `process_artifacts: {"paths": ["docs/projects/{slug}/"]}`처럼 업무별 과정 문서 폴더를 선언한다. 자리표시자는 `{id}`·`{slug}`·`{date}`만 쓸 수 있고, 하나 이상 들어가야 한다. 그래서 `docs/projects/README.md` 같은 공용 색인은 과정 문서로 잡히지 않는다. 선언하지 않은 저장소는 기존처럼 동작한다.
- **커밋 여부**: 공통 기본은 `commit: false`다. 커밋해야 하는 저장소는 `commit: true`와 `reason`을 함께 둔다. 이미 main에 있고 남기기로 한 폴더는 `exempt: [{path, reason}]`로 지정한다.
- **진행 중**: collect의 README·qa-report 게이트와 후보 지문은 worktree의 미커밋 파일을 그대로 읽는다. 과정 문서를 커밋하지 않아도 게이트는 바뀌지 않는다.
- **보관**: 단계 수집 뒤, 그리고 worktree를 정리하기 전에 `archive`로 `<state_dir>/tasks/<ID>/artifacts/`에 복사한다. 보관은 같은 경로만 덮어쓰고, 이전 회차 보관본은 지우지 않는다. `manifest.json`에는 파일별 SHA-256을 남긴다.
- **게시**: 커밋 전에 `violations`로 과정 문서의 추가·수정·이름 변경을 걸러 낸다. 삭제는 기존 문서 정리이므로 허용한다. 오래 남을 내용은 같은 업무 PR 안에서 옮긴다. 바뀐 계약은 Area로, 다시 쓸 조사 결론은 Resource로, 후속 작업은 Area 후속 절이나 티켓으로 보낸다.
- **증거**: PR 본문과 티켓 NOTE에 QA 판정·회차, 실행한 검사와 종료 코드, 실패·skip·미실행·외부 미검증, 단계별 실제 CLI·모델·effort를 적는다. 병합 SHA 기준의 Project 파일 고정 링크로 증거를 대신하지 않는다.
- **CI**: 저장소 CI는 PR 변경 목록을 같은 규칙으로 검사해 실패만 시킨다. 파일을 고치거나 지우지는 않는다. CI에는 개인 release가 없으므로 저장소 스크립트가 config 선언을 직접 읽는다. 공통 `violations`와 같은 판정이 나오는지는 저장소 시험에서 확인한다.

CLI는 binding으로 고정한 release를 호출한다. Python CLI도 같은 JSON 진입점을 쓴다.

```powershell
'{"action":"violations","project":"<id>","stateDir":"<상태폴더>","config":{...},"changes":[{"status":"A","path":"docs/projects/x/README.md"}]}' | node .agents/harness/runtime.cjs <상태폴더>/harness-binding.json artifacts
```

동작은 `config`, `resolve`(`vars`), `violations`(`changes`), `archive`(`task: {id, worktree, vars}`)다.

## 결정함 규칙

현재 대장에 등록된 살아 있는 Lead가 `decision request KEY --file 질문.json`으로 먼저 등록한다. 질문은 `question`, `source`, 선택 `task`, `kind`, `options`, `reason`, `recommendation`으로 구성한다. 업무 등록 전에는 `task:null`, DONE 이후에도 후속 질문을 남길 수 있다.

질문을 수정할 때는 `--revision 현재값`을 요구한다. 해소는 실제 답변의 `quote`와 `source`를 담은 파일로 `decision resolve KEY --file 답변.json --revision 질문revision`을 실행한다. 같은 입력의 재시도는 멱등적이다. 읽음·다른 업무 완료·Lead 새 보고는 해소 근거가 아니다. 결정함 해소는 업무 승인이나 Git 작업을 대신하지 않는다.

읽기 오류·다른 프로젝트·설치 변조는 정상적인 빈 결정함으로 취급하지 않는다. 입력 파일과 설치본이 유효하지 않으면 기존 기록을 보존하고 실패한다. 상태 파일의 기록 크기는 mod 읽기 한도인 1 MiB를 넘기지 않는다.

## 화면 갱신과 대장 용량

상태 폴더 또는 프로젝트 설정 폴더의 변경은 200ms 단위로 묶어 해당 프로젝트만 다시 읽는다. 읽는 중 발생한 변경도 후속 조회로 반영한다. `projects.json`이 있는 mod 폴더 변경은 전체 목록을 다시 읽으며, 감시 실패·누락과 프로젝트 추가·제거를 복구하기 위해 60초마다 전체 조회를 유지한다. 상대 시각은 파일을 읽지 않고 15초마다 갱신한다.

브리핑은 `ledger.json`의 UTF-8 크기가 1 MiB의 75% 이상이면 용량 주의, 90% 이상이면 읽기 한도 임박을 표시한다. 경고는 화면에 표시하며 업무 상태를 바꾸거나 알림 소리를 반복하지 않는다. 읽기 실패 시에는 마지막 정상 자료와 용량 경고를 보존하고, 크기가 줄어든 정상 대장을 읽으면 경고를 해제한다.

75%부터 해당 프로젝트에서 과거 실행 이력의 분리 보관을 준비하고, 90%부터는 한도를 넘기기 전에 보관 작업을 우선한다. 보관은 원본 백업과 프로젝트 CLI의 잠금 아래에서 수행하며, 진행 중 업무·미해소 질문·승인 근거와 화면에 필요한 요약·이력은 유지해야 한다. `archived` 표시만 추가해도 JSON 크기는 줄지 않는다. 실제 분리 보관 기능과 파일 형식은 프로젝트 writer가 소유하며, 공통 mod는 기록을 자동 삭제하거나 잘라내지 않는다.
