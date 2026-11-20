# Herdr Harness의 자체 v2 업무

자체 업무는 저장소의 .agents/harness/config.json을 읽는 공통 launcher로 시작한다. 업무 상태와 보고서는 .local/hh-harness/, 격리 checkout은 .local/worktrees/에 둔다. Lead가 등록된 Herdr 터미널에서만 업무 상태를 쓴다.

운영 Lead는 [Lead 인계와 업무 재개](LEAD.md)를 먼저 읽는다.

## 연결과 등록

활성 설치의 manifest를 확인하고 자체 binding과 Herdr 목록 항목만 추가한다. 기존 프로젝트 binding과 설치된 mod 파일은 그대로 사용한다.

    node .agents/harness/connect.mjs --active C:/path/to/herdr-harness/active.json --register-panel

이후 해당 checkout에서 아래처럼 호출한다. 자체 진입점은 binding 경로를 확인해 checkout의 공통 launcher에 전달한다. 정책·검증·병합 판정은 binding이 고정한 release에서 읽는다.

    node .agents/harness/launch.mjs whoami
    node .agents/harness/launch.mjs policy
    node .agents/harness/launch.mjs recover
    node .agents/harness/launch.mjs add --workflow v2 --kind feature --title "제목" --slug task-name --desc-file request.txt --authorization "사용자의 게시·병합 승인 근거"
    node .agents/harness/launch.mjs next --go
    node .agents/harness/launch.mjs collect HH-001

위임은 동결한 AC·검사와 보고서 위치를 전달한다. QA의 PASS에는 독립 회차의 보고서와 함께 고정 release를 사용한 후보 tree별 실행 영수증이 필요하다. runner는 시험 worker 표지를 제거한 환경에서 고정 시험 명령을 실행하고 양수의 전체 통과 건수가 기록된 경우에만 영수증을 발급한다. 수집기는 해당 회차의 로그에서 같은 건수를 다시 확인한다. 복구는 recover로 현재 연결된 실행을 조회하고, 차단 업무는 flow-resume ID --evidence "달라진 조건"으로 재개한다.

## 게시와 병합

Lead는 publish-check ID를 확인한 뒤 공통 launcher의 publisher-command ID가 돌려준 argv를 사용한다. 게시자는 같은 ID의 후보를 확인하고 승인된 파일만 명시적으로 stage한다. 로컬 커밋 뒤 publish-check ID --committed로 Git tree·변경 경로·mode·blob을 대조한다. 이 판정을 얻은 뒤 해당 업무 브랜치만 push하고 main을 대상으로 PR을 만든다. PR 본문에 원래 AC, 독립 QA 회차·후보·실행한 검사, 남은 검증을 기록한다.

Lead는 flow-attach-pr ID --pr N으로 실제 PR을 대장에 연결한다. flow-deliver ID는 현재 후보와 CI·보호 규칙을 확인한다. flow-deliver ID --apply 또는 watch-delivery ID는 열린 결정이 없고 공통 DEV-14 조건이 충족됐을 때만 squash한다. 이미 병합된 PR은 flow-prove-merged ID로 읽기 전용 증명을 확인한다. 최초 게시 anchor, 최종 head의 CI, squash 부모와 tree, GitHub main 포함이 확인되면 대장이 DONE으로 바뀐다.

PR을 만들지 않기로 승인된 업무는 flow-close ID --evidence "승인 출처와 적용 이유"로 정책 예외 종결한다. 등록된 Lead만 실행하며, 업무가 독립 QA PASS 후 publish 단계에 있고 활성 실행·열린 결정·연결된 PR이 없으며 현재 후보가 QA 후보와 같을 때만 DONE이 된다. 대장에는 phase=closed와 x_flow.closure(kind=policy-exception, 시각, Lead 터미널, 근거, 직전 phase, QA 판정)가 남아 병합 증명(phase=merged)과 구분된다. PR이 이미 연결된 업무는 병합 증명 절차를 따른다.

    node .agents/harness/launch.mjs flow-close HH-123 --evidence "사용자 승인(대화 2026-01-01): PR 없는 검증 업무"

## 끝난 업무 정리

DONE이 되면 같은 Lead 잠금 안에서 공통 [worktree 정리](../../README.md#끝난-업무-worktree-정리)를 한 번 부른다. 호출 시점은 flow-deliver ID --apply(watch-delivery 포함)와 flow-prove-merged ID가 병합을 증명했을 때, flow-close ID가 예외 종결했을 때다. 미병합·차단·조회 전용 결과에는 부르지 않는다. 명령 응답에 cleanup 항목이 붙고 대장의 x_cleanup과 x_cleanup 사건에 같은 결과가 남는다. 결과가 이전과 같으면 다시 기록하지 않는다.

- 정리가 거부되거나 실패해도 DONE·병합 증명·예외 종결은 되돌리지 않고 명령의 종료 코드도 바꾸지 않는다. cleanup에는 status(done·refused·partial·failed), 사유, 남은 worktree·브랜치, 재시도 명령이 있다. failed는 binding·release 문제처럼 공통 정리를 실행하지 못한 경우다.
- 병합 업무는 worktree를 지운 뒤 로컬 업무 브랜치를 -d, 거부되면 증명 조건을 다시 확인해 -D로 지운다. 예외 종결 업무는 미커밋 후보를 .local/hh-harness/tasks/ID/worktree-*.patch로 보존하고 브랜치를 남긴다.
- config.json의 cleanup.keep_ignored(target/hh-verify/)는 상태 폴더의 tasks/ID/artifacts/에 보관한 뒤 지우고, cleanup.discard_ignored(dist/, mod/harness/contract.js, mod/harness/decisions.js)는 생성물로 보고 그대로 지운다. 그 밖의 무시 파일이 있으면 정리를 거부한다.
- 정리는 status가 깨끗하다는 것만 믿지 않고 사전검사와 worktree remove 직전에 추적 파일 전체의 내용 해시를 index blob과 비교하고, worktree 폴더를 링크를 따라가지 않고 순회해 모든 항목이 추적 파일이나 위 keep·discard·과정 문서로 설명되는지 대조한다. .git 이름 항목(중첩 저장소), 확인된 추적 링크(index mode 120000이고 status가 보고하지 않으며 링크 대상=index blob)가 아닌 링크·junction(discard 폴더 안, 예외 종결 후보 경로 포함), worktree 전용 ref(refs/worktree·refs/bisect·refs/rewritten), 진행 중인 병합·rebase 등이 있으면 지우지 않는다. 후보 되돌리기(git checkout)와 worktree remove처럼 Git이 경로를 지우는 단계 직전에는 대상 경로와 worktree 안 상위 구성요소가 링크·junction이 아닌지 lstat으로 다시 보고, 아니면 멈춘다. 이 확인의 한도는 config.json의 cleanup.content_ms(60000ms)다. DONE 직후 자동 정리가 watch-delivery 한 회(180초) 안에 끝나게 한 값이다. 한도를 넘으면 지우지 않고 refused로 남긴다. 아래 재시도 명령은 cleanup.retry_content_ms(600000ms)를 쓴다.
- 이미 DONE인 업무, 거부·부분 완료된 정리는 Lead가 아래 명령으로 다시 실행한다. 보관된 업무(x_archive)와 열린 결정이 있는 업무는 거부한다. 정리가 끝나지 않으면 종료 코드 1이다.

      node .agents/harness/launch.mjs cleanup-worktree HH-123

collect는 단계 보고를 정상 수집해 회차를 저장한 뒤 그 회차의 위임 터미널을 hc kill로 닫는다. 대장에 기록된 주소이고 harness.task·harness.run 레이블이 그 회차와 같을 때만이다. Lead 터미널, 다른 업무 터미널, 레이블 불일치, 조회 실패, 아직 working인 에이전트는 닫지 않고 회차의 x_terminal에 사유를 남긴다(outcome=kept). kill 뒤에는 응답과 무관하게 다시 조회한다. 종료나 제거(not_found)를 확인하면 killed(after=finished·removed), 여전히 live면 still-live, 조회에 실패하면 unknown이다. 종료 실패는 수집 결과를 되돌리지 않는다. 게시자 세션은 대장에 회차·레이블이 없어 정체를 확인할 수 없으므로 자동 종료 대상이 아니다. Lead가 flow-attach-pr 뒤 직접 닫는다. 게시자 세션이 worktree를 cwd로 잡고 있으면 Windows에서는 정리가 «사용 중»으로 거부된다.

GitHub Actions 검사 이름은 harness-ci (ubuntu-latest)와 harness-ci (windows-latest)다. 서버에서 검사 이름과 GitHub Actions App을 필수로 지정하고 strict up-to-date와 우회 없는 보호를 확인해야 자동 병합할 수 있다.

결정 요청은 decision request KEY --file JSON으로 등록한다. 실제 사용자 답변과 출처는 decision resolve KEY --file JSON --revision N으로 기록한다. 설치된 Herdr 패널은 이 저장소의 업무·결정함과 현재 Lead를 읽는다.

최초 도입 QA는 후보 밖에 보관한 기준 commit·검증 계획·고정 release에서 판정하고 별도 bootstrap ID를 사용한다. .local/hh-harness/의 실제 v2 업무에는 그 조사·QA·게시 판정을 복사하지 않는다.
