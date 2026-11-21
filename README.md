# Herdr Harness

이 저장소의 업무는 [자체 v2 운영 지침](.agents/harness/README.md)에 따라 등록하고 게시한다.

## 작업 흐름 v2 — smart-workspace 파일럿

기존 대장은 그대로 두고 `add --workflow v2 --kind bug-fix|feature|ui|performance|refactor --authorization <사용자의 자동 게시·병합 지시>`로 만든 업무만 새 흐름을 따른다. 모델 선택·작업별 절차는 `policy/workflow.json`, 실패 분류·진행 판정은 `core/workflow.cjs`가 정본이다. Herdr의 기존 단계는 호환 표시이며 `x_flow.phase`가 게시·CI·복구 진행을 구분한다.

- 조사에서 `verification-plan.json`의 AC·필수 검사 ID와 검사별 실행 위치를 동결하고 구현자는 실패 검사부터 짧게 확인한다. 고위험 업무는 기존 설계 검토를 유지한다. 독립 QA가 실행할 수 없는 배포 후·실기기 확인은 필수 검사가 아니라 후속 확인으로 남기고, 업무에 연결된 해소 결정은 다음 단계 지시서에 들어간다([검증 계획 실행 위치와 해소 결정 인계](#검증-계획-실행-위치와-해소-결정-인계)).
- QA는 독립 세션에서 원래 AC를 확인하고 `verification.json`에 후보 지문·AC·검사·원인별 결함을 기록한다. PASS는 현재 후보의 `target/sw-verify/latest-qa.json` 실행 증거도 있어야 한다. QA PASS는 업무 DONE이 아니라 게시 대기다.
- 원인은 code/environment/test/verification/decision으로 나눈다. 코드 결함만 구현 재작업 횟수를 소모한다. 같은 원인이 두 회차 나오면 진단으로 전환하며 `flow-resume ID --evidence <조건이 달라진 근거>`로만 재개한다. 일반 unblock·force로 진단을 건너뛰지 못한다.
- SW runner의 `--role qa --resume-qa`는 동일한 전체 후보 tree·명령·도구·설치·환경에 대한 QA 기록만 재사용한다. 구현자 기록·실패·DB 등 동적 검사는 재사용하지 않는다. 변경 이후 관련 없는 파일을 임의로 제외하는 부분 캐시는 아직 도입하지 않는다.
- v2 업무가 독립 QA PASS 후 `publish`에 도달하면 Lead는 `node <release>/bin/harness.mjs --binding <binding> publisher-command <ID>`로 게시자의 `worktree`와 `argv`를 조회한다. 같은 업무에 실행 중인 게시자가 없을 때 해당 worktree에서 반환된 인자 배열 그대로 한 세션을 시작하고 저장소 게시자의 PR 모드 지시, QA 후보, 업무별 게시 권한을 전달한다. `publisher-command`는 조회 전용이다. 게시자는 기존 게시 스킬로 커밋 blob과 QA 바이트·경로·Git mode를 대조하고 PR을 만든다. Lead가 `flow-attach-pr ID --pr N`으로 연결한다.
- `flow-deliver ID`는 실제 PR·CI·main·보호 규칙을 조회한다. `--apply`는 조건을 만족하면 squash 병합하고 실제 MERGED·main 포함·부모·tree를 증명한 뒤 DONE으로 만든다. 누락·미실행 필수 CI, 요구되는 리뷰, 미해결 결정, 후보 이동은 병합을 막는다.
- `node <release>/bin/watch-delivery.mjs <binding> <ID> [최대 분]`은 Lead 환경을 상속해 모델 없이 30초마다 CI를 확인한다. 서버 보호는 strict up-to-date와 우회 없는 ruleset 또는 관리자 포함 branch protection을 요구한다. 실패·환경 대기·main 이동은 반환하고 Lead가 필요한 부분만 복구한다. 강제 병합·main 직접 push·배포는 수행하지 않는다.
- CI 실패·필수 검사 누락·리뷰 조치는 즉시 `delivery-blocked`로 반환한다. `flow-resume --evidence`는 해결된 CI만 다시 확인하고, 코드 수정은 `--stage implement`, 요구사항 변경은 `--stage research`로 보낸다. watcher의 대기 상한 도달은 nonzero이며 완료로 보고하지 않는다.

v2의 조사에는 `gpt-6.2-astra`/high, 설계에는 Fable/high, 구현에는 Opus/high(고위험 xhigh), 독립 QA에는 `gpt-6.2-sol`/high를 사용한다. 세 저장소의 PR 게시자는 Codex `gpt-6-luna`/medium이다. 정책은 다음 위임부터 적용한다. 조사·설계·구현·QA의 30/30/60/45분은 진단 점검 시점이며 재작업 횟수만으로 effort를 올리지 않는다. Lead는 기존 세션 모델을 사용하고, CI 대기와 병합 조건 판정은 스크립트가 수행한다.

완료는 Git 병합 증명을 뜻한다. 운영 버전 통합검증·배포·티켓 전이는 별도 기존 절차를 유지한다. 실제 QA 단축 효과와 자동 병합은 fixture 결과만으로 실측 완료라고 부르지 않는다.

### DEV-14 동기화와 병합 증명

저장소 어댑터는 검증된 binding release의 `core/delivery.cjs`에서 `dev14Version === 1`을 확인한 뒤 기존 `workflow(binding, {action:'delivery', ...})`에 `dev14: {candidate: task.candidate, mergeAuthorized, sensitivePaths}`를 추가한다. 이전 release는 이 옵션을 무시하므로 버전 확인에 실패하면 DEV-14 호출을 중단한다. `mergeAuthorized`는 Lead가 해당 업무의 사용자 권한과 미해소 결정을 확인한 결과다. PR까지만 허용된 업무에는 쓰기 권한을 주지 않는다. `sensitivePaths`에는 저장소 고유의 공용 설정·계약 파일이나 디렉터리를 상대 경로로 추가한다. 이 옵션을 보내지 않는 어댑터는 기존 고정 head/base 검사를 사용한다.

- 최초 게시 head·base·tree, QA 보고서의 후보 지문, 해당 경로의 Git 모드·삭제 여부·바이트 SHA-256을 대조한다. main이 이동하면 양쪽 변경 경로의 교집합과 lockfile·CI·공통 설정·계약 변경을 확인한다. 충돌, 겹침, 민감 변경, 설명되지 않는 PR 커밋은 재검증 대상이다.
- 조건을 충족하면 `apply`에서만 확인한 PR head와 main을 부모로 하는 동기화 커밋을 만들어 PR 브랜치에 일반 push한다. 업무 checkout과 최초 게시 근거는 보존한다. 이 호출은 `phase: ci`로 끝난다. 이후 호출은 각 동기화 커밋의 부모와 전체 tree를 다시 확인한다. 최종 head의 필수 CI·리뷰·서버 보호 규칙을 충족할 때만 그 head를 지정해 squash한다.
- 이미 병합된 업무는 같은 입력에 `proofOnly: true`를 주고 `apply`를 생략한다. 같은 저장소의 원본 checkout에서도 조회할 수 있다. 미병합 PR은 `not-merged`, 자격이 부족한 병합은 `proof-blocked`로 반환한다. 증명에는 실제 병합 SHA, main 포함 여부, 전체 예상 tree, QA 후보 경로 일치, 최종 head의 필수 CI 결과가 있다. 현재 유효한 main 보호 규칙에서 필수 검사 이름과 지정된 GitHub App도 대조한다. 과거 PR이 지금의 규칙을 증명할 수 없으면 자동 종결을 보류한다.
- 대장 쓰기는 저장소 Lead CLI가 맡는다. BLOCKED 상태에서는 증명 전용 경로만 허용한다. 잠금 안에서 업무·후보·PR·binding이 같은지 다시 확인하고 `merged`일 때만 원래 게시 근거(`original`)와 증명을 보존하며 DONE을 기록한다. `proof-blocked`나 `not-merged`이면 기존 상태와 근거를 보존한다. 민감 경로가 바뀐 과거 병합을 후보 파일 일치만으로 종결할 수 없다.

개인 AI 개발 하네스의 단계별 위임 정책, 공통 결정함, 실행 진입점, Herdr mod를 함께 관리한다. 프로젝트의 스킬·산출물 검증·업무 데이터는 각 프로젝트에 남긴다.

Herdr 패널은 모든 저장소와 원격 공간에서 작업 브리핑을 제공한다. 현재 공간의 CLI 활동과 원문 보고를 보여주고 해당 터미널로 이동할 수 있다. `projects.json`에 등록된 로컬 저장소에서는 결정 질문·새 결과·업무 대장·QA 상태를 추가로 보여준다. 하네스가 없는 저장소의 CLI 입력 대기를 승인 질문으로 해석하거나, 연결되지 않은 기능을 0건으로 표시하지 않는다.

v2 업무 카드는 독립 QA 통과 뒤 게시 대기·CI 대기·병합 차단·병합 완료를 구분한다. 설계 검토가 포함된 업무는 진행 막대에 해당 단계를 표시한다. 카드를 펼치면 현재 릴리스의 단계별 위임 모델과 업무별 모델 예외, 각 회차에 기록된 모델, 최근 검증 판정, PR 번호와 병합 커밋을 확인할 수 있다. v1 업무의 완료 표시는 로컬 QA 기준을 따른다.

좁은 패널에서도 결정 질문과 진행 업무를 훑도록 구성했다. 모델·단계 이력은 업무를 펼쳤을 때 표시한다. 질문은 선택지의 설명까지 한 행으로 묶고, 선택 후 별도 보내기를 눌러 전달한다. 하네스 연결 저장소의 «알아둘 변화»는 패널 맨 아래에 고정하며, 별도 스크롤과 접기·펼치기를 제공한다. 개별 확인과 전체 읽음은 읽음 상태만 바꾸며 결정 질문을 해소하지 않는다.

## 관리 경계

| 여기에서 한 번 관리 | 프로젝트에서 관리 | 로컬에만 보관 |
|---|---|---|
| 질문 등록·수정·해소와 revision | 조사·구현·QA·architect 스킬 | `projects.json`, 설치 계획 |
| 모델·effort·Fast·프로필·재작업 상향·실행 한도 | 스킬 경로·호출명·품질 기준 | 고정 release 경로와 binding |
| 결정함 검증·원자 저장·mod 브리핑 | 승인 근거·후보 지문·파일 겹침 판정 | 대장·결정 기록·실행 로그·인증 |
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

## Claude 로그인

Claude CLI의 기본 설정(`~/.claude`)과 `/login`으로 로그인하고 계정을 바꾼다. 하네스는 `claude`를 직접 실행하며, 계정별 설정 폴더 전환이나 장기 토큰 주입을 하지 않는다. 사이드바는 기본 Claude 설정과 Codex의 사용량만 표시한다.

## 확장 로그인 없이 사용하는 E2E 브라우저

`bin/herdr-browser.mjs mcp`는 Chrome DevTools MCP를 프로젝트 전용 Chrome 프로필에 연결한다. Claude 브라우저 확장을 거치지 않으므로 CLI 계정과 확장 로그인 계정을 맞출 필요가 없다. 테스트 사이트에는 전용 브라우저에서 별도로 로그인한다. 프로필은 `%LOCALAPPDATA%/HerdrBrowser/profiles/<프로젝트 키>`에 남고, 같은 Git 저장소의 worktree는 같은 브라우저를 사용한다. 병렬 에이전트는 각자 생성한 탭 ID를 사용해야 한다.

Windows에서 Chrome과 Node.js가 필요하다. MCP 패키지는 `npm install --prefix "$env:LOCALAPPDATA/HerdrBrowser/tools" --save-exact chrome-devtools-mcp@1.13.0`으로 설치한다. Claude의 `herdr-browser` MCP는 `node <설치 release>/bin/herdr-browser.mjs mcp`를 실행하도록 등록한다. 브라우저만 열려면 `node <설치 release>/bin/herdr-browser.mjs open`을 사용한다. 두 명령의 마지막 인자로 프로젝트 키를 명시할 수도 있다.

브라우저는 개인 Chrome과 별도 프로필로 실행하며 확장을 비활성화한다. CDP는 로컬 주소에서만 연결하고, 프로필에 기록된 브라우저 식별자가 일치할 때만 재사용한다. MCP 클라이언트가 종료돼도 브라우저와 사이트 로그인은 유지한다. 현재 구현은 별도 창과 MCP 연결이며 Herdr 내부 브라우저 패널은 포함하지 않는다.

브라우저를 미리 실행하거나 디버깅 포트를 지정할 필요는 없다. 브라우저 도구를 처음 호출할 때 전용 Chrome을 실행하며, 창을 닫은 뒤에도 다음 호출에서 다시 실행하고 새 포트에 연결한다. MCP 세션은 유지된다. 재실행으로 사라진 탭·요소 ID는 다시 조회해야 하며, 진행 중 실패한 클릭·입력은 자동 재전송하지 않는다.

## 준비와 검증

Node.js 22 이상, Git, Herdr App이 필요하다. Python 프로젝트 CLI에는 기존 Python 환경도 필요하다. npm 외부 의존성은 없다. mod 아이콘은 Herdr가 제공하는 `workspace-chrome` mod를 사용한다.

```powershell
npm test
node scripts/build.mjs
```

build는 명시한 파일만 `dist/<manifest SHA-256>/`에 묶는다. `mod/harness/decisions.js`와 `contract.js`는 `core/`에서 생성하는 Git 제외 산출물이다. 직접 수정하지 않는다. manifest 내용은 파일명·버전·SHA-256이며 개인 경로나 실행 기록을 포함하지 않는다. 커밋 전 후보도 내용 해시로 고정할 수 있지만, 그것을 커밋·릴리스 게시라고 부르지 않는다.

Git은 JS·JSON 소스를 LF로 체크아웃한다. 편집기가 CRLF로 저장해도 build는 이 파일들의 CRLF를 LF로 통일한 바이트로 해시와 패키지를 함께 만든다. 미커밋 소스 수정도 다음 후보에 포함된다.

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
2. 테스트를 통과한 뒤 `node scripts/install.mjs .local/install.json`을 실행한다. `harness`와 같은 상위 폴더의 `harness-auto`, `claude-accounts`도 함께 설치·백업·검증한다. 기존 layout의 `harness-auto` 블록이 모든 공간에서 패널을 표시한다. 같은 공간에서 사용자가 닫으면 다음 공간 전환까지 다시 열지 않는다.
3. staging native check → 소스·binding 백업 → 설치 → native check를 통과하면 active 기록을 바꾼다. `node scripts/verify-install.mjs <store>`로 실제 설치 파일 지문을 검증한다.
4. 기존 Lead가 새 CLI와 프로젝트의 `COMMON.md` 지침을 사용하는지 별도로 확인한다. 설치는 Lead에 메시지를 보내거나 현재 업무를 재시작하지 않는다.

각 상태 폴더의 `harness-binding.json`은 release 경로·manifest 지문·project ID·CLI command/cwd·adapterConfig와 선택 실행 한도 `timeout`(1~2147483647 범위의 정수 ms)을 담는다. 화면도 이 설정과 release의 공통 한도를 읽어 오래된 main 설정을 표시하지 않는다. 업무 내용·인증 정보는 넣지 않는다. 설치 프로그램은 프로젝트의 추적 파일을 수정하지 않으므로 회사 adapter 변경은 별도 브랜치로 검토·게시한다.

기존 `projects.json`은 보존하고 처음 설치에만 빈 설정을 만든다. 예시는 `examples/projects.example.json`이다. 업무 대장·결정 기록·Herdr 읽음 상태는 설치와 복구가 건드리지 않는다. 소스를 수정해도 설치본은 자동으로 바뀌지 않는다. 검증 후 명시적으로 재설치한다.

```powershell
node <release>/bin/harness.mjs --binding <상태폴더>/harness-binding.json decision list
node <release>/bin/harness.mjs --binding <상태폴더>/harness-binding.json policy --stage implement --profile normal --rework 1
node scripts/rollback.mjs <store>
```

이 저장소의 자체 binding은 release launcher를 직접 호출하지 않고, binding의 `cwd`인 등록 checkout의 `.agents/harness/launch.mjs`에 같은 binding 경로를 넘겨 `whoami`와 `policy`를 확인한다. 상태 폴더 경로만 실제 값으로 바꾼다.

```powershell
$bindingPath = (Resolve-Path -LiteralPath '<상태폴더>/harness-binding.json').Path
$pin = Get-Content -Raw -LiteralPath $bindingPath | ConvertFrom-Json
$launcher = Join-Path $pin.cwd '.agents/harness/launch.mjs'
node $launcher --binding $bindingPath whoami
node $launcher --binding $bindingPath policy
```

두 명령이 종료 코드 0으로 끝나고 `whoami`의 `project`·`root`가 binding의 프로젝트·`cwd`와 같으며, 두 출력의 `releaseHash`가 binding의 `manifestHash`와 같아야 한다. `policy` 출력의 `execution`·`workflow`가 이 release에서 적용되는 실행·작업 흐름 정책이다.

rollback은 직전 소스·binding을 복원한다. 설치 이후 수동 변경이 있으면 덮어쓰지 않고 거부한다. 새 질문이나 사용자 설정은 되돌리지 않는다. 로컬 백업에는 이전 개인 파일 내용이 있으므로 store를 Git에 넣지 않는다.

### 작업 폴더 준비와 실행 한도

`prepare`, `dispatch`, `next --go`는 공통 런처에서 PC 전체의 준비 슬롯 하나를 사용한다. 여러 저장소의 `git worktree add`가 동시에 디스크를 점유해 준비 중 시간 초과가 나는 일을 줄이기 위한 장치다. 현재는 worktree 생성·의존성 설치·위임을 포함한 CLI 한 호출을 직렬화하며, 이미 실행 중인 에이전트는 영향을 받지 않는다. `whoami`, `show`, `next`의 안내, 질문·결정 조회 등은 슬롯을 잡지 않는다. 전체 시험·빌드의 `heavy` 2개 슬롯과 별도다.

- 순서 대기 후에 실행 한도(binding `timeout`, 기본 600000ms)를 시작한다. 느린 저장소는 설치 계획에 `timeout: 1800000`처럼 지정한다. stderr에 대기 시간·준비 시작·실행 시간이 따로 나오며, stdout의 기존 JSON은 유지한다.
- 한도를 넘기면 하위 프로세스까지 종료하고 124, 취소하면 하위 프로세스 종료 확인 뒤 130을 반환한다. 종료 전에는 슬롯을 반환하지 않는다. 대기 중 binding이 바뀌면 실행하지 않고 새 launcher 사용을 요구한다.
- `node <release>/bin/harness.mjs --binding <file> preparation-status`로 점유 PID·프로젝트·시각을 읽는다. 기본 잠금은 `%LOCALAPPDATA%/HerdrHarness/preparation/active.json`이며 시험 격리에만 `HERDR_PREPARATION_DIR`를 쓴다.
- 강제 종료로 남은 잠금은 시간만 보고 지우지 않는다. 죽은 소유자면 실패로 알리며, 소유 프로세스와 하위 Git까지 종료됐음을 확인한 뒤 해당 잠금만 복구한다. 부분 worktree·브랜치는 자동 삭제하지 않는다. [끝난 업무 worktree 정리](#끝난-업무-worktree-정리)도 대장의 DONE 업무만 다루므로 이 잔재를 지우지 않는다.
- 구 release로 이미 시작한 준비나 직접 Git/프로젝트 CLI를 실행한 작업은 이 슬롯에 참여하지 않는다. 최초 전환 시 기존 checkout을 끝내고 새 binding의 launcher를 사용한다. 원시 디스크 성능 문제가 해결됐거나 기존 대장의 잠금 문제가 수정됐다는 뜻은 아니다.

### 준비·설치 계측 규약

준비 병목을 큐 대기·슬롯 점유·설치·첫 검사로 나눠 비교하기 위한 기록이다. 정의는 [core/metrics.mjs](core/metrics.mjs)의 `KINDS` 하나이며, 종류별로 `%LOCALAPPDATA%/HerdrHarness/metrics/<종류>.jsonl`에 한 줄씩 덧붙인다(시험 격리에만 `HERDR_METRICS_DIR`). 모든 줄에 `v`(1)·`kind`·`at`·`pid`가 붙고, 정의되지 않은 필드나 형식이 틀린 값은 기록하지 않는다.

| 종류 | 기록 주체 | 필드 |
|---|---|---|
| `preparation` | 공통 런처 | `project`, `command`(CLI 하위 명령), `acquired`, `wait_ms`(순서 대기), `run_ms`(슬롯 점유), `exit` |
| `heavy` | `bin/heavy.mjs` | `cwd`, `label`, `slot`(0부터), `wait_ms`, `run_ms`, `exit` |
| `deps-install` | 저장소 어댑터 | `project`, `task`(선택), `worktree`, `trigger`(first-use·stamp-mismatch·forced), `install_ms`, `import_method`(hardlink·clone·copy·unknown), `store_dir`(선택), `result`(ok·failed·timeout), `error_code`(선택) |
| `first-check` | 저장소 어댑터 | `project`, `task`(선택), `worktree`, `label`, `run_ms`, `result` |

로컬 공간의 하네스 패널이나 기본 브리핑에서 **준비·자원** 카드를 펼치면 이 PC의 준비 슬롯과 시험·빌드 슬롯을 15초마다 조회한다. 카드는 설치 프로그램이 mod 폴더에 기록한 `release.json`에서 해당 버전의 조회 명령을 찾는다. 준비 슬롯에는 프로젝트·소유 PID·시작 후 경과 시간이 나온다. 종료된 소유자와 형식을 확인할 수 없는 잠금은 별도로 표시한다.

프로젝트별 요약은 `preparation.jsonl`과 `deps-install.jsonl` 각각의 마지막 200행을 대상으로 하며, 파일당 뒤에서 최대 256 KiB까지 읽는다. 대기 시간은 모든 준비 호출, 점유 시간은 슬롯을 얻은 호출의 p50·p95다. 정렬한 측정값에서 해당 백분위 순위를 올림해 선택한다. 미획득·0 이외 종료 코드·종료 코드 없음은 각각 집계한다. 설치의 **전체 시도 평균**에는 성공·실패·시간 초과가 모두 들어간다. **성공 평균**은 `result=ok`인 설치 시간의 산술평균이다. 두 평균은 각각의 건수와 함께 밀리초 단위로 반올림해 표시하며, 성공이 0건이면 성공 평균을 `—`로 표시한다. import 방식별 건수도 함께 표시한다. 카드 조회는 잠금과 계측 파일을 읽기만 한다.

- 준비 기록은 호출마다 한 번 남는다. 슬롯을 얻기 전에 취소·실패하면 `acquired: false`, `run_ms: 0`, `wait_ms`는 실제 대기다. 순서 대기에는 앞선 준비의 남은 실행과 폴링 간격이 들어간다. `exit`은 결과 코드이며, 결과 없이 끝나면 취소는 130, 그 밖의 예외는 null이다. 남의 잠금은 기록 여부와 무관하게 보존한다.
- 명령 원문은 남기지 않는다. 인라인 환경변수나 인증 인자가 섞일 수 있어서다. 하위 명령과 인자 값은 모양으로 구별할 수 없으므로 `label`은 `KNOWN_LABELS`에 등록된 조합(예: `cargo test`, `pnpm verify`, `bun run docs:build`)이거나 실행 파일 이름(경로·확장자 제외)만이다. heavy는 원문에서 등록된 조합 중 가장 긴 것을 고르고 없으면 실행 파일 이름만 쓰며, 원문의 다른 단어는 복사하지 않는다. 단순 명령 문법만 해석하므로 공백·탭 외의 공백 문자, 값이 단순 문자(영숫자 `. _ : / -`, 빈 값)를 벗어나는 앞쪽 환경변수 할당(따옴표·이스케이프·치환·붙은 리디렉션), 실행 파일 자리의 리디렉션·셸 연산자가 있으면 `unknown`으로 둔다. 어댑터는 `first-check.label`에 원문을 조합하지 않은 정적 라벨을 넣는다. 새 조합이 필요하면 목록에 추가한다.
- 어댑터는 실제 설치·첫 검사를 호출한 곳에서 `node <release>/bin/metric.mjs <종류> '<JSON>'`으로 남긴다. 정의된 종류·필드(상속 속성 제외)만 받고, 잘못된 입력은 파일을 만들지 않고 2로 끝난다. 이 CLI의 실패로 본 명령의 결과를 바꾸지 않는다.
- `deps-install`은 설치를 실제로 수행한 호출에만 남긴다. 표식을 재사용했거나 다른 호출의 설치를 기다린 호출은 설치 횟수로 세지 않는다. `first-check.run_ms`에는 ensure 설치와 대기 시간을 넣지 않는다.
- `import_method`는 pnpm 출력이나 파일 연결 확인으로 관측한 경우에만 적고, 모르면 `unknown`으로 둔다.
- 설치 실패나 시간 초과에서 도구가 보고한 오류 코드가 있으면 `error_code`에 코드 하나만 넣는다(예: `ENAMETOOLONG`). 형식은 `^E[A-Z0-9_]{1,40}$`이다. 메시지·경로·숫자 종료 코드는 이 필드에 넣지 않는다. 성공했거나 코드를 확인할 수 없으면 필드를 생략한다. 시간 제한으로 중단됐는지는 기존 `result`로 기록한다. 자원 카드는 코드가 없는 기존 기록도 실패·시간 초과 건수에 포함하고, 오류 코드별 건수는 코드가 있는 기록에서만 센다. 어댑터는 이 필드를 지원하는 릴리스로 binding을 갱신한 뒤부터 전송한다.
- 공통 런처와 heavy 실행기의 기록 실패는 stderr 경고만 남기며 명령 결과를 바꾸지 않는다. 각 binding은 고정된 release를 쓰므로 기능을 켤 저장소는 재설치하고 실제 진입점으로 smoke를 확인한다.
- 2026-11-18 참고값(E: ReFS, pnpm 9.7.0, SW 명세 23개, `--ignore-scripts`): 빈 store 6.6초, 찬 store 2.6초, store와 hardlink 확인. 설치 스크립트를 포함한 실제 worktree 값은 이 규약으로 다시 잰다.

2026-11-17 vms-design-platform에서는 예전 런처의 시간 초과 뒤에도 `git worktree add`가 띄운 Git 프로세스가 남아 worktree가 `locked initializing` 상태로 멈췄다. 현재 런처는 Windows에서 `taskkill /T /F`로, 그 밖의 환경에서는 프로세스 그룹 단위로 하위 프로세스를 종료한다. 중단된 worktree는 하위 Git 프로세스의 종료를 확인한 뒤 해당 저장소 CLI에서 정리한다.

## 위임 정책

정본은 [policy/execution.json](policy/execution.json) 하나다. 변경 후 검사·build·설치하면 세 프로젝트에 같은 정책이 적용된다. 새 CLI는 공통 설치가 없거나 지문이 다르면 실패하며 예전 모델로 조용히 돌아가지 않는다. 이미 실행 중인 에이전트는 유지하고 다음 위임부터 적용한다. 구 checkout의 직접 CLI 호출은 설치된 command를 우회하므로 Lead는 binding의 release와 공통 launcher를 사용한다.

| 단계 | 모델 | 기본 effort | Fast |
|---|---|---|---|
| 조사 | gpt-6-astra | high | 끔 |
| 구현 | claude-opus-5-5 | high | 끔 |
| QA | gpt-6.1-sol | xhigh | 켬 |
| 설계 검토 | claude-fable-5-2 | high | 끔 |

`simple`과 `normal`은 기본값, `complex`는 구현 xhigh(조사는 모든 프로필 high, QA는 모든 프로필 xhigh), `high-risk`는 complex에 설계 검토와 단독 구현을 추가한다. 옛 이름은 모든 저장소에서 같은 별칭으로 지원한다: ui-simple→simple, feature→normal, shared-component→complex, token/architecture/high→high-risk. 재작업마다 구현 effort를 한 단계 올려 max에서 멈춘다. 프로젝트별 동시 실행 6, 재작업 최대 2, 자동 실행 재시도 0이다.

사용자 지정 배치는 조사 Astra/high, 설계 Fable 5.2/high, 구현 Opus 5.5/high, QA Sol/xhigh다. Fast는 QA에서만 켜고 나머지 단계는 끈다. 모델의 CLI가 바뀌면 표준 `.agents/skills`·`.claude/skills` 경로와 `$`·`/` 호출도 공통 resolver가 함께 맞춘다. 저장소별 스킬 이름·인자와 사용자 지정 경로는 유지한다. Codex danger-full-access, Claude auto를 실행 인자로 지정한다. Windows의 Codex sandbox(workspace-write)에서는 하네스 단계를 수행할 수 없다. elevated는 별도 계정이라 사용자 프로필의 python·node·hc를 읽지 못한다. unelevated는 Node의 자식 프로세스(git, node --test worker)가 EPERM으로 실패하고, pnpm 저장소 잠금과 hc의 Herdr pipe에도 접근하지 못한다. 그래서 Claude 단계와 같이 OS sandbox 없이 실행한다. 쓰기 범위는 worktree와 작업 지시서 규칙으로 제한한다. Codex 셸로 쓰는 PowerShell 7은 MSI판(`C:\Program Files\PowerShell\7`)을 설치한다. Codex 승인·네트워크 등 지정하지 않은 사용자 설정은 계속 상속하며 전역 설정을 쓰지 않는다. Fast 비활성화는 Codex의 `service_tier="default"`와 Claude의 `fastMode:false`로 명시한다([Codex 설정](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude Fast 설정](https://code.claude.com/docs/en/fast-mode)). Claude 하위 에이전트는 `statusLine`을 빈 명령으로 덮어 사용자 statusline을 실행하지 않는다. 짧은 실행이 끝날 때 statusline용 Git Bash가 고아로 남아 쌓이는 것을 막기 위해서다.

현재 세 저장소의 `execution_overrides`는 모두 `{}`다. 앞으로 의도적 예외가 필요하면 프로젝트 config에 `execution_overrides: {"reason":"구체적인 사유", "roles":{"implement":{"effort":"medium"}}, "limits":{"max_parallel":1}}`처럼 선언한다. roles에는 모델·effort·Fast·실행 모드만, limits에는 공통 한도만 허용한다. 예전 roles의 model/args나 별도 routing은 거부하므로 중복 설정이 조용히 살아남지 않는다. 적용 순서는 공통 역할 → 명시적 저장소 예외 → 프로필 effort → 재작업 상향 → 사유 있는 업무별 model/effort 예외다. run의 `x_execution_policy`에 정책 지문·release·예외·실제 요청 Fast를 남긴다. 이 기록은 요청값이며 실제 모델 사용 증거는 각 CLI의 evidence로 구분한다.

## 공용 자원과 단계 공통 규칙

한 PC에서 여러 저장소의 에이전트가 동시에 전체 시험·빌드를 돌리면 CPU가 포화된다. 그러면 무관한 시험이 불안정해지고 빌드가 타임아웃으로 실패한다. 이를 막기 위한 공통 설정은 [policy/execution.json](policy/execution.json)의 `resources`·`instructions`다. resolver는 이 설정을 각 CLI 자체 옵션으로 argv에 넣는다. 프로젝트 CLI는 argv를 그대로 실행하므로 회사 저장소는 바꾸지 않아도 된다. 이미 실행 중인 에이전트는 유지하고 다음 위임부터 적용된다. Lead 세션은 resolver로 실행하지 않으므로 이 설정이 적용되지 않는다.

- **병렬도 상한**: `resources.env`(`CARGO_BUILD_JOBS`, `RUST_TEST_THREADS`, `VITEST_MAX_THREADS`, `VITEST_MAX_FORKS`)를 에이전트가 실행하는 명령의 환경으로 준다. Codex는 `shell_environment_policy.set`, Claude는 `--settings`의 `env`로 전달한다. 명령에 명시한 옵션(예: `--maxWorkers=50%`)은 이 환경보다 우선한다.
- **무거운 작업 슬롯**: 모든 저장소가 함께 쓰는 동시 `resources.heavy_slots`개 슬롯이다. 지시를 받은 에이전트는 전체 시험·빌드를 `node <release>/bin/heavy.mjs -- <명령>`으로 실행한다. 슬롯이 차 있으면 빌 때까지 기다린 뒤 시작한다. 점유 정보는 `%LOCALAPPDATA%/HerdrHarness/heavy-slots/slot-N.json`에 있다. 점유 프로세스가 사라진 슬롯은 다음 대기자가 회수한다. `node <release>/bin/heavy.mjs status`로 현재 점유를 본다.
- **단계 규칙**: `instructions.all`은 모든 단계에, `instructions.<단계>`는 해당 단계에만 Codex `developer_instructions`, Claude `--append-system-prompt`로 전달한다. QA 규칙은 세 가지다.
  - 후보와 무관한 실패는 단독 재실행으로 «불안정» 또는 «기존·환경 실패»로 분류하고 FAIL 사유로 쓰지 않는다.
  - 환경 실패가 난 장시간 명령은 조건이 같으면 다시 실행하지 않고 «재위임 전 필요 조건»을 남긴다.
  - 게이트가 실패하거나 멈춰도 BLOCKED로 완료 보고를 보낸다.

## 과정 산출물

업무 진행 중에 쓰는 과정 문서(Project README·implementation·qa-report 등)는 기본으로 main에 커밋하지 않는다. 정본은 [policy/artifacts.json](policy/artifacts.json)이고 판정·보관은 `core/artifact-policy.cjs`가 맡는다. 업무 PR 뒤에 과정 문서만 지우는 정리 PR을 따로 만들지 않기 위해서다.

- **선언**: 프로젝트 config에 `process_artifacts: {"paths": ["docs/projects/{slug}/"]}`처럼 업무별 과정 문서 폴더를 선언한다. 자리표시자는 `{id}`·`{slug}`·`{date}`만 쓸 수 있고, 하나 이상 들어가야 한다. 그래서 `docs/projects/README.md` 같은 공용 색인은 과정 문서로 잡히지 않는다. 선언하지 않은 저장소는 기존처럼 동작한다.
- **커밋 여부**: 공통 기본은 `commit: false`다. 커밋해야 하는 저장소는 `commit: true`와 `reason`을 함께 둔다. 이미 main에 있고 남기기로 한 폴더는 `exempt: [{path, reason}]`로 지정한다.
- **진행 중**: collect의 README·qa-report 게이트와 후보 지문은 worktree의 미커밋 파일을 그대로 읽는다. 과정 문서를 커밋하지 않아도 게이트는 바뀌지 않는다.
- **보관**: 단계 수집 뒤, 그리고 worktree를 정리하기 전에 `archive`로 `<state_dir>/tasks/<ID>/artifacts/`에 복사한다. [worktree 정리](#끝난-업무-worktree-정리)는 `preserve`로 같은 위치에 과정 문서와 지정 파일을 함께 보관한다. 보관은 같은 경로만 덮어쓰고, 이전 회차 보관본은 지우지 않는다. `manifest.json`에는 파일별 SHA-256을 남긴다.
- **게시**: 커밋 전에 `violations`로 과정 문서의 추가·수정·이름 변경을 걸러 낸다. 삭제는 기존 문서 정리이므로 허용한다. 오래 남을 내용은 같은 업무 PR 안에서 옮긴다. 바뀐 계약은 Area로, 다시 쓸 조사 결론은 Resource로, 후속 작업은 Area 후속 절이나 티켓으로 보낸다.
- **증거**: PR 본문과 티켓 NOTE에 QA 판정·회차, 실행한 검사와 종료 코드, 실패·skip·미실행·외부 미검증, 단계별 실제 CLI·모델·effort를 적는다. 병합 SHA 기준의 Project 파일 고정 링크로 증거를 대신하지 않는다.
- **CI**: 저장소 CI는 PR 변경 목록을 같은 규칙으로 검사해 실패만 시킨다. 파일을 고치거나 지우지는 않는다. CI에는 개인 release가 없으므로 저장소 스크립트가 config 선언을 직접 읽는다. 공통 `violations`와 같은 판정이 나오는지는 저장소 시험에서 확인한다.

CLI는 binding으로 고정한 release를 호출한다. Python CLI도 같은 JSON 진입점을 쓴다.

```powershell
'{"action":"violations","project":"<id>","stateDir":"<상태폴더>","config":{...},"changes":[{"status":"A","path":"docs/projects/x/README.md"}]}' | node .agents/harness/runtime.cjs <상태폴더>/harness-binding.json artifacts
```

동작은 `config`, `resolve`(`vars`), `violations`(`changes`), `archive`(`task: {id, worktree, vars}`)다. 보관 파일과 manifest는 새 임시 파일에 쓴 뒤 이름을 바꾸므로 보관 위치의 기존 하드 링크가 가리키는 원본을 바꾸지 않는다.

## 결정함 규칙

«업무 진행»에서 진행 중인 일과 막힌 일을 함께 본다. 업무에 연결된 질문과 선택지는 해당 카드에 표시하며, 업무 등록 전 질문이나 목록에서 숨겨진 업무의 질문도 답할 수 있다. 상단의 «내 답변 필요»는 열린 질문과 질문이 따로 등록되지 않은 명시적 승인·결정 요청을 센다. Lead의 병합 메모가 있고 대장 종결이 보류된 업무는 프로젝트·업무 번호·단계와 Lead의 다음 확인 사항을 표시한다. «근거 보기»에서 중단 사유 원문, QA 근거와 이력을 읽을 수 있다.

명시적인 결정 요청이나 사용자 요청으로 중단된 업무에서는 «Lead에게 지시…»로 자유 입력한 내용을 보낼 수 있다. 그 밖의 막힘에는 «근거 보기» 안에 같은 기능이 있다. 선택지를 추측해서 만들지 않으며, 업무 ID·표시 사유·사용자 원문을 현재 Lead에게 전달한다. 전달 후에는 «Lead 처리 대기»로 표시하고, 모드는 승인·결정 해소·재개를 직접 기록하지 않는다. 입력 뒤 업무의 막힘 사유·상태·Lead·현재 저장소가 달라지거나 대장을 갱신하지 못하면 이전 입력을 전송하지 않는다. 전송 실패 시 원문으로 다시 입력할 수 있다.

현재 대장에 등록된 살아 있는 Lead가 `decision request KEY --file 질문.json`으로 먼저 등록한다. 질문은 `question`, `source`, 선택 `task`, `kind`, `options`, `reason`, `recommendation`으로 구성한다. 업무 등록 전에는 `task:null`, DONE 이후에도 후속 질문을 남길 수 있다.

질문을 수정할 때는 `--revision 현재값`을 요구한다. 해소는 실제 답변의 `quote`와 `source`를 담은 파일로 `decision resolve KEY --file 답변.json --revision 질문revision`을 실행한다. 사용자가 질문의 선택지를 실제로 골랐으면 그 label을 `selection`에 함께 적는다. `selection`은 선택지 label 중 하나여야 하고, 자유 답변이나 선택지 없는 질문에는 적지 않는다(기록은 `null`). 추천값이나 답변 문장에서 선택을 추측하지 않는다. 같은 입력의 재시도는 멱등적이고, 이미 해소된 질문의 답변·출처·선택은 덮어쓰지 않는다. 읽음·다른 업무 완료·Lead 새 보고는 해소 근거가 아니다. 결정함 해소는 업무 승인이나 Git 작업을 대신하지 않는다.

읽기 오류·다른 프로젝트·설치 변조는 정상적인 빈 결정함으로 취급하지 않는다. 입력 파일과 설치본이 유효하지 않으면 기존 기록을 보존하고 실패한다. 상태 파일의 기록 크기는 mod 읽기 한도인 1 MiB를 넘기지 않는다.

모드의 질문 카드에서 사용자가 답을 고른 뒤 보내기를 누르면 모드가 `hc send`로 Lead 터미널에 `[사용자 결정 · Herdr 하네스 모드] 질문 <KEY>(revision N)의 답: "..."`를 보낸다. Lead는 이 문장을 `quote`, 출처를 `Herdr 하네스 모드 사용자 선택`으로 해 해소를 기록한다. 따옴표 안이 선택지 label과 같으면 그 label을 `selection`에 적는다. revision이 결정함과 다르면 기록하지 않고 다시 묻는다. 모드는 결정함을 직접 쓰지 않는다.

## 검증 계획 실행 위치와 해소 결정 인계

v-project VP-TASK-029에서 두 가지 결함이 드러났다. 조사가 독립 QA에서 실행할 수 없는 실기기·브라우저 검사를 필수 검사로 넣었고, QA 지시서는 브라우저를 금지해 QA가 구조적으로 BLOCKED가 됐다. 사용자가 «배포 후 실기기 확인»으로 결정했지만 그 결정이 다음 QA 지시서에 들어가지 않았다. 공통 release는 검사의 실행 위치를 동결 계획에 분류하고, 업무에 연결된 해소 결정을 다음 단계 지시서에 넣는 경로를 제공한다. 분류·동결·남은 검증·PR 본문 대조는 `core/workflow.cjs`, 위치 이름과 문구 길이 상한은 `policy/workflow.json`의 `plan`, 결정 조회는 `core/decisions.js`·`core/decision-store.js`가 정본이다.

### 계획 형식과 동결

새 계획은 기존 v2 형식에 `checkScopes`를 더한다. `checkScopes`에는 모든 검사를 한 번씩 적는다.

```json
{"version":2,"criteria":["AC1","AC2"],"checks":["hh-suite","copy-unit"],
 "checkScopes":[
  {"id":"hh-suite","location":"independent-qa","executor":"hh-suite","criteria":["AC1"]},
  {"id":"copy-unit","location":"independent-qa","executor":"node-test","command":"node --test test/copy.test.mjs","criteria":["AC1","AC2"]},
  {"id":"mobile-browser-copy","location":"follow-up","criteria":["AC2"],"environment":"배포 후 Galaxy Chrome","verify":"제목을 복사해 Teams에 붙여넣고 원문과 대조"}]}
```

| 위치 | 뜻 | 필수 필드 |
|---|---|---|
| `independent-qa` | 독립 QA가 후보 worktree에서 어댑터가 선언한 실행 수단으로 직접 실행해 판정한다. QA PASS의 필수 조건이다. | `executor`, 수단이 정한 형식의 `command`, `criteria` |
| `follow-up` | 배포 후·실기기·브라우저·외부 계정·운영 환경에서 확인한다. QA는 실행하지 않고 PASS를 막지 않는다. 게시 PR 본문의 «남은 검증»에 그대로 싣는다. | `environment`(확인 시점·실행 환경), `verify`(확인 방법), `criteria` |

어댑터는 `freezePlan(plan, {executors, required})`(runtime의 `freeze`)로 동결한다. 아래 중 하나라도 해당하면 오류에 원인 ID를 넣고 동결을 거부한다. 거부는 대장을 바꾸지 않는다.

- `checkScopes`가 없거나 비었다. 검사 행이 빠졌거나 같은 ID가 두 번 나온다. 지원하지 않는 위치거나 위치가 문자열이 아니다(`["follow-up"]` 같은 배열 포함).
- `checks`에 `follow-up` 항목이 있다(독립 QA가 실행할 수 없는 필수 지정). `independent-qa` 항목이 `checks`에 없다. 즉 `checks`는 `independent-qa` 항목의 ID 집합과 정확히 같다.
- `independent-qa` 행의 `executor`가 어댑터 선언에 없다. 특정 검사 ID 전용 수단(예: QA runner `hh-suite`)을 다른 검사에 쓰거나, 전용 ID를 다른 수단으로 적었다. ID 전용 수단 행에 `command`를 적었다(빈 문자열·`null` 포함. 버리고 동결하면 적은 명령과 실제 실행이 달라진다). `command`가 수단의 형식과 다르다. 행에 `environment`·`verify`를 함께 적었다.
- `follow-up` 행에 `executor`·`command`가 있다. `environment`·`verify`가 없거나 개행·제어문자를 포함하거나 300자(`plan.text_max`)를 넘는다. 두 문구는 PR 본문 목록 줄에 그대로 옮기는 일반 문장이어야 한다. 글을 숨기거나 다른 요소로 바꿀 수 있는 링크·이미지 대괄호(`[`, `]`), 꺾쇠(`<`, `>`: HTML 태그·주석·`<URL>` 자동 링크), 백틱, HTML 엔티티(`&lt;`, `&#60;` 등)가 있으면 필드·이유·ID를 넣어 거부한다. 예: `[](https://… "확인 방법")`처럼 빈 링크의 title에만 확인 방법이 있는 문구.
- 행의 `criteria`가 계획에 없는 AC를 가리킨다. `independent-qa` 행이 하나도 연결되지 않은 AC가 있다. 후속 확인으로만 판정되는 AC는 QA가 `unverified`로 적어 PASS가 막히므로, QA가 판정할 수 있는 부분과 후속 확인으로 나눠 적거나 결정 요청으로 올린다.
- 어댑터 필수 검사(`required`, HH의 `hh-suite`)가 `checks`에 없다.

동결 결과는 알려진 필드만 남긴 정규화 계획이다. 명령 형식 수단 행만 `command`를 남기고, 후속 설명의 앞뒤 공백을 지운다.

**실행 수단 선언.** 어댑터는 `executors`에 `{이름: {description, ids}}`(그 검사 ID 전용, 행에 command를 적으면 거부) 또는 `{이름: {description, pattern}}`(행 `command` 전체가 맞아야 하는 정규식)을 선언한다. HH는 `.agents/harness/config.json`의 `qa_executors`에 `hh-suite`(QA runner 전용), `node-test`(지정 시험 파일), `git-read`(Git 읽기 명령. 허용 목록의 조회 옵션만 받고 `--output`·`-O`·`--ext-diff` 같은 파일 출력·외부 명령 옵션과 따옴표·중괄호·와일드카드 같은 셸 확장 문자를 거부한다)를 둔다. 독립 QA 수단은 후보를 바꾸지 않아야 하므로, 명령 형식을 선언할 때 부작용 있는 옵션이 형식에 들어가지 않게 허용 목록으로 좁힌다. 수단 대조는 «선언된 QA 수단의 형식에 맞는다»까지만 기계로 확인한다. 실기기 검사를 일반 로컬 명령 형식으로 적으면 형식상 통과할 수 있으므로, architect 검토와 Lead가 검사 내용이 그 수단으로 실제 판정되는지 확인한다. 실행 위치는 환경이 정상일 때 그 역할이 실행할 수 있는지를 뜻한다. 허용된 QA 검사가 회차 중 환경 장애로 실패하면 기존 BLOCKED 경로를 따른다.

### QA와 남은 검증

- `collect`는 기존처럼 모든 AC와 `checks`(독립 QA 필수 검사)의 증거를 요구한다. 후속 확인 ID가 보고서 `checks`에 있으면 상태와 무관하게 거부한다. 후속 확인을 `passed`로 꾸미거나 `blocked`로 적어 PASS를 막지 못한다. PASS 사유에는 `남은 검증 N건`이 붙는다.
- `remainingVerification(plan)`(runtime의 `remaining`)은 후속 확인을 `{id, criteria, environment, verify, line}`으로 돌려준다. `line`은 PR 본문에 그대로 넣는 한 줄이다: `mobile-browser-copy (AC2) | 환경: 배포 후 Galaxy Chrome | 확인: 제목을 복사해 Teams에 붙여넣고 원문과 대조`.
- `missingRemaining(plan, body)`(runtime의 `pr-remaining`)는 PR 화면에 보이는 것이 확실한 목록 줄에 없는 항목을 돌려준다. GitHub 렌더링 전체를 흉내 내지 않고, 확인할 수 없는 문맥은 보이지 않는 것으로 본다(잘못 통과시키기보다 게시자가 본문을 고치게 한다).
  - 인정하는 줄은 들여쓰기 0~3칸의 `-`, `*`, `+` 목록 항목(`- [ ]`, `- [x]` 포함)이다. 이 줄은 항상 새 블록이라 앞 문단의 링크 제목·인라인 HTML에 묻히지 않는다. 순서 목록(`1.`), 표시 없는 줄, 4칸 이상 들여쓴 줄, 인용(`>`) 안의 줄은 앞 문단(예: 여러 줄 링크 제목)의 연속일 수 있어 인정하지 않는다.
  - 목록 표시를 뺀 나머지를 줄 끝(CRLF)·연속 공백만 정규화해 `line` 전체와 비교한다. ID만 겹치거나 환경·방법 일부가 빠진 줄은 누락이다. 본문이 `null`이거나 비면 모두 누락이다.
  - 같은 줄에서 닫히는 HTML 주석은 지우고 비교한다(줄 끝 메모 허용). 줄 맨 앞에서 시작한 여러 줄 주석 안의 줄은 숨는다. 닫히지 않은 주석은 본문 끝까지 숨는다.
  - 줄 맨 앞(들여쓰기 없음)의 ```` ``` ````·`~~~` 울타리 코드와 같은 줄에서 닫히는 인라인 코드, `\<`처럼 이스케이프한 표식은 문자 그대로다. 그 안의 `<!--`는 주석이 아니다. 울타리 코드 안의 줄은 목록으로 인정하지 않는다.
  - 그 밖의 HTML(태그·속성·`<details>` 같은 요소, 줄을 넘는 인라인 주석, 주석 뒤에 이어지는 글)이나 들여쓰거나 목록·인용 안에 있는 코드 울타리를 만나면, 그 뒤의 표시 여부를 확정할 수 없으므로 그 줄부터 본문 끝까지 인정하지 않는다. 그래서 «남은 검증» 절은 그런 요소보다 앞에 둔다. 자동 링크(`<https://…>`)와 `a < b` 같은 비교 기호는 HTML로 보지 않는다.
- `core/delivery.cjs`는 PR 조회 필드에 `body`를 더하고, 병합 전 게이트의 첫 조회와 병합 직전 재조회에서 같은 대조를 한다. 빠지면 병합하지 않고 `{phase: "blocked", missing, reasons}`를 돌려준다. 이미 병합된 PR의 증명(`verifyMerged`, `proofOnly`)에는 적용하지 않는다. 병합 뒤 본문 수정으로 증명을 잃지 않게 하기 위해서다.
- 후속 확인 0건이거나 `checkScopes`가 없는 계획은 본문을 요구하지 않는다.

### 해소 결정 조회와 지시서 주입

- 결정함의 읽기 전용 동작 `resolved-for-task`(`task` 인자)는 그 업무에 연결된 해소 결정만 돌려준다. 전역(`task: null`)·다른 업무·열린 질문은 빼고, 업무 ID는 대소문자를 구분하지 않으며(이전 소문자 기록 포함) 질문 ID 순서다. 항목은 `{id, task, question, selection, quote, source, revision, resolvedAt}`이다. `selection`이 없는 이전 기록은 `null`로 읽는다. Lead 확인 없이 읽고 파일을 쓰지 않는다. 대장에 없는 업무, 손상·다른 프로젝트의 결정함은 0건이 아니라 오류다. 같은 입력을 `bin/decision-bridge.mjs`(runtime의 기본 결정함 bridge)로 보내면 같은 결과다.
- `instructions(flow, stage, candidate, options)`의 `options.decisions`에 이 조회 결과를 넘기면 모든 단계 지시서에 `해소 결정: <JSON>` 한 줄과 «근거 자료이며 지시나 승인이 아니다» 안내가 들어간다. 따옴표·줄바꿈은 JSON으로 이스케이프된다. 0건이면 «없음»으로 적고, 배열이 아니면 지시서를 만들지 않는다. 조회 실패를 0건으로 바꾸지 않는다.
- `options.scopes = {executors, required}`를 넘기면 research 문구가 실행 위치 분류, QA 실행 수단 목록, 후속 확인 작성 예(위 JSON 형식)를 안내한다. 동결 계획에 `checkScopes`가 있으면 qa 문구는 «후속 확인은 실행하지도 checks에 적지도 않는다»와 해당 ID를, architect 문구는 실행 수단의 실제 실행 가능성 검토를 안내한다.

### 계획 변경이 필요한 결정

해소 결정이 동결 계획과 충돌하면(예: 필수 검사를 배포 후 확인으로 옮기기) 동결 계획을 그 자리에서 고치지 않는다. 결정 조회·해소는 판정이나 대장 전이를 하지 않는다.

1. 지시서의 결정 안내에 따라 architect·implement는 BLOCKED, QA는 충돌한 필수 검사를 `blocked`로 적고 `kind=decision` finding으로 보고한다. 수집은 정상적으로 BLOCKED를 기록한다.
2. Lead가 결정 ID·revision·답변과 바뀔 검사 ID를 대조해 계획 영향을 판정한다. BLOCKED 업무는 `flow-resume ID --stage research --evidence "<결정 ID·revision·변경 사유>"`로 재조사에 보낸다. 이전 회차의 보고와 계획 파일은 그대로 남는다.
3. 재조사 지시서에 해소 결정이 들어간다. 조사는 원래 AC를 유지한 채 계획을 고치고 summary에 결정 ID·revision과 바뀐 검사·AC를 적는다. 수집이 새 계획을 동결하고, 이후 구현·독립 QA를 다시 거친다. 새 QA 지시서에는 같은 결정과 바뀐 후속 확인이 들어간다.
4. 독립 QA PASS 뒤(게시 대기·CI 대기)에 해소된 결정은 PASS한 QA 지시서에 없었다. 어댑터는 Lead가 계획 영향을 판정해 기록하기 전에는 게시·PR 연결·예외 종결·병합하지 않는다. 계획을 바꾸면 결정 ID·revision·변경 근거와 함께 QA 판정·게시 허가를 철회하고 재조사로 되돌린다. 바꾸지 않으면 같은 결정 ID·revision에 판정 근거를 남기고 게시를 이어 간다. 이미 병합된 PR의 증명은 막지 않는다. 철회는 병합 증명에 필요한 QA·게시 anchor·delivery를 지우므로, 연결된 PR이 있으면 철회 전에 PR을 조회한다. 서버에서 이미 MERGED이거나 조회 실패·다른 PR·상태 없음으로 확정할 수 없으면 재조사를 거부하고 대장을 그대로 둔다. 이때는 병합 증명(HH `flow-prove-merged`)으로 업무를 마치고 결정은 후속 업무로 다룬다. HH 명령은 [자체 운영 지침](.agents/harness/LEAD.md#해소-결정이-동결-계획과-충돌할-때)에 있다.

### 남는 한계

검사 비용이 고칠 비용보다 커지지 않도록 아래 경계는 기계로 막지 않는다. 해당하면 게시자·Lead가 PR 화면에서 직접 확인한다.

- 후속 확인 문구의 강조·취소선·이스케이프 문자(`*`, `_`, `~`, `\`), 문구 앞의 목록·제목 표식, 표·수식(`$`)·이모지 단축어(`:x:`), 맨 URL·`#123` 자동 링크는 거부하지 않는다. 글을 숨기지 않고 모양만 바꾸며, PR 본문 대조는 렌더링 결과가 아니라 게시자가 옮긴 원문 줄을 비교한다.
- PR 본문 대조는 GitHub 렌더링 전체를 흉내 내지 않는다. 위 «QA와 남은 검증»의 보수적인 목록 줄 판정만 하고, 새 마크다운 특수 사례 처리는 늘리지 않는다.
- 결정 재조사 전 PR 조회는 그 시점 한 번이다. 조회 뒤 철회 사이에 병합되거나 철회 뒤 사람이 GitHub에서 직접 병합하면 대장에 게시 근거가 없어 병합 증명을 자동으로 모을 수 없다. 이 경우 Lead가 PR과 main을 직접 대조해 정리한다. 닫힌(CLOSED) PR은 병합되지 않았으므로 재조사를 허용한다. BLOCKED(`delivery-blocked`) 업무의 재조사는 이 조회를 하지 않는다.

### 하위 호환

- 새 동작의 표지는 `core/workflow.cjs`의 `planScopeVersion === 1` 하나다(runtime의 `features`가 `{planScopeVersion}`을 돌려준다). 어댑터는 표지가 있을 때만 새 freeze·결정 조회·지시서 옵션을 쓴다. 이전 release의 결정함은 모르는 동작을 쓰기 명령으로 받아 거부하므로, 표지 없이 `resolved-for-task`를 부르면 모든 위임이 막힌다.
- 이미 동결된 v2 계획(`criteria`·`checks` ID 배열, `checkScopes` 없음)은 읽기·수집·게시에서 이전과 같다. `checks` 전체가 필수이고 후속 확인은 0건이며 PR 본문을 요구하지 않는다. 새 동결은 `checkScopes`가 없는 계획을 받지 않으므로 새 입력이 이 호환 경로로 우회하지 않는다.
- `options` 없는 3인자 `instructions`는 기존 계획 형식을 안내하고 결정을 넣지 않는다. 새 release가 설치돼도 전환하지 않은 어댑터는 기존 동작을 유지한다.
- 결정 기록의 `resolution.selection`은 추가 필드다. 이전 mod 검증기는 `resolution`의 추가 필드를 거부하지 않는다. 새 검증기는 `selection`이 없는 이전 기록을 받는다.
- `policy/workflow.json`의 `version`은 2 그대로다(mod는 `version === 2`일 때만 단계별 모델을 표시한다).
- 기존 release로 시작한 회차는 그 release로 마친다. 이미 저장한 보고·계획·결정 파일은 다시 쓰지 않는다.

### SW·VDP·VP 전환 안내

새 release로 binding을 전환할 때 저장소마다 아래를 확인한다. 이번 변경은 세 저장소의 코드·binding을 바꾸지 않으며, 전환하지 않은 어댑터는 새 release에서도 위 호환 동작을 유지한다.

1. **runtime 사본 교체**: `adapters/runtime.cjs`가 바뀌었다(`workflow` CLI 라우팅, `instructions`의 `options` 전달, `features`·`freeze`·`remaining`·`pr-remaining`). 세 저장소의 `.agents/harness/runtime.cjs`를 같은 내용으로 교체한다. `test/adapters.integration.mjs`가 내용 동등을 확인한다.
2. **표지 확인**: JS 어댑터는 `require(<release>/core/workflow.cjs).planScopeVersion === 1`, Python 어댑터는 `'{"action":"features","project":"<id>","stateDir":"<상태폴더>"}' | node .agents/harness/runtime.cjs <binding> workflow`로 확인하고, 없으면 아래 단계를 모두 건너뛴다. 이전 runtime CLI는 `workflow` 키가 없어 결정함 bridge로 떨어지므로 1을 먼저 한다.
3. **QA 실행 수단 선언**: 그 저장소의 독립 QA 지시서가 실제로 허용하는 수단만 config에 선언한다. ID 전용 수단 행에 `command`를 쓰던 계획은 새 동결에서 거부되므로 조사 산출물에서 지운다. 예: SW의 QA runner(`target/sw-verify` 영수증) 전용 ID, VDP의 Bun 시험 명령 형식, VP의 pytest 명령 형식. QA 지시서가 브라우저를 금지하면 브라우저 수단을 선언하지 않는다.
4. **동결 교체**: 자체 freeze가 `criteria`·`checks`만 복사하면 `checkScopes`가 조용히 사라진다. research 지시서에 `options.scopes`를 넘기는 시점과 같은 배포에서 자체 freeze를 공통 `freeze`(필수 검사 목록 `required` 포함)로 바꾸고 결과 전체를 저장한다. 둘 중 하나만 바꾸지 않는다.
5. **결정 조회·주입**: 매 단계 위임 전에(run 폴더 생성·대장 변경 전) `resolved-for-task`로 조회하고 결과를 `instructions`의 `options.decisions`로 넘긴다. 조회 실패는 위임을 멈춘다. 해소 기록에 사용자가 고른 label을 `selection`으로 남긴다.
6. **게시**: 게시자 인계에 `remaining`의 `line`과 해소 결정을 넣고, PR 본문 «남은 검증»에 `line`을 HTML·코드 블록보다 앞에 `- [ ] <line>` 목록 줄로 적게 한다. PR 연결 시 `pr-remaining`으로 실제 PR 조회의 `body`를 대조한다. 병합은 공통 delivery가 다시 대조한다. PR 없는 종결 기록에도 남은 검증을 남긴다.
7. **재조사 경로**: 결정 충돌 BLOCKED에서 재조사로 보내는 저장소 명령을 확인한다(HH는 `flow-resume --stage research`). 독립 QA PASS 뒤 해소된 결정은 게시·병합 전에 Lead 판정 기록(재조사 철회 또는 계획 영향 없음)을 요구하고, 철회 시 이전 QA 판정·게시 근거를 지운다(HH는 `flow-resume --decision KEY --revision N`). 연결된 PR이 있으면 철회 전에 조회해 MERGED이거나 확정할 수 없으면 거부하고 병합 증명으로 안내한다. VP의 재조사 전이와 계획 파일 시각 검사는 v-project 저장소의 별도 업무다.

```powershell
'{"action":"freeze","project":"<id>","stateDir":"<상태폴더>","plan":{...},"options":{"executors":{...},"required":["<필수 검사>"]}}' | node .agents/harness/runtime.cjs <상태폴더>/harness-binding.json workflow
'{"action":"remaining","project":"<id>","stateDir":"<상태폴더>","plan":{...}}' | node .agents/harness/runtime.cjs <상태폴더>/harness-binding.json workflow
'{"project":"<id>","stateDir":"<상태폴더>","ledger":{...},"action":"resolved-for-task","task":"<업무 ID>"}' | node .agents/harness/runtime.cjs <상태폴더>/harness-binding.json
```

## QA 실행 영수증과 CI 검증

CI는 최소 필수 검사만 한다. 전체 시험은 개발·독립 QA 단계에서 저장소 정책이 선언한 OS마다 실행하고, 같은 runner가 발급한 QA 실행 영수증(v2)을 PR 본문에 남긴다. PR CI는 PR head에서 후보 지문을 다시 계산해 영수증의 후보·검사 목록과 저장소 정책 파일만 검사한다. 영수증에는 서명이 없다(아래 «남는 한계»).

| 구성 | 파일 | 실행하는 곳 |
|---|---|---|
| 공유 계약(후보 지문·정책·PR 본문 봉투·PR 판정) | `core/qa-receipt-policy.cjs`(`core/dev14.cjs`의 `changes`를 쓴다) | 발급기·CI |
| 발급기 | `core/qa-receipt-runner.mjs`, `bin/qa-receipt.mjs` | 독립 QA·로컬 |
| CI 검증기 | `bin/verify-qa-receipt.mjs` | 저장소 CI(release 없음) |
| 저장소 정책 | HH는 `policy/qa-receipt.json` | 저장소별 |

발급기와 검증기는 release에도 실린다. 저장소 정책 파일은 release에 싣지 않는다(공통 `policy/execution.json` 등과 다르다).

### 저장소 정책

```json
{"version":1,"output":"target/hh-verify/receipts","exempt_pr_max":7,
 "platforms":{"windows":{"runner":"host"},"linux":{"runner":"docker","image":"docker.io/library/node@sha256:69c6e263…"}},
 "checks":{"hh-suite":{"result":"tap","steps":[["node","scripts/build.mjs"],["node","--test","--test-reporter=tap","test/*.test.mjs","mod/harness/*.test.mjs"]]}},
 "required":[{"checks":["hh-suite"],"platforms":["windows","linux"]},
             {"paths":["docs/"],"checks":["docs-check"],"platforms":["windows"]}]}
```

- `platforms`: 대상 OS. `host`는 발급하는 PC의 OS(windows·linux·macos)와 이름이 같을 때만 실행한다. `docker`는 linux만 쓰고 이미지를 `@sha256:` digest로 고정한다. tag는 받지 않는다.
- `checks`: 검사 ID별 `steps`(셸 없이 실행할 argv 배열. 공백·`&`·`|`·`$`·`;`·따옴표 같은 셸 특수문자는 거부한다)와 판정 `result`(`tap`: node --test TAP 끝 요약이 양수 전체 통과이고 fail·cancelled·skipped·todo 0, `exit`: 종료 코드 0).
- `required`: OS×검사 필수 집합. `paths`가 없는 기본 규칙이 하나 이상 있어야 하고 항상 적용한다. `paths`는 정확한 파일 또는 `/`로 끝나는 폴더다. 후보 변경 행(삭제·이동의 원래 경로 포함) 하나라도 걸리면 그 규칙을 적용하고, 걸린 규칙은 합집합이다.
- `output`: 발급 결과를 둘 Git 무시 경로. 무시되지 않으면 발급을 거부한다(추적·미무시 경로에 쓰면 후보 지문이 바뀐다).
- `exempt_pr_max`: 도입 시점에 열려 있던 PR까지의 마지막 PR 번호. 이 번호 이하 PR은 영수증 검사를 면제하고 정책 파일 검사는 그대로 한다. 도입 뒤 늘리지 않는다.

### 후보 지문

영수증의 `base`(QA 기준 커밋 B)와, B에서 QA 후보 tree까지의 `git diff --raw --no-renames` 행(경로, 양쪽 mode·blob, 상태)을 경로 바이트순으로 정렬해 SHA-256한 값이다. 이동은 삭제·추가 두 행이다. 미커밋 후보는 `publishTree`(임시 index에 staged·미커밋·무시되지 않는 신규 파일을 담은 tree)로 계산하므로 같은 tree의 게시 커밋(부모 B)과 지문이 같다.

과정 문서는 B 대비 실제 변경에만 과정 산출물 게시 정책을 적용한다. B에 이미 커밋돼 있고 바뀌지 않은 문서는 행을 만들지 않고, 실제 삭제와 보존 예외의 변경은 그대로 세며, 게시 금지인 신규는 빼고 수정은 B 내용으로 되돌린다(그 문서를 PR에 넣으면 지문 불일치로 거부된다. config에 선언이 없으면 `docs/tasks/`·`docs/projects/`를 과정 문서로 본다).

CI는 같은 행을 `merge-base(실제 main, PR head)`에서 PR head까지 다시 계산한다. strict 갱신·DEV-14 동기화·겹치지 않는 rebase로 독립적인 main 변경이 들어와도 후보 경로의 양쪽 mode·blob은 그대로이므로 유효하다. main이 후보 경로를 바꿨거나 QA 뒤 PR 변경이 달라지면(경로 추가·삭제, 내용·mode 변경) 무효다. B가 PR head의 조상이 아니어도 무효다. CI는 DEV-14 동기화 계보나 최초 게시 커밋을 따로 확인하지 않는다.

### 발급

```powershell
node bin/qa-receipt.mjs [--worktree <checkout>] [--base <B>] [--run <회차 ID>] [--round N] [--heavy <release>/bin/heavy.mjs] [--policy policy/qa-receipt.json]
```

- 기본값: `--base`는 `origin/main`과 HEAD의 merge-base, `--run`은 `local-<UUID>`, `--heavy`는 같은 폴더의 `heavy.mjs`다. 종료 코드는 0=PASS, 1=FAIL(검사 실패), 3=BLOCKED(환경 준비 실패), 2=입력 오류다.
- 정책의 필수 OS×검사를 정책 선언 순서대로 하나씩 실행한다. 검사마다 공용 heavy 슬롯을 한 번 잡고, 컨테이너 안에서 슬롯을 다시 잡지 않는다. 앞 검사가 FAIL·BLOCKED면 뒤 검사는 실행하지 않는다.
- 호스트 검사는 후보 checkout에서 `heavy.mjs -- <steps를 &&로 이은 명령>`을 실행한다. 시험 worker 표지 `NODE_TEST_CONTEXT`는 넘기지 않는다.
- Docker Linux 검사는 Docker 엔진(`docker version`의 Server OS가 linux)과 digest 이미지를 확인하고 없으면 pull한다. 후보 tree를 `git archive`로 꺼내 출력 폴더 아래(업무 worktree의 ASCII 경로)에 두고 `--mount …,readonly`로 붙인다. 컨테이너는 `--init`(고아 손자 프로세스를 거두는 init. 없으면 프로세스 종료 시험이 좀비 때문에 실패한다)과 비root(`node`)로 실행해 /tmp 사본에 풀고, `git add -A -f`·`git write-tree` 결과가 후보 tree와 같을 때만 정책 명령을 셸 없이 실행한다. 작업 사본 파일을 그대로 복사하지 않으므로 줄 끝·실행 비트는 Git 기준이다. 실행 뒤 `docker rm -f`로 남은 컨테이너를 지우고 사본은 보관하지 않는다.
- Docker 없음·엔진 연결 실패, 이미지 pull 실패, 사본 tree 불일치, `docker run` 오류(exit 125~127)는 BLOCKED이며 PASS 영수증을 남기지 않는다. 시험 실패·시간 초과(검사당 45분)는 FAIL이다.
- `output/<회차>/`에 `result.json`(상태·사유·검사별 시간), `<OS>-<검사>.log`를 남기고 PASS일 때만 `receipt.json`과 `envelope.txt`를 쓴다. 같은 회차를 다시 시작하면 이전 결과부터 지운다. 검사 도중 후보 tree가 바뀌면 BLOCKED다.
- 영수증 필드: `kind`·`version: 2`, `run`·`round`(QA 회차), `runner`(id·version), `release`(heavy가 든 설치 release 지문. 저장소 checkout의 heavy면 null), `base`, `candidate`(digest·count), `tree`, 시작·완료 시각, `environments`(OS별 os·release·arch·node·git. Docker는 distro·image·사본 준비 시간), `results`(OS·검사·steps·state·exit·tests/pass/fail/cancelled/skipped/todo·시간·로그 SHA-256). 로컬 경로·로그 원문·환경변수 값은 담지 않는다.

### PR 전달

`envelope.txt`의 한 줄(`<!-- herdr-qa-receipt:v2 <base64url JSON> -->`)을 PR 본문 «남은 검증» 목록 뒤에 줄 맨 앞부터 그대로 넣는다. 한 줄에서 닫히는 HTML 주석이라 PR 화면에 보이지 않고 «남은 검증» 판정을 바꾸지 않는다. 영수증은 커밋하지 않으므로 과정 문서 커밋 금지와 충돌하지 않는다. 본문에는 한 줄만 둔다.

### CI 검증

- workflow는 `pull_request`의 opened·synchronize·reopened·edited에서 `actions/checkout`(`fetch-depth: 0`) 뒤 `node bin/verify-qa-receipt.mjs` 하나만 실행한다. 본문만 고쳐도 다시 검사한다.
- 이벤트 payload(`GITHUB_EVENT_PATH`)의 PR 번호·head·본문과 checkout의 정책 파일·Git 객체만 읽는다. release·Docker·네트워크·전체 시험이 필요 없다. 비교할 main은 checkout한 merge 커밋의 첫 부모(둘째 부모가 PR head일 때), 아니면 `origin/<base.ref>`, 마지막으로 payload `base.sha`다. `--main`으로 지정할 수도 있다.
- 정책 파일을 먼저 검사한다. PR 번호가 `exempt_pr_max` 이하이면 면제로 통과한다. 그 밖에는 봉투 해독, B가 head의 조상인지, 지문·행 수 일치, 필수 OS×검사가 정확히 한 번 정책 명령으로 통과했는지(양수 시험 수·실패 0), OS별 환경 기록(Docker는 정책 image와 같음)을 확인한다. 실패하면 사유와 재발급 안내를 출력하고 exit 1이다.
- 영수증이 없거나 무효인 PR은 실패로 끝난다. 전체 시험으로 돌아가는 폴백은 없다.

### 하네스 밖 PR

하네스를 거치지 않은 PR도 같은 runner를 로컬에서 실행해 영수증을 받는다. 커밋한 PR 브랜치 checkout에서 `node bin/qa-receipt.mjs`(다른 저장소는 `node <release>/bin/qa-receipt.mjs --policy <정책 파일>`)를 실행하고, PASS면 `envelope.txt` 줄을 PR 본문에 넣는다. FAIL·BLOCKED면 원인을 고친 뒤 같은 명령을 다시 실행한다. 커밋을 더하면 다시 발급해 본문의 줄을 바꾼다.

### 사후 검사

main push·nightly 사후 검사는 공통 규칙으로 두지 않는다. 기존 HH CI의 main push 전체 시험도 없앴다. 독립 main 변경과 결합해 생긴 문제는 발견했을 때 수정 PR로 고치는 것을 기본 운영으로 한다.

### OS별 시험 시간

정책 OS마다 전체 suite를 한 번씩 순서대로 실행하므로 독립 QA 시간은 대략 «OS별 suite 시간의 합 + 이미지 준비 + 슬롯 대기»다. 결과의 `phases`에 검사별 전체 시간(`ms`, 슬롯 대기 포함), TAP 시험 시간(`testMs`), Docker 이미지 확인·pull(`imageMs`)과 컨테이너 사본 준비(`prepMs`)가 남는다. 첫 Linux 실행은 이미지 pull(이 PC 약 1.1GB)이 더해진다.

### 남는 한계

검사 비용이 고칠 비용보다 커지지 않도록 아래는 막지 않는다.

- 서명이 없어 누구나 봉투를 만들 수 있다. 지문은 후보와 결과의 대응·누락만 확인하고 발급자를 인증하지 않는다.
- PR이 정책·검증기·workflow를 바꾸면 CI는 바뀐 내용(merge checkout)으로 검사한다.
- 독립 main 변경과 후보의 의미적 상호작용은 다시 검사하지 않는다. main이 정책 파일을 바꾸면 열린 PR은 새 정책으로 판정되므로 명령·필수 집합이 달라졌으면 다시 발급한다.
- Docker Linux 이미지(Debian bookworm, git 2.39)는 GitHub ubuntu 이미지와 같지 않다. Windows는 호스트 Node·Git을 그대로 쓰고 버전은 기록만 한다(engines `>=22`).
- `git archive`는 `.gitattributes`의 `export-ignore`·`export-subst`를 적용하고, 컨테이너의 `git add`는 `eol` 속성으로 CRLF blob을 정규화한다. 이런 파일이 있으면 사본 tree가 달라 BLOCKED가 된다.
- fork PR ref, 같은 head에 남은 이전 실패 check run, 이벤트 순서, 같은 회차 동시 발급은 따로 막지 않는다. 같은 head에 실패 결과가 먼저 남지 않도록 봉투를 넣은 본문으로 PR을 만든다.
- 과정 문서 경로(`docs/tasks`, `docs/projects`)는 QA 후보에서 빠진다. 이 경로를 PR에 커밋하면 지문이 달라 실패한다.

### 저장소 전환 안내

SW·VDP·VP는 병합 뒤 저장소별 업무와 사용자 확인으로 전환한다. 이번 변경은 세 저장소의 CI·코드·ruleset·strict 설정과 binding을 바꾸지 않는다.

1. **정책 파일**: 저장소에 정책 파일 위치를 정해(예: `policy/qa-receipt.json` 또는 `.agents/harness/qa-receipt.json`) 대상 OS·검사·필수 규칙·`output`(Git 무시 경로, 예: SW `target/sw-verify/receipts`)을 선언한다. `exempt_pr_max`는 도입 PR을 병합하기 직전의 마지막 PR 번호로 정한다.
2. **검증기 복사**: `bin/verify-qa-receipt.mjs`, `core/qa-receipt-policy.cjs`, `core/dev14.cjs`를 같은 상대 위치로 복사한다. Node 내장 모듈과 git만 쓴다. 정책 위치가 기본값과 다르면 `--policy`를 준다.
3. **CI**: 기존 필수 check 이름을 그대로 둔 job에서 `fetch-depth: 0` checkout 뒤 검증기만 실행하고 `pull_request` types에 `edited`를 더한다. 경로 필터·job skip으로 필수 이름이 사라지지 않게 한다. 제거·QA 이관할 기존 검사의 분류는 저장소별 업무에서 정한다.
4. **QA runner**: 독립 QA 명령이 `node <release>/bin/qa-receipt.mjs --worktree <업무 worktree> --base <업무 base> --run <QA token> --round <회차> --policy <정책>`을 실행하거나 HH의 verify.mjs처럼 `issueReceipt`를 직접 부르게 하고, 게시자에게 envelope 줄을 넘긴다. Docker Linux를 선언하면 QA PC에 Docker가 있어야 한다.
5. **하네스 밖 PR 안내**: 저장소 PR 템플릿·기여 안내에 로컬 발급 명령과 본문 위치를 적는다.

## 단계 수집 판정

`hc` 상태 `done`은 에이전트가 한 턴을 끝냈다는 뜻일 뿐, 단계가 끝났다는 뜻이 아니다. 백그라운드 셸(장시간 측정·시험)을 남긴 채 턴을 끝낸 에이전트는 그 셸이 끝나면 다시 깨어나 산출물과 receipt를 쓴다.

- **수집 판정**: 단계 산출물과 receipt가 둘 다 없고 에이전트 터미널이 살아 있으면(`live`), collect는 실행 실패(`no-result`)로 닫지 않는다. "아직 작업 중"으로 알리고 run을 열어 둔다. 터미널이 사라졌거나, Lead가 화면을 확인하고 `--force`로 수집할 때만 실행 실패로 닫는다. 산출물이 있으면 receipt가 없어도 지금처럼 수집한다(receipt는 선택 항목이다).
- **지시서 규칙**: 구현·QA·조사 지시서에 다음을 둔다. 백그라운드 작업을 남긴 채 턴을 끝내지 않고 끝날 때까지 기다린다. 산출물을 다 쓴 뒤 receipt를 마지막에 쓴다.
- **수집 뒤 터미널 종료**: 자체 어댑터는 산출물을 정상 수집해 회차를 저장한 뒤 그 회차의 위임 터미널을 `hc kill`로 닫는다. 대장에 기록된 그 회차의 주소이고 `harness.task`·`harness.run` 레이블이 같을 때만이다. 에이전트 상태가 아직 `working`이면 산출물이 있어도 닫지 않는다. 위 수집 판정은 그대로이며, 결과는 회차의 `x_terminal.outcome`에 남는다. `killed`는 kill 뒤 다시 조회해 종료(`after: finished`)나 제거(`after: removed`, hc의 not_found)를 확인한 경우다. `absent`·`finished`는 이미 없거나 끝난 터미널, `kept`는 정책상 닫지 않은 경우(사유 포함)다. `still-live`(kill 뒤에도 살아 있음)와 `unknown`(kill 뒤 조회 실패)은 종료로 보고하지 않는다. kill 뒤에도 살아 있으면 Lead가 `hc get`으로 확인한 뒤 다시 닫는다. 살아 있거나 상태를 알 수 없는 위임 터미널은 [worktree 정리](#끝난-업무-worktree-정리)를 막는다. hc가 not_found로 알린 터미널은 없는 것으로 본다.

## 화면 갱신과 대장 용량

상태 폴더 또는 프로젝트 설정 폴더의 변경은 200ms 단위로 묶어 해당 프로젝트만 다시 읽는다. 읽는 중 발생한 변경도 후속 조회로 반영한다. `projects.json`이 있는 mod 폴더 변경은 전체 목록을 다시 읽으며, 감시 실패·누락과 프로젝트 추가·제거를 복구하기 위해 60초마다 전체 조회를 유지한다. 상대 시각은 파일을 읽지 않고 15초마다 갱신한다. 중요한 변화의 전체 이력 병합·정렬은 데이터 갱신 시 한 번만 수행하며, 렌더링과 읽음 처리에서는 계산 결과를 재사용한다.

브리핑은 `ledger.json`의 UTF-8 크기가 1 MiB의 75% 이상이면 용량 주의, 90% 이상이면 읽기 한도 임박을 표시한다. 경고는 화면에 표시하며 업무 상태를 바꾸거나 알림 소리를 반복하지 않는다. 읽기 실패 시에는 마지막 정상 자료와 용량 경고를 보존하고, 크기가 줄어든 정상 대장을 읽으면 경고를 해제한다.

75%부터 해당 프로젝트에서 과거 실행 이력의 분리 보관을 준비하고, 90%부터는 한도를 넘기기 전에 보관 작업을 우선한다.

끝난 업무의 보관 규칙은 [policy/ledger.json](policy/ledger.json)과 `core/ledger-archive.cjs`가 정한다. 대장 쓰기와 잠금은 프로젝트 CLI가 맡고, 공통 mod는 기록을 지우거나 잘라내지 않는다.

- **대상**: DONE·FAILED가 된 지 24시간이 지난 업무다. 다음 업무는 대상에서 뺀다.
  - 최근에 끝난 5건
  - 남은 업무가 의존하는 업무
  - 실행 중인 업무
  - 호출자가 `keep`으로 넘긴 업무: worktree가 남아 게시·정리 전인 업무, [정리](#끝난-업무-worktree-정리)가 끝나지 않은 업무, 미해소 질문이 걸린 업무
- **남기는 것**: 대장에는 화면용 요약만 남긴다.
  - 제목·상태·승인 근거·의존·브랜치 등 정책의 `summary` 필드
  - 마지막 실행(모델·결과)과 마지막 상태 전이
  - `x_archive`: 보관 파일 경로·SHA-256·원래 실행·이력 건수
- **옮기는 것**: 실행 이력·후보 지문·요청 원문 등 원본 전체는 `<state_dir>/archive/tasks/<ID>.json`에 쓴다. 같은 내용의 보관 파일이 있으면 재사용한다. 기존 보관 파일은 덮어쓰지 않는다. FAILED→QUEUED로 다시 연 업무가 다시 끝나 내용이 달라지면 `<ID>.<SHA-256 앞 12자>.json`에 따로 쓰고, `x_archive.file`이 그 파일을 가리킨다.
- **순서**: 보관 파일을 먼저 쓰고 새 대장을 돌려준다. 호출자는 같은 잠금 안에서 그 대장을 원자 저장한다.
- **조회**: `show` 같은 상세 조회는 `restore`로 원본을 읽는다. 지문이 다르면 실패한다.

진입점은 `node .agents/harness/runtime.cjs <binding> ledger`이고, 동작은 `plan`·`archive`·`restore`다. `archived: true`는 목록에서 숨기는 표시일 뿐이라 JSON 크기를 줄이지 않는다.

## 끝난 업무 worktree 정리

DONE 업무의 worktree와 로컬 업무 브랜치는 공통 release의 `core/worktree-cleanup.cjs`가 정리한다. 저장소 CLI는 업무 경로·브랜치 이름, 실행·위임 터미널 조회 결과, 보존·폐기할 무시 파일 목록을 넘기고, 돌려받은 결과를 대장 잠금 안에서 기록한다. 매번 사람이 정리 명령을 내리지 않도록 DONE 전이 직후 호출하는 것이 기본이다. 자체 어댑터의 호출 시점과 재시도는 [자체 v2 운영 지침](.agents/harness/README.md#끝난-업무-정리)에 있다.

진입점은 `node .agents/harness/runtime.cjs <binding> cleanup`이고 동작은 `cleanup` 하나다. binding의 프로젝트·상태 폴더·`cwd`(저장소 루트)가 입력과 같아야 한다. 고정 release manifest에 이 모듈이 없으면 실행하지 않고 «지원하지 않는다»로 실패한다. 새 release를 설치하기 전의 저장소는 이 실패를 받고 DONE은 그대로 둔다.

```powershell
'{"action":"cleanup","project":"<id>","stateDir":"<상태폴더>","task":{"id":"HH-1","state":"DONE","root":"<저장소>","worktreeDir":"<worktree_dir 절대 경로>","worktree":"<업무 worktree>","branch":"<업무 브랜치>","kind":"merged","proof":{"head":"<최종 PR head>","original":"<최초 게시 head>","branch":"<PR 브랜치>"},"activity":{"current":false,"runs":[{"token":"<회차>","status":"ended","address":"t7","state":"finished","run":"<harness.run 레이블>"}]},"ignored":{"keep":["target/hh-verify/"],"discard":["dist/"]},"artifacts":{"config":{...},"vars":{"slug":"x"}},"retry":"<재시도 명령>","limits":{"contentMs":60000}}}' | node .agents/harness/runtime.cjs <상태폴더>/harness-binding.json cleanup
```

정책 예외 종결 업무는 `kind: "closed"`와 `proof` 대신 `candidate: {head, tree, paths}`(QA 후보)를 넘긴다. 사용자 승인 병합 종결 업무(아래 «사용자 승인 병합 종결»)는 `kind: "merged-accepted"`만 넘긴다. 사전검사·보관·비강제 remove는 같고, tip 대조 없이 브랜치는 `git branch -d`만 시도해 거부되면 `branch: {state: "kept", tip, reason}`로 보존한다. `limits.contentMs`(1~3600000, 기본 60000)는 정리 시작부터 추적 파일 내용 확인과 폴더 순회를 끝내야 하는 시간이다.

- **대상**: 병합 증명(`merged`), 정책 예외 종결(`closed`), 사용자 승인 병합 종결(`merged-accepted`)로 DONE이 된 업무의 등록된 linked worktree 하나다. 경로는 호출자가 등록한 `worktreeDir` 바로 아래여야 한다. 폴더 이름은 영문·숫자와 `.`·`_`·`-`·`+`로 이루어진다(SW처럼 브랜치의 `/`를 `+`로 바꾼 `codex+one`·`feat+x` 포함). 경로 구분자와 점만 있는 이름은 거부한다. main checkout, 다른 등록 worktree를 품은 경로, 잠긴 worktree, 대장에 없는 준비 잔재는 대상이 아니다. 준비 시간 초과로 남은 부분 worktree·브랜치는 지금처럼 자동 삭제하지 않는다.
- **순서**: 사전검사 → 과정 문서와 `ignored.keep` 파일 재보관(`artifact-policy`의 `preserve`, `process_artifacts` 선언이 없으면 «선언 없음»으로 기록하고 지정 파일만 보관) → 예외 종결 후보의 patch 보존 → 의도 기록 → 후보 경로만 HEAD로 되돌림 → 폐기 폴더 직접 삭제(아래 «폐기 폴더») → 비강제 `git worktree remove` → 병합 업무의 로컬 브랜치 삭제 → 호출자가 대장에 결과 기록. 보관본은 현재 파일·사본·manifest의 SHA-256이 같을 때만 삭제 근거가 된다.
- **멈춤**: 다음 중 하나라도 해당하면 파일·index·등록·ref를 하나도 바꾸지 않고 `status: "refused"`와 이유·남은 자원·재시도 명령을 돌려준다.
  - 실행 중인 회차, 살아 있는 위임 터미널(회차 레이블이 같거나 없음), 터미널 조회 실패
  - 보존 대상 밖의 변경·미추적 파일, `keep`·`discard` 밖의 무시 파일(예: `.env.local`), 충돌, patch에 담을 수 없는 staged 중간 내용
  - index 플래그(`git ls-files -v`의 소문자 = assume-unchanged, `S` = skip-worktree)가 걸린 경로. 작업 사본이 index와 같아도 거부하고, 이유에 경로별 플래그와 작업 사본≠index·index≠HEAD 여부를 적는다. sparse-checkout worktree도 이 이유로 멈춘다
  - submodule(`.gitmodules`, gitlink, worktree Git 폴더의 `modules`). Git이 비강제 `worktree remove`를 거부하므로 의도 기록 전에 멈춘다
  - status가 작업 사본=index로 본 추적 파일의 실제 내용이 index blob과 다름(아래 «stat 캐시»). 이유에 경로를 적는다. `limits.contentMs` 안에 내용 확인·폴더 순회를 끝내지 못한 경우도 변경 여부를 모르므로 멈춘다
  - worktree 폴더 직접 순회(아래 «폴더 순회»)에서 추적 파일이나 status가 보고해 분류한 항목으로 설명되지 않는 파일, 확인된 추적 링크가 아닌 링크·junction(`keep` 폴더 안, `discard`·`keep` 폴더 자체, 예외 종결 후보 경로 포함. 정리기가 직접 지우는 폐기 폴더 안의 링크는 제외), 최상위 `.git` 파일 외의 `.git` 이름 항목(중첩 저장소, 같은 이름의 폴더·파일)
  - Git이 지우거나 덮어쓸 경로(되돌릴 후보 경로, 지울 과정 문서)나 그 worktree 안 상위 구성요소가 링크·junction이거나, 그 자리의 폴더에 지워도 되는 후보 파일 밖의 항목이 있음(아래 «Git 삭제 직전 확인»)
  - worktree 전용 ref(`refs/worktree/*`, `refs/bisect/*`, `refs/rewritten/*`)와 진행 중인 Git 작업(`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`, `rebase-apply`, `BISECT_LOG`, `sequencer`). 모두 worktree의 Git 폴더에 있어 remove와 함께 사라진다. 이유에 ref 이름과 상태 이름을 적는다
  - `worktreeDir` 밖이거나 링크가 낀 경로, 잠긴·중첩 worktree, 다른 프로세스가 쓰는 worktree(Windows에서 이름 바꾸기 검사)
  - 업무 브랜치 tip이 증명의 `head`·`original`과 다름, 브랜치 이름이 증명의 PR 브랜치와 다름, 브랜치 이름이 없는 옛 증명
  - 예외 종결 worktree가 저장된 QA 후보(HEAD·후보 tree)와 다름
  - Git 조회 실패·시간 초과(호출마다 30초, 내용 확인·폴더 순회는 남은 `limits.contentMs`)·출력 한도 초과
- **status가 숨기는 변경**: 정리는 `git status`가 깨끗하다는 것만 믿지 않는다. 검토한 경우와 처리는 다음과 같다.
  - assume-unchanged·skip-worktree 플래그(`core.ignoreStat`이 자동으로 거는 것 포함): 위 거부 사유로 막는다. 플래그를 풀고(`git update-index --no-assume-unchanged --no-skip-worktree -- <경로>`) 변경을 확인한 뒤 재시도한다.
  - stat 캐시: status는 크기·mtime 같은 stat 정보가 index 기록과 같으면 파일을 읽지 않는다. 같은 길이로 고친 뒤 mtime을 되돌리면(`core.checkStat=minimal`·`core.trustctime=false`이면 더 쉽다) 수정이 보이지 않는다. 정리는 stat을 믿지 않고 사전검사와 `worktree remove` 직전에 두 번, status가 작업 사본=index로 본 추적 파일 전체를 `git hash-object --stdin-paths`(경로 속성에 따른 필터 적용)로 다시 계산해 index blob과 비교한다. 다르면 원래 바이트의 blob도 계산해 둘 다 다를 때만 변경으로 본다. 원래 바이트가 index blob과 같으면 그 바이트가 이미 저장소에 있으므로, 커밋 뒤 속성을 바꿔 생긴 정규화 차이는 거부하지 않는다. 링크 항목(mode 120000)은 링크 대상 문자열로 비교한다. 사전검사에서 걸리면 아무것도 바꾸지 않고 `refused`, 제거 직전에 걸리면 의도 기록 뒤라 `partial`이며 파일·등록·브랜치는 그대로다.
  - 폴더 순회: status 출력에 기대는 사례별 보강 대신 같은 두 시점에 worktree 폴더를 링크를 따라가지 않고(`readdir`의 항목 종류, 모르면 `lstat`) 직접 순회해, 실제 항목 전체가 «추적 파일(내용 확인 통과) + status가 보고하고 `keep`·`discard`·과정 문서·후보로 분류한 항목»으로 설명되는지 대조한다. 설명되지 않는 파일, 확인된 추적 링크가 아닌 링크·junction, 최상위 `.git` 파일 외의 `.git` 이름 항목이 하나라도 있으면 멈춘다. 디스크의 링크·junction은 그 경로의 index mode가 120000이고, status가 그 경로를 보고하지 않으며, 내용 확인이 링크 대상 문자열=index blob을 확인한 경우에만 추적 링크로 설명된 것으로 본다. index mode만으로는 면제하지 않으므로, 예외 종결 후보가 추적 링크 경로를 폴더 junction으로 바꿨으면 그 경로가 후보 경로여도 멈춘다. 후보가 추적 링크의 대상을 바꾼 경우(실제 심볼릭 링크로 꺼내는 `core.symlinks=true`)도 같은 이유로 멈추므로 Lead가 내용을 확인해 처리한다. `discard` 폴더 안도 순회한다(중첩 저장소는 거부, 링크는 아래 «폐기 폴더»에 해당할 때만 허용). 폴더 자체는 내용이 아니므로 빈 폴더는 설명된 것으로 본다. `core.ignorecase`이면 경로를 대소문자 구분 없이 대조하고, 같은 폴더에 이름이 대소문자만 다른 두 번째 항목이 있으면 멈춘다(아래 «대소문자만 다른 이름»). 이 순회로 막는 경우는 다음과 같다.
    - `.git` 이름 항목: Git은 깊이와 무관하게 `.git` 이름 항목을 건너뛴다. 추적 폴더 안에 만든 중첩 저장소(자체 커밋 보유), 추적·미추적 폴더 안의 `.git` 이름 일반 폴더에 든 파일은 status가 비어 있어도 비강제 remove가 지운다.
    - 무시된 폴더 안: `--ignored=matching`은 무시 패턴에 맞는 폴더를 한 항목(`!! dist/`)으로만 보고하고 안을 보지 않는다.
    - 링크·junction: Git for Windows는 junction을 폴더로 보고 비강제 `worktree remove`에서도 따라가 worktree 밖 대상의 파일을 지운다(Git만으로 재현 확인). `discard` 폴더 자체가 junction인 경우와 폐기 폴더 밖의 junction이 여기에 든다. 대상이 worktree 안이어도 거부한다. 폐기 폴더 안의 junction은 Git에 넘기지 않고 정리기가 링크만 지운다(아래 «폐기 폴더»). 후보 되돌리기의 `git checkout <HEAD> -- <경로>`도 그 경로의 junction을 폴더로 보고 안(worktree 밖 대상)을 지운 뒤 링크 파일을 쓴다(Git만으로 재현 확인). `core.symlinks=false` 저장소(Windows 기본)의 추적 링크는 일반 파일로 꺼내지는데, 이 파일을 junction으로 바꾸는 흔한 우회가 이 상태를 만든다. Windows 밖의 심볼릭 링크는 Git이 폴더로 보지 않으므로, 폴더에만 맞는 무시 패턴 `dist/`에 `dist` 이름의 링크가 맞지 않아 `?? dist`(미추적)로 보고되고 폴더 순회 전에 «보존 대상 밖의 항목» 사유로 멈춘다. 이유 문구만 다르고 결과(refused·보존)는 같다.
    - 대소문자만 다른 이름: `core.ignorecase=true` 저장소의 worktree가 대소문자를 구분하는 폴더(Windows에서 `fsutil file setCaseSensitiveInfo`를 켰거나 WSL로 만든 폴더, Windows에서 만든 저장소를 Linux·컨테이너에서 연 경우)에 있으면, 추적 `a.txt` 옆의 미추적 `A.TXT`나 추적 폴더 `sub` 옆의 `SUB/keep.txt`를 Git이 같은 index 경로로 보아 status에 보고하지 않고 비강제 remove가 지운다(Windows·Linux 재현 확인). 폴더 순회는 대소문자를 무시한 같은 경로에 두 번째 항목이 오면 «대소문자만 다른 이름 <경로>(<먼저 본 경로>와 같은 index 경로)» 사유로 멈춘다. `core.ignorecase=false`면 Git이 `?? A.TXT`로 보고하므로 «보존 대상 밖의 항목» 사유로 멈춘다.
  - Git 삭제 직전 확인: 삭제를 Git에 맡기는 경로에는 Git이 따라갈 수 있는 링크를 남기지 않는다. 의도 기록 전과 후보 되돌리기(`git checkout`) 직전에, 되돌릴 후보 경로와 지울 과정 문서 경로의 각 구성요소를 worktree 루트부터 `lstat`으로 본다. 링크·junction이 있거나, 대상 자리의 폴더 안에 후보 경로 밖 항목·링크가 있거나, 상위 구성요소가 후보 경로 밖의 파일이면 멈춘다(후보가 추적 파일을 폴더로, 추적 폴더를 파일로 바꾼 경우는 그 안이 모두 후보 경로라 진행한다). `git worktree remove` 직전에는 worktree 폴더 자체가 링크가 아닌 일반 폴더이고 실제 경로가 처음 확인한 경로와 같은지 본다(안은 바로 앞 폴더 순회가 확인한다). `worktreeDir`와 그 위 경로는 호출자가 등록한 설정이라 이 확인의 대상이 아니다.
  - worktree 전용 ref·진행 중인 작업: `refs/worktree/*`·`refs/bisect/*`·`refs/rewritten/*`만 가리키는 커밋은 remove 뒤 이름을 잃고 prune 대상이 된다. 커밋하지 않은 병합·cherry-pick·revert·rebase·bisect 상태(충돌 해결 중 메시지·todo 목록)도 되살릴 수 없다. 사전검사와 제거 직전에 거부한다. stash는 저장소 공용 ref(`refs/stash`)라 정리 뒤에도 남는다. reflog는 작업 내용으로 보지 않는다(Git의 `worktree remove`·브랜치 삭제와 같다).
  - 내용 확인 비용: 추적 파일 전체를 두 번 읽으므로 추적 파일 크기 합에 비례한다. 로컬 측정에서 추적 파일 12,709개 저장소 한 번이 약 4초였다. 폴더 순회는 항목 수에 비례하며 같은 한도 안에서 잰다. 읽기 전용 측정(2026-11-20, Windows·NTFS)에서 HH worktree(파일 448개) 8ms, SW worktree(파일 30,293개·폴더 4,785개) 1.2초, VDP worktree(파일 60,144개·폴더 9,227개) 2.8초였다. 한도는 `limits.contentMs`로 정하고, 넘으면 위 거부 사유로 멈춘다. DONE 직후 자동 정리는 watch-delivery 한 회(180초) 안에 들어가게 기본 60초를 쓰고, Lead 재시도처럼 시간 제약이 없는 호출은 더 긴 한도를 넘긴다.
  - 폐기 선언의 대조: `ignored.discard`(저장소 config의 `cleanup.discard_ignored`) 항목 중 `/`로 끝나고 중간에 `/`가 없는 이름(`node_modules/`, `dist/`)은 이름 선언이다. 저장소 루트의 그 폴더(안의 개별 무시 파일 포함)에 더해, Git이 통째로 무시된 폴더로 보고한 행(`!! apps/x/node_modules/`)의 마지막 이름이 같으면 어느 깊이든 폐기 폴더로 본다. Git이 그 폴더를 통째로 보고하지 않는 경우(무시 규칙이 루트만 가리켜 `??`로 보고, 안에 추적 파일이 있어 `!! apps/x/node_modules/extra`처럼 파일 단위로 보고)는 넓히지 않고 지금처럼 멈춘다. 중간에 `/`가 있는 폴더 선언(`apps/x/cache/`)은 루트 기준 접두사, 파일 선언(`mod/harness/contract.js`)은 루트 기준 정확 일치 그대로다. HH 자체 config의 `dist/`도 이름 선언이라, 지금은 루트 `dist/`(release 출력)에만 해당하지만 앞으로 중첩 `dist/`가 생기면 함께 폐기한다(`.gitignore`의 `dist/`도 모든 깊이에 맞는다).
  - 폐기 폴더: Git이 통째로 무시된 폴더로 보고하고(`!! node_modules/`) 위 대조로 `discard`에 맞는 폴더는, 안에 추적 경로나 `keep` 대상이 없으면 정리기가 `git worktree remove` 전에 직접 지운다. 안에 `keep` 대상이 있는데 폴더가 통째로 무시돼 보관할 수 없으면 «보존 대상이 든 폐기 폴더» 사유로 멈춘다. `lstat`으로 일반 폴더에만 내려가고, 링크·junction은 링크 자체만 지우므로 링크 대상(worktree 밖 pnpm store 등)의 내용은 지우지 않는다. 그래서 사전검사의 폴더 순회는 이 폴더 안의 링크·junction을 허용한다. 지우기 직전 폴더 경로와 상위 구성요소가 링크·junction으로 바뀌었으면 멈춘다. 지운 뒤 `worktree remove` 직전 순회는 링크 허용 없이 다시 해서 늦게 생긴 링크를 Git에 넘기지 않는다. 의도 기록 뒤라 중간에 실패하면 `partial`이고 재시도가 이어서 지운다.
  - pnpm `node_modules`: 같은 측정에서 SW·VDP worktree에는 `node_modules`의 junction이 각각 1,729개·3,391개 있었다. SW·VDP처럼 pnpm을 쓰는 저장소는 `node_modules/`가 모든 깊이에서 Git 무시 대상인지(`.gitignore`에 앞 `/` 없는 `node_modules/`) 확인하고 config의 `cleanup.discard_ignored`에 `"node_modules/"` 하나를 추가한다(예: `"discard_ignored": ["dist/", "node_modules/"]`). 이 이름 선언 하나로 workspace의 모든 `node_modules`(SW의 루트·`apps/desktop`·`packages/*`·`plugins/*/client` 등)를 처리하므로 패키지·플러그인이 늘어도 경로를 나열하지 않는다. 선언하지 않으면 지금처럼 «보존 대상 밖의 항목»으로 멈추며, 이때는 정리 전에 링크를 따라가지 않는 방법으로 `node_modules`를 지운다.
  - fsmonitor(hook·내장 daemon): 이벤트를 놓치면 수정이 status에서 빠진다. 정리의 모든 Git 호출은 `-c core.fsmonitor=false`로 실제 파일을 조회하고 hook을 실행하지 않는다.
  - untracked cache: 폴더 수정 시각을 믿고 새 파일을 놓칠 수 있다. `-c core.untrackedCache=false`로 끈다.
  - 상위 프로세스의 `GIT_DIR`·`GIT_WORK_TREE`·`GIT_INDEX_FILE` 등 저장소·index 위치 환경변수: 다른 index와 비교하면 변경이 보이지 않으므로 Git 호출 전에 지운다. 조회는 `--no-optional-locks`로 index를 고쳐 쓰지 않는다.
  - `status.showUntrackedFiles=no`·무시 규칙: `--untracked-files=all --ignored=matching`으로 덮어써 모두 열거한다. submodule의 `ignore` 설정: submodule 자체를 거부한다.
  - 남는 한계: 아래는 정리가 막지 않고 지울 수 있거나 확인하지 않는 경우다. 해당하는 저장소는 정리 전에 직접 확인한다.
    - 줄 끝 변환·clean 필터 정규화: `core.autocrlf`·`text` 속성이나 clean 필터가 index blob과 같은 내용으로 정규화하는 바이트 차이(예: 작업 사본만 CRLF)는 Git이 변경으로 보지 않으므로 필터 적용 해시도 같아 정리 뒤 남지 않는다. 그런 필터를 쓰는 저장소는 정리 전에 원본 바이트를 따로 확인한다.
    - NTFS 대체 데이터 스트림(예: `a.txt:note`): Git과 폴더 순회 모두 보지 못해 파일과 함께 지워진다. 스트림에 내용을 두는 도구를 쓰는 worktree는 정리 전에 `Get-Item <경로> -Stream *`로 확인해 옮긴다.
    - `worktreeDir`와 그 위 경로의 링크: 호출자가 등록한 설정으로 신뢰하고 링크·junction 여부를 확인하지 않는다. 확인하는 것은 worktree 폴더 자체부터 그 안이다.
    - reflog: 작업 내용으로 보지 않으므로 worktree의 HEAD reflog는 `worktree remove`와 함께 사라진다(Git의 기본 동작과 같다).
- **patch**: 예외 종결처럼 커밋되지 않은 후보는 HEAD와 후보 경로만 담은 임시 index tree 사이의 tree diff(`--binary --full-index --no-renames`)로 `<state_dir>/tasks/<ID>/worktree-<후보 tree 앞 12자>.patch`에 쓴다. 기준 HEAD로 만든 별도 index에 적용한 tree가 후보 tree와 같을 때만 보존으로 인정하고 SHA-256을 기록한다. 바이트가 아니라 Git tree로 비교하므로 줄 끝 변환 차이를 변경으로 오인하지 않는다. 복원은 기준 HEAD checkout에서 `git apply --binary <patch>`로 하고, 먼저 파일 SHA-256을 결과의 `patch.sha256`과 대조한다.
- **브랜치**: 병합 증명된 업무만 지운다. 먼저 `git branch -d -- <업무 브랜치>`를 시도한다. upstream이 없거나 squash 병합이라 거부되면 tip이 증명된 `head` 또는 `original`과 정확히 같고, 이름이 증명의 PR 브랜치와 같고, 다른 checkout이 쓰지 않고, worktree 제거가 끝났는지 다시 확인한 뒤에만 `git branch -D -- <업무 브랜치>`를 쓴다. 지운 tip과 방법(`-d`/`-D`)을 남기므로 `git branch <이름> <tip>`으로 되살릴 수 있다. DEV-14 동기화는 원격에만 push하므로 로컬 tip이 최초 게시 anchor(`original`)인 것이 정상이다. 예외 종결 업무의 브랜치는 보존한다. update-ref 직접 조작, 원격 ref 변경, 강제 worktree 제거, 링크를 따라가는 재귀 삭제는 쓰지 않는다(폐기 폴더는 위 «폐기 폴더»의 `lstat` 삭제만 한다).
- **재시도·멱등**: 첫 되돌리기·삭제 전에 경로·브랜치·예상 tip·보관·patch를 `<state_dir>/tasks/<ID>/cleanup.json`에 남긴다. 그 뒤 실패하면 `status: "partial"`이다. 재실행은 이 기록이 있는 같은 경로에서만 수렴시킨다. 등록만 남고 폴더가 없으면 비강제 remove로 등록을 해제한다. 등록 없이 폴더 골격만 남으면(Windows에서 사용 중 제거가 일부만 된 경우) 파일·링크가 하나도 없을 때만 아래부터 비재귀로 지운다. 파일이 있으면 목록을 보고하고 멈춘다. 재시도가 보존 대상을 다시 보관하면 기록(`cleanup.json`·결과·`x_cleanup`)의 `preserved.files`는 이전 지문 위에 이번 지문을 덮는다. 첫 실행에서 지운 과정 문서의 지문은 남고, 그 사이 바뀐 파일은 보관본·manifest와 같은 새 지문이 된다. 끝난 입력을 다시 주면 같은 결과를 돌려주고 새 삭제·patch 덮어쓰기가 없다. 정리한 경로에 새 worktree가 생겼거나 지운 브랜치가 다시 생기면 같은 업무의 정리로 보지 않는다.
- **결과와 보관**: `{status: done|refused|partial, worktree, branch, preserved, patch, reasons, remaining, retry, journal}`이다. 호출자는 이를 업무의 `x_cleanup`에 기록한다. `archive-tasks`는 worktree가 남았거나 `x_cleanup.status`가 done이 아닌 업무를 keep으로 붙잡고, 정리가 끝나면 풀어 준다.

## 사용자 결정 게시·종결

QA가 FAIL·CONDITIONAL PASS·BLOCKED로 끝나 BLOCKED가 된 업무를 사용자 결정으로 게시·병합하는 경로다. 규칙은 `core/decision-closure.cjs`가 정하고, 대장 잠금·저장·사건 append는 프로젝트 CLI가 맡는다. 진입점은 `node .agents/harness/runtime.cjs <binding> closure`이고 동작은 셋이다.

| 동작 | 입력 | 결과 |
|---|---|---|
| `authorize` | `task`, `evidence: {quote, source, qa_round, qa_reason}` | 상태는 그대로 두고 `x_decision_publish`를 기록한 업무와 `x_decision_publish` 사건 |
| `gate` | `task` | publish-check 판정 `{allowed, kind, reason?}` |
| `close` | `task`, `cwd`(저장소 절대 경로), `evidence: {pr, merge_sha, quote?, source?, qa_round?, qa_reason?}` | BLOCKED→DONE 업무(`x_closure`)와 `state` 사건 |

- **근거**: 사용자 결정 원문 `quote`와 출처 `source`, 예외 처리한 QA 회차 `qa_round`와 사유 `qa_reason`이 필요하다. 회차는 끝난 QA 실행이어야 하고 PASS 회차는 거부한다. `close`는 지금 막힘에서 남긴 `x_decision_publish`가 있으면 결정 근거를 이어받는다.
- **병합 확인**: `close`는 release 쪽에서 `gh pr view <pr> --json number,state,mergeCommit,mergedAt,url,headRefName`을 직접 실행한다. `MERGED`가 아니거나 merge SHA·업무 브랜치가 다르면 종결하지 않는다. 호출자가 조회 결과를 넘겨 근거를 대신할 수 없다. 시험에서는 `HERDR_HARNESS_GH`(JSON 배열)로 gh 대신 실행할 명령을 준다.
- **게시 판정**: BLOCKED 업무는 지금 막힘(마지막 →BLOCKED 전이) 이후 남긴 사용자 결정 기록이 있을 때만 `gate`가 허용한다. 이전 막힘의 결정은 인정하지 않는다. DONE과 다른 상태는 이 규칙의 판정 대상이 아니다.
- **표지**: 종결한 업무는 `x_closure: {kind: "user-decision", at, by, quote, source, qa_round, qa_outcome, qa_reason, decided_at, pr, url, merge_sha, merged_at}`를 갖고, 마지막 history와 사건에 `x_closure`를 붙인다. QA PASS DONE에는 `x_closure`가 없다. 보관 요약도 `x_closure`를 남긴다.
- **화면**: mod는 이 업무를 «결정 종결»로 표시하고 결정함에서 뺀다. 중요한 변화에는 «사용자 결정 종결»로, 상세에는 QA 회차·PR·merge SHA와 결정 원문을 보인다.
- **보관·의존**: 상태가 DONE이라 `archive-tasks` 대상이고, 이 업무를 `depends`로 가진 업무는 선행 조건을 충족한 것으로 본다.

### 계약 v1 호환

- 상태·전이표를 바꾸지 않는다. 공통 전이표(`core/contract.js`)는 이미 BLOCKED→DONE을 허용한다. 계약 문서 표의 BLOCKED 행 «`resume_state` 또는 사람이 지정한 상태»에도 들어간다. 프로젝트 CLI 전이표가 더 좁으면 이 경로에서만 BLOCKED→DONE을 허용한다.
- 새 값은 계약 §4가 허용한 `x_` 필드와 `x_` 사건 이름으로만 추가한다. 대장 `version`은 1 그대로이며 `x_`를 모르는 화면·CLI도 읽을 수 있다.
- 알려진 한계: `x_closure`를 모르는 화면은 이 업무를 QA 통과 DONE으로 보인다. 계약 §1 «DONE은 로컬 독립 QA 통과다»의 예외이므로 각 저장소 GATES.md에 이 경로를 적는다. 다음 계약 버전에서 DONE 의미 문장을 함께 고친다.

## 사용자 승인 병합 종결

PR이 이미 main에 병합됐지만 병합 증명(`flow-prove-merged`)이 막힌 v2 업무를 사용자 승인으로 DONE 처리하는 경로다. strict를 끈 저장소나 squash 부모·민감 경로·최초 게시 기록 문제로 증명할 수 없는 정상 병합을 닫을 때 쓴다. 판정은 공통 release의 `core/merged-closure.cjs`가 하고, Lead 인증·대장 잠금·저장·정리는 각 어댑터가 맡는다.

- **명령(HH)**: `node .agents/harness/launch.mjs flow-accept-merged <ID> --pr <N> --evidence "<사용자 승인 원문>" --source "<원문 출처>"`. 현재 대장의 살아 있는 Lead만 실행한다. 기록하는 터미널은 옵션이 아니라 Lead로 확인한 호출자다.
- **확인하는 것**: release가 binding 저장소(`cwd`)에서 직접 조회한다. origin 설정 URL의 GitHub 저장소로 `gh pr view <N> --repo github.com/<owner>/<repo>`(호스트 포함, `GH_HOST`와 무관)를 실행해 번호 일치·`state=MERGED`·병합 커밋 SHA를 보고, `git ls-remote origin refs/heads/main`으로 읽은 현재 원격 main을 가져와 `git merge-base --is-ancestor <병합 커밋> <main>`이 성공해야 한다. 낡은 로컬 `origin/main`이나 호출자가 넘긴 PR 결과는 근거가 아니다. PR head 브랜치는 업무 브랜치와 같아야 하며, Lead가 PR 번호를 직접 지정(`explicit: true`, HH 명령은 항상 지정)하면 달라도 받는다.
- **확인하지 않는 것**: strict 보호, QA 후보 지문, squash 부모, 민감 경로, QA PASS 여부, 최초 게시 기록(`flow-attach-pr`).
- **거부**: 미병합(OPEN·CLOSED)·다른 번호·SHA 없음·gh 조회 실패, 현재 main에 없는 병합 커밋, GitHub가 아닌 origin, Lead 아님, 원문·출처 누락, 이미 DONE(기존 종결 근거를 덮어쓰지 않는다), v2가 아닌 업무. 거부하면 대장·사건·worktree를 바꾸지 않는다.
- **대상**: DONE이 아닌 모든 v2 업무(BLOCKED, QA 게시·CI 대기, repair, 진행 중 회차가 있는 상태 포함). 진행 중 회차는 `status: ended, outcome: closed`로 끝내고 `current`를 비워 늦은 수집이 DONE을 바꾸지 못하게 한다.
- **기록**: `state=DONE`, `pending·awaiting=null`, `x_flow.phase=closed`, `x_flow.closure={kind: "merged-accepted", pr, url, merge, main, branch, explicit, at, terminal, evidence: {quote, source}, previousState, previousPhase}`, 마지막 history `{from: 이전 상태, to: DONE, why, closure}`, 사건 `x_flow`(`closure: merged-accepted`, `pr`, `merge`). 기존 QA·게시·증명 실패 기록은 감사 근거로 남긴다. 병합 증명(`phase=merged`, `delivery.merge`)·정책 예외(`closure.kind=policy-exception`)와 구분된다.
- **정리**: 종결 직후 같은 잠금에서 기존 worktree 정리를 `kind: "merged-accepted"`로 부른다. 병합 증명이 없으므로 브랜치는 `-d`만 시도하고 거부되면 보존한다. 정리 실패는 DONE을 되돌리지 않고 `x_cleanup`에 사유와 재시도 명령(`cleanup-worktree <ID>`)을 남긴다.
- **SW·VDP·VP 연결**: 각 어댑터는 Lead 명령을 하나 두고, Lead 잠금 안에서 고정 release의 workflow 진입점을 부른 뒤 돌려받은 `task`를 대장에 저장하고 `event`를 append한 다음 기존 정리를 `kind: "merged-accepted"`로 호출한다. `pr`을 생략하면 연결된 `x_flow.delivery.pr`을 쓰고 브랜치 대조를 면제하지 않는다. 고정 release manifest에 모듈이 없으면 «지원하지 않는다»로 실패하므로 새 release 설치 뒤 쓴다.

```powershell
'{"action":"accept-merged","project":"<id>","stateDir":"<상태폴더>","task":{...업무 원본...},"pr":1131,"explicit":true,"evidence":{"quote":"병합된 블록 정리해","source":"Lead 대화 2026-11-21"},"terminal":"<Lead 터미널>"}' | node .agents/harness/runtime.cjs <상태폴더>/harness-binding.json workflow
```

- **계약 v1**: 공통 전이표를 넓히지 않는다. QA·BLOCKED가 아닌 상태(예: READY_TO_IMPLEMENT)에서의 DONE은 이 판정이 직접 기록하며 history의 `closure`로 일반 전이와 구분한다. `x_flow.closure`를 모르는 화면은 이 업무를 일반 DONE으로 보인다.

## 다음 계약 버전 후보

`CONTRACT.md`(계약 v1)는 세 저장소가 바이트 단위로 같고 대장 버전과 묶여 있다. 아래는 바로 바꾸지 않고, 다음 계약 버전을 올릴 때 함께 반영할 후보다.

### QA 실행 환경 차단 시 대체 QA와 사람 수용 경로

- **배경**: 2026-11-10 SW-0060에서 일어났다.
  - Codex QA r2·r3가 실행 환경 문제로 BLOCKED가 됐다. Windows Codex sandbox에서 자식 프로세스 EPERM, Herdr pipe 접근 거부가 났다.
  - 사용자 결정으로 Claude 독립 QA r4를 돌렸고, CONDITIONAL PASS(Low 2)를 사용자가 받아들여 병합했다.
  - 계약 v1에서 DONE은 QA `PASS` 수집으로만 들어간다. BLOCKED에서 DONE으로 가는 전이도 없다. 그래서 업무는 BLOCKED로 남았다.
  - 그 업무에 의존하던 SW-0061·0062는 dispatch할 수 없었다. 결국 `fail`로 닫고 새 ID로 다시 등록했다.
- **정할 것**:
  - 실행 환경 차단을 결함 판정과 구분하는 QA 결과 코드. 예: `BLOCKED`에 `awaiting: qa-environment`를 붙인다.
  - QA를 다른 CLI·모델로 바꿔 다시 돌릴 때의 기록 방식. 원래 단계 정책과의 차이, 사유, 사용자 결정 quote를 남긴다.
  - 사람이 CONDITIONAL PASS를 받아들일 때의 종료 상태. 두 가지 안이 있다.
    - DONE으로 보내되 `approval`처럼 `{by: "user", quote, report}` 근거를 남긴다.
    - DONE과 구분되는 종료 상태를 따로 둔다.
  - 의존 업무의 `depends` 판정이 위 종료 상태를 충족으로 볼지 여부. 이미 등록된 업무의 `depends`를 사람이 사유와 함께 바꾸는 명령이 필요한지도 함께 정한다.
- **지금 처리 기준**(계약 v1): 사람이 받아들여 병합한 업무는 [사용자 결정 게시·종결](#사용자-결정-게시종결) 경로로 DONE(`x_closure`)으로 닫는다. 의존 업무는 그대로 진행한다. 남은 후보는 실행 환경 차단 결과 코드, 대체 QA 기록 방식, 계약 §1 DONE 의미 문장이다.

#### 2026-11-18 사례에서 보강할 후보

| 독립 QA 근거 | 다음 계약에서 기록할 후보 |
|---|---|
| SW-0112 QA r1은 전용 Cargo target의 객체 파일 삭제에서 Windows 오류 32를 관측했다. 잠금 주체는 미확정이었고 Rust 전체·PG·desktop native 검증이 남았다. | 잠금·파일 접근 오류, 확인한 실행 환경, 잠금 주체 확인 여부, 통과한 검사와 남은 검사를 각각 기록한다. 환경 복구 후 같은 후보의 미완료 검사를 다시 연결할 수 있게 한다. |
| VDP-050 QA r1의 Bun은 1.3.5, manifest 요구는 1.3.13이었다. focused 시험에서 timeout이 났고 단독 재호출의 종료 코드·출력은 보존되지 않았다. | 요구·실제 도구 버전, 관측한 오류, 확인되지 않은 원인, 수집하지 못한 증거를 구분한다. 환경 변경과 재위임 결정을 원래 QA 회차에 연결한다. |
| VDP-051 QA r1은 focused 시험 70건을 통과했다. Bun 버전·루트 의존성과 기존 시험의 외부 fixture 정리 문제가 함께 남아 필수 51개 검사를 실행하지 않았고 후보 QA 영수증도 없었다. | 한 업무에 복수 차단 사유와 해소 담당을 담고, 부분 결과·필수 게이트·영수증 유무를 따로 남긴다. |

대체 QA를 허용할지와 결과 코드는 사용자 결정 사항이다. 허용할 경우의 기록 후보에는 원래 회차·기준 SHA·후보 지문, 대체 실행자와 환경, 변경 사유·승인 근거, 실행 명령·종료 코드·영수증 및 미검증 범위가 있다. 후보가 바뀌면 새 지문에 대한 검증으로 연결한다.
