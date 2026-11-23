# Herdr Harness 운영 Lead

Herdr에서 운영 checkout을 작업 위치로 열고 [자체 v2 운영 지침](README.md)을 읽는다. 기존 업무를 인계받을 때는 현재 binding의 `cwd`를 사용한다. 대장과 QA 근거는 그 위치의 `.local/hh-harness/`에 있다.

## 단일 Lead 인계

Claude의 새 Herdr 터미널에서 먼저 조회한다.

```powershell
node .agents/harness/launch.mjs whoami
node .agents/harness/launch.mjs policy
node .agents/harness/launch.mjs ls
node .agents/harness/launch.mjs decision list --all
```

기존 Lead와 진행 중인 실행 및 게시 처리를 확인한다. 기존 Lead가 기록을 수집하고 인계를 확인하면 그 Lead의 터미널을 정상 종료한다. `hc get <기존 Lead 주소> --json`에서 종료됐거나 존재하지 않는 것으로 확인한 후 새 터미널에서 아래 명령을 실행한다. 기존 Lead가 살아 있거나 상태를 확인하지 못하면 `recover`가 교체를 거부한다.

```powershell
node .agents/harness/launch.mjs recover
node .agents/harness/launch.mjs whoami
```

두 명령에서 새 터미널이 Lead로 일치하는지 확인한다. `recover`가 돌려준 활성 실행은 기존 산출물과 터미널부터 확인한 뒤 수집한다. `next --go`는 남은 실행과 열린 결정을 확인한 후 사용한다.

## 실행 중인 Codex 터미널에 보내기

실행 중인 Codex 터미널에 추가 지시나 Lead 주소 변경 알림 등을 보낼 때는 `hc send` 대신 `node <고정 release>/bin/send.mjs <터미널> "<텍스트>"`를 쓴다. `hc send`는 성공을 돌려줘도 Codex 입력창에 원문이 남을 수 있다. 이 도구는 남은 경우 Enter만 다시 누르고, 끝까지 남으면 0이 아닌 코드로 끝난다. 그때는 `hc read <터미널>`로 입력창을 확인한다. 원문을 다시 보내지 않는다.

## 영수증 경로로 차단된 기존 QA 재개

전환 전 기준에서 생성된 업무에는 `target/hh-verify/`의 Git 제외 규칙이 빠져 있을 수 있다. 해당 업무의 마지막 QA 보고서를 보존하고 업무 checkout에서 `git check-ignore -v --no-index -- target/hh-verify/latest-qa.json`으로 확인한다. 규칙이 없다면 그 checkout의 `target/hh-verify/.gitignore`에 `*` 한 줄을 두어 해당 디렉터리의 로컬 실행 자료를 제외한다. 이미 파일이 있다면 내용을 먼저 확인한다.

영수증과 로컬 ignore 파일이 모두 제외되고 `git status --short --untracked-files=all`에 기존 후보 경로만 남는지 확인한다. 업무 범위와 동결 계획이 그대로라면 근거를 넣어 재개하고 새 독립 QA에 위임한다.

```powershell
node .agents/harness/launch.mjs flow-status HH-001
node .agents/harness/launch.mjs flow-resume HH-001 --evidence "업무 checkout의 영수증 및 로컬 ignore 제외와 기존 후보 경로 보존을 확인함"
node .agents/harness/launch.mjs dispatch HH-001
```

## 해소 결정이 동결 계획과 충돌할 때

각 단계 지시서에는 위임 당시 이 업무에 연결된 해소 결정(질문·선택·답변 원문·출처·revision)이 `해소 결정: <JSON>`으로 들어간다. 결정을 해소해도 동결 계획은 그 자리에서 바뀌지 않는다. 결정이 계획을 바꾸라고 요구하면(예: 필수 검사 `mobile-browser-copy`를 배포 후 실기기 확인으로 옮기기) 아래 순서로 재조사·재동결한다.

1. `decision list --all`과 `flow-status ID`에서 결정 ID·revision·답변과 동결 계획의 검사·AC를 대조해 바뀔 ID를 정한다. 답변이 계획을 바꾸지 않으면 그대로 진행한다.
2. 업무가 BLOCKED이면(예: QA가 충돌한 검사를 `blocked`, `kind=decision` finding으로 보고) 근거를 넣어 재조사로 보낸다. 이전 회차의 보고와 계획 파일은 그대로 남는다.

   ```powershell
   node .agents/harness/launch.mjs flow-resume HH-123 --stage research --evidence "결정 browser-check revision 2: mobile-browser-copy를 배포 후 실기기 확인(follow-up)으로 이동"
   node .agents/harness/launch.mjs dispatch HH-123
   ```

3. 업무가 독립 QA PASS 뒤 게시 대기(phase=publish)나 CI 대기(phase=ci)이면 그 결정은 PASS한 QA 지시서에 없었다. 판정을 기록하기 전에는 `publish-check`·`flow-attach-pr`·`flow-close`·`flow-deliver`가 «QA 이후 해소된 결정의 계획 영향을 판정하지 않았다»로 멈춘다(이미 병합된 PR의 `flow-prove-merged`는 막지 않는다). `decision list --all`에서 결정 ID와 해소 뒤 revision을 확인한다.
   - 계획을 바꾸면 결정 ID·revision·변경 근거로 QA 판정과 게시 허가를 철회하고 재조사로 돌린다. 대장에는 `QA → BLOCKED`(철회)와 `BLOCKED → RESEARCHING`이 남고, `x_flow.recovery`에 결정(`decision`)과 철회한 QA 보고 지문·phase·연결했던 PR(`withdrawn`)이 남는다. 이전 QA 판정·실행 영수증·게시 근거(`verification`, `runner`, `delivery`)는 지워진다. 열린 PR은 새 QA 뒤 같은 브랜치에 다시 게시하고 `flow-attach-pr`로 다시 연결한다.

     ```powershell
     node .agents/harness/launch.mjs flow-resume HH-123 --stage research --decision copy-timing --revision 2 --evidence "copy-check를 배포 후 실기기 확인(follow-up)으로 이동"
     node .agents/harness/launch.mjs dispatch HH-123
     ```

   - 계획을 바꾸지 않으면 `--stage` 없이 같은 결정 ID·revision과 판정 근거를 기록한다. 상태·QA 판정은 그대로이고 `x_flow.decisionReviews`에 남는다. 그 뒤 게시를 이어 간다.

     ```powershell
     node .agents/harness/launch.mjs flow-resume HH-123 --decision pr-title --revision 2 --evidence "PR 제목 표현만 바뀜. 동결 계획·수정 범위 영향 없음"
     ```

   - 이 업무에 연결되지 않은 결정, 현재와 다른 revision, `--decision` 없는 재조사, `--stage implement`는 거부되고 대장은 바뀌지 않는다.
   - PR이 연결된 업무(phase=ci)는 철회 전에 그 PR을 조회한다. 서버에서 이미 MERGED이거나 조회 실패·다른 PR 번호·상태 없음으로 확정할 수 없으면 «재조사하지 않는다»로 거부하고 QA 판정·게시 anchor·delivery를 그대로 둔다. 이때는 PR 상태를 확인해 `flow-prove-merged HH-123`으로 병합을 증명해 업무를 마치고, 결정은 `add`로 후속 업무를 만들어 다룬다. 조회가 일시 장애였으면 같은 `flow-resume`을 다시 실행한다.
4. 업무가 BLOCKED도 게시·CI 대기도 아니면(조사·설계·구현·QA 진행 중) 다음 단계에 위임한다. 지시서의 결정 안내에 따라 그 단계가 충돌을 BLOCKED로 보고하면 수집 뒤 2를 따른다. 이미 실행 중인 회차는 결과를 수집한 뒤 판단한다.
5. 재조사 summary에서 결정 ID·revision과 바뀐 검사·AC를 확인한다. 원래 AC가 빠지지 않았는지, 옮긴 항목이 `follow-up`에 환경·확인 방법과 함께 남았는지 본다. collect가 새 계획을 동결하면 구현·독립 QA를 다시 위임한다. 새 QA 지시서의 `해소 결정`과 «후속 확인 항목은 실행하지도 checks에 적지도 않는다» 줄을 확인한다. 새 QA PASS 뒤 `publish-check`의 `decisions`에 그 결정이, `remainingVerification`에 옮긴 후속 확인이 나오는지 확인하고 게시한다.

BLOCKED 업무의 재조사(2)에도 `--decision KEY --revision N`을 붙이면 같은 검증을 거쳐 `x_flow.recovery.decision`에 남는다.

collect가 계획을 거부하면(`checkScopes` 누락, 독립 QA가 실행할 수 없는 항목의 필수 지정, 선언되지 않은 실행 수단, QA runner 전용 `hh-suite` 행의 `command`, follow-up `environment`·`verify`의 링크·이미지 대괄호·꺾쇠·백틱·HTML 엔티티 등) 대장은 바뀌지 않는다. 같은 조사 회차의 verification-plan.json을 고치게 한 뒤 다시 collect한다. 오류 메시지에 원인 검사·AC ID가 있다.

## PR 본문 남은 검증 누락 복구

`publish-check ID`의 `remainingVerification[].line`이 PR 본문 «남은 검증»에 `- [ ] <line>` 목록 줄로 한 줄씩 그대로 보여야 한다. 판정은 화면에 보이는 것이 확실한 줄만 인정한다([공통 규칙](../../README.md#qa와-남은-검증)).

- PR 템플릿의 HTML 주석(`<!-- -->`)이나 HTML 속성·요소(`<div title="…">`, `<details>`) 안의 줄은 없는 것으로 본다. 태그·속성·`<details>`, 줄을 넘는 인라인 주석, 들여쓰거나 목록·인용 안에 있는 코드 울타리가 나오면 그 뒤의 줄도 인정하지 않으므로 «남은 검증» 절을 그런 요소보다 앞에 옮긴다.
- 순서 목록(`1.`)·표시 없는 줄·4칸 이상 들여쓴 줄은 인정하지 않는다. `- `, `* `, `+ `(선택 `[ ]`)로 시작한다.
- 인라인 코드(`` `<!--` ``)나 줄 맨 앞 울타리 코드 안의 주석 표식은 문자 그대로라 판정에 영향이 없다. 같은 줄 끝의 닫힌 주석 메모는 허용된다.

- `flow-attach-pr`가 «PR 본문 «남은 검증»에 … 줄이 빠졌다»로 거부하면 대장은 그대로다. 게시자에게 빠진 줄을 넣게 하거나 `gh pr edit N --body-file <본문 파일>`로 고친 뒤 같은 명령을 다시 실행한다.
- 연결 뒤 본문이 바뀌어 `flow-deliver`가 `phase: blocked`, `missing`을 돌려주면 본문을 고친 뒤 다시 확인한다. `--apply`·`watch-delivery`에서 막혀 BLOCKED(`delivery-blocked`)가 됐으면 본문을 고친 뒤 `flow-resume HH-123 --evidence "PR 본문 남은 검증 복구"`로 CI 확인에 돌려보낸다.
- 이미 병합된 PR의 증명(`flow-prove-merged`)은 본문을 대조하지 않는다.

## QA 실행 영수증 발급과 PR 본문

HH의 필수 CI(`harness-ci (ubuntu-latest)`, `harness-ci (windows-latest)`)는 전체 시험 대신 PR 본문의 QA 실행 영수증 줄만 검증한다([공통 규칙](../../README.md#qa-실행-영수증과-ci-검증)). PR #7 이하만 면제다. 영수증 줄이 없으면 PR은 병합되지 않으므로 게시 전에 줄을 확보한다.

1. QA PASS 뒤 `publish-check HH-123`의 `qaReceipt.line`을 확인한다. 이 저장소의 QA runner(verify.mjs)가 Windows·Docker Linux 검사를 통과했을 때 그 QA 회차의 `target/hh-verify/receipts/<QA token>/envelope.txt`에 남긴 줄이다.
2. `qaReceipt`가 없으면(HH-005 병합 전의 QA runner로 PASS했거나 회차 폴더가 지워졌다) `publish-check HH-123`이 허용하는지(업무 worktree 후보 = QA 후보) 확인한 뒤 업무 worktree에서 같은 runner로 발급한다. 원본 checkout(main)의 runner·정책을 쓴다. Windows와 Linux 전체 suite를 한 번씩 실행하고 OS마다 heavy 슬롯을 잡으므로 heavy로 다시 감싸지 않는다. Docker Desktop이 실행 중이어야 한다.

   ```powershell
   node <원본 checkout>/bin/qa-receipt.mjs --worktree <업무 worktree> --base <업무 base> --run <QA token> --round <QA 회차> --heavy <고정 release>/bin/heavy.mjs --policy <원본 checkout>/policy/qa-receipt.json
   ```

   exit 0이면 출력의 `out`/envelope.txt가 본문에 넣을 줄이다. exit 1(FAIL)은 결함이므로 `flow-resume --stage implement`로 되돌린다. exit 3(BLOCKED)은 `reasons`의 Docker·이미지 문제를 해결한 뒤 같은 명령을 다시 실행한다.
3. 게시자에게 envelope 줄을 넘겨 «남은 검증» 목록 뒤, 줄 맨 앞에 그대로 넣게 한다. 게시자는 그 본문으로 PR을 처음 만든다. 줄 없이 만든 PR은 첫 CI가 실패로 남아 같은 head의 병합 판정이 그 결과를 읽을 수 있다.
4. CI가 «QA 영수증 거부»로 실패하면 사유를 본다. «없다·형식·해독»은 본문 줄을 고치고(`gh pr edit N --body-file <본문 파일>`, edited 이벤트로 재검사), «후보 지문 불일치»는 main이 후보 경로를 바꿨거나 PR 커밋이 QA 후보와 달라진 것이므로 현재 후보를 다시 QA하거나 2의 명령으로 다시 발급해 줄을 바꾼다. «필수 검사 결과 없음·정책과 다른 명령»은 main의 정책이 바뀐 경우이므로 다시 발급한다. 전체 시험으로 돌아가는 폴백은 없다.

HH-005 자체의 PR은 그 QA의 matrix-live 회차가 `target/hh-verify/receipts/<QA token>/envelope.txt`를 남긴다. 병합 전 원본 checkout에는 새 publish-check가 없으므로 이 파일을 직접 읽어 3을 따른다.

## PR 없는 업무의 정책 예외 종결

사용자가 PR·병합 없이 끝내도록 승인한 업무만 대상이다. `flow-status`에서 state=QA, phase=publish, 독립 QA PASS, 연결된 PR 없음을 확인하고 `decision list`에 열린 결정이 없는지 본다. 근거에는 승인 출처와 이 업무에 적용하는 이유를 적는다.

```powershell
node .agents/harness/launch.mjs flow-status HH-123
node .agents/harness/launch.mjs flow-close HH-123 --evidence "사용자 승인(대화 2026-01-01): 별도 PR을 만들지 않는 검증 업무"
node .agents/harness/launch.mjs show HH-123
```

결과는 DONE, phase=closed와 `x_flow.closure.kind=policy-exception`이다. 동결 계획에 후속 확인이 있으면 `closure.remainingVerification`에 남으므로 사용자에게 그 목록을 함께 알린다. QA 미통과, 활성 실행, 열린 결정, 판정을 기록하지 않은 QA 이후 해소 결정, PR 연결, QA 이후 후보 변경이 있으면 거부되고 대장은 바뀌지 않는다. DONE 직후 worktree 정리가 자동으로 실행된다. 결과는 아래 절차로 확인한다.

## 끝난 업무 worktree 정리와 재시도

`flow-deliver --apply`·`watch-delivery`·`flow-prove-merged`의 병합 증명과 `flow-close`의 예외 종결 응답에는 `cleanup`이 붙는다. `cleanup.status`가 `done`이면 worktree가 지워졌고 병합 업무의 로컬 브랜치도 지워졌다. 예외 종결 업무는 후보 patch(`cleanup.patch.file`, `sha256`)를 남기고 브랜치를 보존한다. 그 밖의 상태는 DONE과 병합 증명을 유지한 채 `reasons`·`remaining`·`retry`를 남긴다. 원인을 해소한 뒤 같은 명령으로 재시도한다.

```powershell
node .agents/harness/launch.mjs show HH-123
node .agents/harness/launch.mjs cleanup-worktree HH-123
```

| 사유 | 조치 |
|---|---|
| 살아 있는 위임 터미널 `tN` | 정리는 활동 조회 전에 남겨 둔 위임 터미널(`x_terminal.outcome=kept·still-live·unknown`)을 working이어도 다시 닫고 끝난 터미널은 `hc rm`으로 지운다. 그래도 남았으면 kill로 끝나지 않는 터미널(`still-live`)이거나 레이블이 다른 터미널이다. `hc get tN --json`에서 `harness.task`·`harness.run`이 이 업무의 회차인지 확인한 뒤 `hc kill tN`·`hc rm tN`으로 닫는다 |
| 위임 터미널 상태를 확인하지 못했다 | hc 서버(`hc server status`)를 확인한 뒤 재시도한다. 수집 때 `x_terminal.outcome=unknown`이었던 터미널도 같다. hc가 not_found로 알리는 제거된 터미널은 정리를 막지 않는다 |
| 다른 프로세스가 worktree를 사용 중 | 게시자 세션·셸·편집기가 그 worktree를 cwd로 쓰는지 확인하고 닫는다. 게시자 세션은 `flow-attach-pr` 뒤 Lead가 닫는다 |
| 보존 대상 밖의 항목(미추적·변경·무시 파일) | 목록의 파일을 확인한다. 필요한 내용은 옮기고 업무와 무관한 생성물만 지운다. 정리 기능은 이 파일을 대신 지우지 않는다 |
| status가 변경을 숨기는 index 플래그 경로 | 이유의 `(assume-unchanged·skip-worktree; 작업 사본≠index)`가 보존할 로컬 변경이다. worktree에서 `git update-index --no-assume-unchanged --no-skip-worktree -- <경로>`로 플래그를 풀고 `git status`·`git diff`로 내용을 확인한다. 보존할 내용은 옮기거나 커밋한 뒤 원래대로 되돌리고 재시도한다 |
| status에 나오지 않은 작업 사본 변경(내용 해시≠index blob) | 크기·mtime이 index 기록과 같아 `git status`가 보지 못한 수정이다. 목록의 경로에서 `git hash-object -- <경로>`와 `git rev-parse :<경로>`를 비교한다. 수정 시각을 갱신하면(`(Get-Item <경로>).LastWriteTime = Get-Date`) Git이 내용을 다시 읽어 `git status`·`git diff -- <경로>`에 나타난다. 보존할 내용은 옮기거나 커밋한 뒤 재시도한다. 제거 직전 확인에서 걸려 `partial`이어도 파일·등록·브랜치는 그대로다 |
| 추적 파일 내용 확인·폴더 순회가 시간 한도 안에 끝나지 않았다 | 변경 여부를 확인하지 못해 아무것도 지우지 않았다. DONE 직후 자동 정리의 한도(`cleanup.content_ms`, 60초)를 넘는 큰 worktree다. `cleanup-worktree HH-123`은 `cleanup.retry_content_ms`(600초)로 다시 확인한다. 그래도 넘으면 worktree의 큰 추적 파일과 항목이 많은 생성물 폴더를 확인한다 |
| status에 나오지 않거나 지우면 worktree 밖까지 닿는 항목 | 이유의 종류별로 처리한다. `링크·junction <경로>`: `Get-Item <경로> \| Select-Object LinkType, Target`으로 대상을 확인하고, 링크만 지운다(junction은 `cmd /c rmdir <경로>`, 심볼릭 링크는 `Remove-Item <경로>`; 재귀 삭제는 대상까지 지울 수 있으니 쓰지 않는다). `링크·junction <경로>(index의 추적 링크와 다름)`: index에는 링크(mode 120000)로 추적되지만 디스크의 링크·junction이 그 추적 링크와 다르다(대상이 index와 다르거나, 일반 파일로 꺼낸 추적 링크를 junction으로 바꿨다). 예외 종결 후보 경로여도 정리하지 않는다. 대상 폴더의 내용을 확인한 뒤 링크만 지우고 worktree에서 `git checkout -- <경로>`로 추적 링크를 되살린다. 후보의 링크 변경이 보존할 내용이면 내용을 옮긴 뒤 같은 방법으로 되돌린다. `.git 이름 항목 <경로>`: 중첩 저장소면 `git -C <폴더> log --all`·`git -C <폴더> status`로 커밋·변경을 확인해 push하거나 옮긴다. 저장소가 아닌 `.git` 폴더·파일은 내용을 확인해 옮긴다. `설명되지 않는 파일 <경로>`: 내용을 확인해 옮긴다. `대소문자만 다른 이름 <경로>(<먼저 본 경로>와 같은 index 경로)`: `core.ignorecase=true` 저장소의 worktree가 대소문자를 구분하는 폴더(Windows는 `fsutil file queryCaseSensitiveInfo <폴더>`로 확인)에 있어 Git이 보고하지 않는 미추적 항목이다. 두 항목의 내용을 비교해 보존할 쪽을 worktree 밖으로 옮기거나 커밋할 이름으로 바꾼 뒤 재시도한다. 정리 기능은 이 항목을 대신 지우지 않는다. pnpm `node_modules` 같은 링크 폴더는 링크를 따라가지 않는 방법으로 지운 뒤 재시도한다 |
| Git이 지우거나 덮어쓸 경로에 링크·junction이나 예상 밖 항목이 있다 | 사전검사 뒤, 되돌릴 후보 경로나 지울 과정 문서 경로(또는 그 상위 폴더)가 링크·junction으로 바뀌었거나 그 자리 폴더에 후보 밖 파일이 생겼다. Git checkout 전에 멈췄으므로 경로 안 내용과 링크 대상은 그대로다. 위 행처럼 대상과 내용을 확인해 링크만 지우고, 후보 내용(`cleanup.patch`로 복원 가능)을 되살린 뒤 재시도한다. 의도 기록 뒤 멈췄으면 `partial`이고 patch·보관 기록은 남아 있다 |
| worktree 전용 ref가 있다 | worktree에서 `git for-each-ref refs/worktree refs/bisect refs/rewritten`으로 목록을 본다. 보존할 커밋은 `git branch <이름> <ref>`로 공용 ref에 옮긴다. bisect ref는 `git bisect reset`, 그 밖에 필요 없는 ref는 내용을 확인한 뒤 worktree에서 `git update-ref -d <ref>`로 지우고 재시도한다 |
| 진행 중인 Git 작업 상태가 있다 | worktree에서 `git status`로 진행 중인 병합·cherry-pick·revert·rebase·bisect를 확인한다. 필요한 결과는 `--continue`로 마쳐 커밋하고(브랜치 tip이 바뀌면 위 tip 사유와 같이 처리), 아니면 `--abort`(bisect는 `git bisect reset`)로 취소한 뒤 재시도한다 |
| submodule이 있는 worktree | Git이 비강제 제거를 거부하므로 정리는 아무것도 바꾸지 않고 멈춘다. submodule 안의 미커밋·미푸시 내용을 확인해 옮긴 뒤 Lead가 직접 처리한다(`git submodule deinit`, `git worktree remove`). 정리 기능은 submodule worktree를 지우지 않는다 |
| 업무 브랜치 tip이 증명의 head와 다르다 | 병합 뒤 브랜치에 생긴 커밋을 확인한다. 보존할 내용이면 다른 브랜치로 옮기고, 최초 게시 anchor나 증명된 head로 되돌린 뒤 재시도한다 |
| 증명에 PR 브랜치 이름이 없다 | 이번 기능 이전의 증명이다. 새 release 설치 뒤 `flow-prove-merged HH-123`로 다시 증명하면 정리가 자동으로 이어진다 |
| 고정 release가 worktree 정리를 지원하지 않는다 | 새 release를 설치하고 binding을 전환한 뒤 재시도한다 |
| `partial`(제거 확인 실패·빈 골격) | 의도 기록(`.local/hh-harness/tasks/HH-123/cleanup.json`) 뒤 멈춘 상태다. `remaining`에 남은 worktree 경로와 `refs/heads/<업무 브랜치>`가 있다. 이유의 Git 종료 코드·메시지를 확인한다. 사용 중이면 그 프로세스를 닫는다. 파일이 남은 폴더는 목록의 내용을 확인한 뒤 처리한다. 빈 폴더 골격이나 등록만 남은 상태는 재시도가 정리한다. 브랜치 단계에서 멈췄으면 위 tip·이름 사유와 같이 처리한다. 예외 종결 patch와 보관 파일은 기록에 남아 있으므로 다시 만들지 않는다 |

준비 시간 초과로 남은 부분 worktree, FAILED 업무의 worktree, 보관된 업무는 이 명령의 대상이 아니다. 보관된 업무는 `show`로 보관본을 확인한 뒤 Lead가 직접 처리한다. 정리가 끝나지 않은 업무는 `archive-tasks`에서 보관하지 않는다.

예외 종결 patch는 기준 HEAD(`cleanup.patch.head`)를 checkout한 곳에서 파일 SHA-256을 대조한 뒤 `git apply --binary <patch>`로 복원한다. 지운 병합 브랜치는 `git branch <업무 브랜치> <cleanup.branch.tip>`으로 되살릴 수 있다.
