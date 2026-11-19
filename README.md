# Herdr Harness

## 작업 흐름 v2 — smart-workspace 파일럿

기존 대장은 그대로 두고 `add --workflow v2 --kind bug-fix|feature|ui|performance|refactor --authorization <사용자의 자동 게시·병합 지시>`로 만든 업무만 새 흐름을 따른다. 모델 선택·작업별 절차는 `policy/workflow.json`, 실패 분류·진행 판정은 `core/workflow.cjs`가 정본이다. Herdr의 기존 단계는 호환 표시이며 `x_flow.phase`가 게시·CI·복구 진행을 구분한다.

- 조사에서 `verification-plan.json`의 AC·필수 검사 ID를 동결하고 구현자는 실패 검사부터 짧게 확인한다. 고위험 업무는 기존 설계 검토를 유지한다.
- QA는 독립 세션에서 원래 AC를 확인하고 `verification.json`에 후보 지문·AC·검사·원인별 결함을 기록한다. PASS는 현재 후보의 `target/sw-verify/latest-qa.json` 실행 증거도 있어야 한다. QA PASS는 업무 DONE이 아니라 게시 대기다.
- 원인은 code/environment/test/verification/decision으로 나눈다. 코드 결함만 구현 재작업 횟수를 소모한다. 같은 원인이 두 회차 나오면 진단으로 전환하며 `flow-resume ID --evidence <조건이 달라진 근거>`로만 재개한다. 일반 unblock·force로 진단을 건너뛰지 못한다.
- SW runner의 `--role qa --resume-qa`는 동일한 전체 후보 tree·명령·도구·설치·환경에 대한 QA 기록만 재사용한다. 구현자 기록·실패·DB 등 동적 검사는 재사용하지 않는다. 변경 이후 관련 없는 파일을 임의로 제외하는 부분 캐시는 아직 도입하지 않는다.
- v2 업무가 독립 QA PASS 후 `publish`에 도달하면 Lead는 `node <release>/bin/harness.mjs --binding <binding> publisher-command <ID>`로 게시자의 `worktree`와 `argv`를 조회한다. 같은 업무에 실행 중인 게시자가 없을 때 해당 worktree에서 반환된 인자 배열 그대로 한 세션을 시작하고 저장소 게시자의 PR 모드 지시, QA 후보, 업무별 게시 권한을 전달한다. `publisher-command`는 조회 전용이다. 게시자는 기존 게시 스킬로 커밋 blob과 QA 바이트·경로·Git mode를 대조하고 PR을 만든다. Lead가 `flow-attach-pr ID --pr N`으로 연결한다.
- `flow-deliver ID`는 실제 PR·CI·main·보호 규칙을 조회한다. `--apply`는 조건을 만족하면 squash 병합하고 실제 MERGED·main 포함·부모·tree를 증명한 뒤 DONE으로 만든다. 누락·미실행 필수 CI, 요구되는 리뷰, 미해결 결정, 후보 이동은 병합을 막는다.
- `node <release>/bin/watch-delivery.mjs <binding> <ID> [최대 분]`은 Lead 환경을 상속해 모델 없이 30초마다 CI를 확인한다. 서버 보호는 strict up-to-date와 우회 없는 ruleset 또는 관리자 포함 branch protection을 요구한다. 실패·환경 대기·main 이동은 반환하고 Lead가 필요한 부분만 복구한다. 강제 병합·main 직접 push·배포는 수행하지 않는다.
- CI 실패·필수 검사 누락·리뷰 조치는 즉시 `delivery-blocked`로 반환한다. `flow-resume --evidence`는 해결된 CI만 다시 확인하고, 코드 수정은 `--stage implement`, 요구사항 변경은 `--stage research`로 보낸다. watcher의 대기 상한 도달은 nonzero이며 완료로 보고하지 않는다.

v2의 조사에는 `gpt-6.2-astra`/high, 설계에는 Fable/high, 구현에는 Opus/high(고위험 xhigh), 독립 QA에는 `gpt-6.2-sol`/high를 사용한다. 세 저장소의 PR 게시자는 Codex `gpt-6-luna`/medium이다. 정책은 다음 위임부터 적용한다. 조사·설계·구현·QA의 30/30/60/45분은 진단 점검 시점이며 재작업 횟수만으로 effort를 올리지 않는다. Lead는 기존 세션 모델을 사용하고, CI 대기와 병합 조건 판정은 스크립트가 수행한다.

완료는 Git 병합 증명을 뜻한다. 운영 버전 통합검증·배포·티켓 전이는 별도 기존 절차를 유지한다. 실제 QA 단축 효과와 자동 병합은 fixture 결과만으로 실측 완료라고 부르지 않는다.

개인 AI 개발 하네스의 단계별 위임 정책, 공통 결정함, 실행 진입점, Herdr mod를 함께 관리한다. 프로젝트의 스킬·산출물 검증·업무 데이터는 각 프로젝트에 남긴다.

Herdr 패널은 모든 저장소와 원격 공간에서 작업 브리핑을 제공한다. 현재 공간의 CLI 활동과 원문 보고를 보여주고 해당 터미널로 이동할 수 있다. `projects.json`에 등록된 로컬 저장소에서는 결정 질문·새 결과·업무 대장·QA 상태를 추가로 보여준다. 하네스가 없는 저장소의 CLI 입력 대기를 승인 질문으로 해석하거나, 연결되지 않은 기능을 0건으로 표시하지 않는다.

v2 업무 카드는 독립 QA 통과 뒤 게시 대기·CI 대기·병합 차단·병합 완료를 구분한다. 카드를 펼치면 대장에 기록된 최근 검증 판정, PR 번호, 병합 커밋을 확인할 수 있다. v1 업무의 완료 표시는 로컬 QA 기준을 따른다.

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

rollback은 직전 소스·binding을 복원한다. 설치 이후 수동 변경이 있으면 덮어쓰지 않고 거부한다. 새 질문이나 사용자 설정은 되돌리지 않는다. 로컬 백업에는 이전 개인 파일 내용이 있으므로 store를 Git에 넣지 않는다.

### 작업 폴더 준비와 실행 한도

`prepare`, `dispatch`, `next --go`는 공통 런처에서 PC 전체의 준비 슬롯 하나를 사용한다. 여러 저장소의 `git worktree add`가 동시에 디스크를 점유해 준비 중 시간 초과가 나는 일을 줄이기 위한 장치다. 현재는 worktree 생성·의존성 설치·위임을 포함한 CLI 한 호출을 직렬화하며, 이미 실행 중인 에이전트는 영향을 받지 않는다. `whoami`, `show`, `next`의 안내, 질문·결정 조회 등은 슬롯을 잡지 않는다. 전체 시험·빌드의 `heavy` 2개 슬롯과 별도다.

- 순서 대기 후에 실행 한도(binding `timeout`, 기본 600000ms)를 시작한다. 느린 저장소는 설치 계획에 `timeout: 1800000`처럼 지정한다. stderr에 대기 시간·준비 시작·실행 시간이 따로 나오며, stdout의 기존 JSON은 유지한다.
- 한도를 넘기면 하위 프로세스까지 종료하고 124, 취소하면 하위 프로세스 종료 확인 뒤 130을 반환한다. 종료 전에는 슬롯을 반환하지 않는다. 대기 중 binding이 바뀌면 실행하지 않고 새 launcher 사용을 요구한다.
- `node <release>/bin/harness.mjs --binding <file> preparation-status`로 점유 PID·프로젝트·시각을 읽는다. 기본 잠금은 `%LOCALAPPDATA%/HerdrHarness/preparation/active.json`이며 시험 격리에만 `HERDR_PREPARATION_DIR`를 쓴다.
- 강제 종료로 남은 잠금은 시간만 보고 지우지 않는다. 죽은 소유자면 실패로 알리며, 소유 프로세스와 하위 Git까지 종료됐음을 확인한 뒤 해당 잠금만 복구한다. 부분 worktree·브랜치는 자동 삭제하지 않는다.
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

«내 결정·확인»에는 등록된 미해결 질문과 업무 대장의 막힘을 표시한다. 결정 필드 없이 사유가 `중단: 사용자 요청`인 업무는 «사용자 요청으로 중단» 영역으로 분리하며 결정 건수에서 뺀다. Lead의 일반 상태 메시지는 프로젝트 카드에 한 줄로 표시하며, 보고 건수로 세거나 이전 응답을 계속 남기지 않는다. 실제 답변·승인이 필요한 내용은 결정함에 질문으로 등록한다.

등록된 질문이 없는 막힘과 사용자 요청으로 중단된 업무에서도 «Lead에게 지시…»를 눌러 자유 입력한 내용을 보낼 수 있다. 선택지를 추측해서 만들지 않으며, 업무 ID·표시 사유·사용자 원문을 현재 Lead에게 전달한다. 전달 후에는 «Lead 처리 대기»로 표시하고, 모드는 승인·결정 해소·재개를 직접 기록하지 않는다. 입력 뒤 업무의 막힘 사유·상태·Lead·현재 저장소가 달라지거나 대장을 갱신하지 못하면 이전 입력을 전송하지 않는다. 전송 실패 시 원문으로 다시 입력할 수 있다.

현재 대장에 등록된 살아 있는 Lead가 `decision request KEY --file 질문.json`으로 먼저 등록한다. 질문은 `question`, `source`, 선택 `task`, `kind`, `options`, `reason`, `recommendation`으로 구성한다. 업무 등록 전에는 `task:null`, DONE 이후에도 후속 질문을 남길 수 있다.

질문을 수정할 때는 `--revision 현재값`을 요구한다. 해소는 실제 답변의 `quote`와 `source`를 담은 파일로 `decision resolve KEY --file 답변.json --revision 질문revision`을 실행한다. 같은 입력의 재시도는 멱등적이다. 읽음·다른 업무 완료·Lead 새 보고는 해소 근거가 아니다. 결정함 해소는 업무 승인이나 Git 작업을 대신하지 않는다.

읽기 오류·다른 프로젝트·설치 변조는 정상적인 빈 결정함으로 취급하지 않는다. 입력 파일과 설치본이 유효하지 않으면 기존 기록을 보존하고 실패한다. 상태 파일의 기록 크기는 mod 읽기 한도인 1 MiB를 넘기지 않는다.

모드의 질문 카드에서 사용자가 답을 고른 뒤 보내기를 누르면 모드가 `hc send`로 Lead 터미널에 `[사용자 결정 · Herdr 하네스 모드] 질문 <KEY>(revision N)의 답: "..."`를 보낸다. Lead는 이 문장을 `quote`, 출처를 `Herdr 하네스 모드 사용자 선택`으로 해 해소를 기록한다. revision이 결정함과 다르면 기록하지 않고 다시 묻는다. 모드는 결정함을 직접 쓰지 않는다.

## 단계 수집 판정

`hc` 상태 `done`은 에이전트가 한 턴을 끝냈다는 뜻일 뿐, 단계가 끝났다는 뜻이 아니다. 백그라운드 셸(장시간 측정·시험)을 남긴 채 턴을 끝낸 에이전트는 그 셸이 끝나면 다시 깨어나 산출물과 receipt를 쓴다.

- **수집 판정**: 단계 산출물과 receipt가 둘 다 없고 에이전트 터미널이 살아 있으면(`live`), collect는 실행 실패(`no-result`)로 닫지 않는다. "아직 작업 중"으로 알리고 run을 열어 둔다. 터미널이 사라졌거나, Lead가 화면을 확인하고 `--force`로 수집할 때만 실행 실패로 닫는다. 산출물이 있으면 receipt가 없어도 지금처럼 수집한다(receipt는 선택 항목이다).
- **지시서 규칙**: 구현·QA·조사 지시서에 다음을 둔다. 백그라운드 작업을 남긴 채 턴을 끝내지 않고 끝날 때까지 기다린다. 산출물을 다 쓴 뒤 receipt를 마지막에 쓴다.

## 화면 갱신과 대장 용량

상태 폴더 또는 프로젝트 설정 폴더의 변경은 200ms 단위로 묶어 해당 프로젝트만 다시 읽는다. 읽는 중 발생한 변경도 후속 조회로 반영한다. `projects.json`이 있는 mod 폴더 변경은 전체 목록을 다시 읽으며, 감시 실패·누락과 프로젝트 추가·제거를 복구하기 위해 60초마다 전체 조회를 유지한다. 상대 시각은 파일을 읽지 않고 15초마다 갱신한다. 중요한 변화의 전체 이력 병합·정렬은 데이터 갱신 시 한 번만 수행하며, 렌더링과 읽음 처리에서는 계산 결과를 재사용한다.

브리핑은 `ledger.json`의 UTF-8 크기가 1 MiB의 75% 이상이면 용량 주의, 90% 이상이면 읽기 한도 임박을 표시한다. 경고는 화면에 표시하며 업무 상태를 바꾸거나 알림 소리를 반복하지 않는다. 읽기 실패 시에는 마지막 정상 자료와 용량 경고를 보존하고, 크기가 줄어든 정상 대장을 읽으면 경고를 해제한다.

75%부터 해당 프로젝트에서 과거 실행 이력의 분리 보관을 준비하고, 90%부터는 한도를 넘기기 전에 보관 작업을 우선한다.

끝난 업무의 보관 규칙은 [policy/ledger.json](policy/ledger.json)과 `core/ledger-archive.cjs`가 정한다. 대장 쓰기와 잠금은 프로젝트 CLI가 맡고, 공통 mod는 기록을 지우거나 잘라내지 않는다.

- **대상**: DONE·FAILED가 된 지 24시간이 지난 업무다. 다음 업무는 대상에서 뺀다.
  - 최근에 끝난 5건
  - 남은 업무가 의존하는 업무
  - 실행 중인 업무
  - 호출자가 `keep`으로 넘긴 업무: worktree가 남아 게시·정리 전인 업무, 미해소 질문이 걸린 업무
- **남기는 것**: 대장에는 화면용 요약만 남긴다.
  - 제목·상태·승인 근거·의존·브랜치 등 정책의 `summary` 필드
  - 마지막 실행(모델·결과)과 마지막 상태 전이
  - `x_archive`: 보관 파일 경로·SHA-256·원래 실행·이력 건수
- **옮기는 것**: 실행 이력·후보 지문·요청 원문 등 원본 전체는 `<state_dir>/archive/tasks/<ID>.json`에 쓴다. 같은 내용의 보관 파일이 있으면 재사용한다. 기존 보관 파일은 덮어쓰지 않는다. FAILED→QUEUED로 다시 연 업무가 다시 끝나 내용이 달라지면 `<ID>.<SHA-256 앞 12자>.json`에 따로 쓰고, `x_archive.file`이 그 파일을 가리킨다.
- **순서**: 보관 파일을 먼저 쓰고 새 대장을 돌려준다. 호출자는 같은 잠금 안에서 그 대장을 원자 저장한다.
- **조회**: `show` 같은 상세 조회는 `restore`로 원본을 읽는다. 지문이 다르면 실패한다.

진입점은 `node .agents/harness/runtime.cjs <binding> ledger`이고, 동작은 `plan`·`archive`·`restore`다. `archived: true`는 목록에서 숨기는 표시일 뿐이라 JSON 크기를 줄이지 않는다.

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
