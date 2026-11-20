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

## 영수증 경로로 차단된 기존 QA 재개

전환 전 기준에서 생성된 업무에는 `target/hh-verify/`의 Git 제외 규칙이 빠져 있을 수 있다. 해당 업무의 마지막 QA 보고서를 보존하고 업무 checkout에서 `git check-ignore -v --no-index -- target/hh-verify/latest-qa.json`으로 확인한다. 규칙이 없다면 그 checkout의 `target/hh-verify/.gitignore`에 `*` 한 줄을 두어 해당 디렉터리의 로컬 실행 자료를 제외한다. 이미 파일이 있다면 내용을 먼저 확인한다.

영수증과 로컬 ignore 파일이 모두 제외되고 `git status --short --untracked-files=all`에 기존 후보 경로만 남는지 확인한다. 업무 범위와 동결 계획이 그대로라면 근거를 넣어 재개하고 새 독립 QA에 위임한다.

```powershell
node .agents/harness/launch.mjs flow-status HH-001
node .agents/harness/launch.mjs flow-resume HH-001 --evidence "업무 checkout의 영수증 및 로컬 ignore 제외와 기존 후보 경로 보존을 확인함"
node .agents/harness/launch.mjs dispatch HH-001
```

## PR 없는 업무의 정책 예외 종결

사용자가 PR·병합 없이 끝내도록 승인한 업무만 대상이다. `flow-status`에서 state=QA, phase=publish, 독립 QA PASS, 연결된 PR 없음을 확인하고 `decision list`에 열린 결정이 없는지 본다. 근거에는 승인 출처와 이 업무에 적용하는 이유를 적는다.

```powershell
node .agents/harness/launch.mjs flow-status HH-123
node .agents/harness/launch.mjs flow-close HH-123 --evidence "사용자 승인(대화 2026-01-01): 별도 PR을 만들지 않는 검증 업무"
node .agents/harness/launch.mjs show HH-123
```

결과는 DONE, phase=closed와 `x_flow.closure.kind=policy-exception`이다. QA 미통과, 활성 실행, 열린 결정, PR 연결, QA 이후 후보 변경이 있으면 거부되고 대장은 바뀌지 않는다. DONE 직후 worktree 정리가 자동으로 실행된다. 결과는 아래 절차로 확인한다.

## 끝난 업무 worktree 정리와 재시도

`flow-deliver --apply`·`watch-delivery`·`flow-prove-merged`의 병합 증명과 `flow-close`의 예외 종결 응답에는 `cleanup`이 붙는다. `cleanup.status`가 `done`이면 worktree가 지워졌고 병합 업무의 로컬 브랜치도 지워졌다. 예외 종결 업무는 후보 patch(`cleanup.patch.file`, `sha256`)를 남기고 브랜치를 보존한다. 그 밖의 상태는 DONE과 병합 증명을 유지한 채 `reasons`·`remaining`·`retry`를 남긴다. 원인을 해소한 뒤 같은 명령으로 재시도한다.

```powershell
node .agents/harness/launch.mjs show HH-123
node .agents/harness/launch.mjs cleanup-worktree HH-123
```

| 사유 | 조치 |
|---|---|
| 살아 있는 위임 터미널 `tN` | `hc get tN --json`에서 `harness.task`·`harness.run`이 이 업무의 회차이고 작업 중이 아닌지 확인한 뒤 `hc kill tN`. 수집 때 에이전트가 `working`이라 닫지 않았거나(`x_terminal.outcome=kept`) kill 뒤에도 살아 있던(`still-live`) 터미널이다. kill 뒤에도 살아 있으면 `hc get tN --json`으로 확인한 뒤 다시 닫는다 |
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
