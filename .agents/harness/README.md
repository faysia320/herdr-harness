# Herdr Harness의 자체 v2 업무

자체 업무는 저장소의 .agents/harness/config.json을 읽는 공통 launcher로 시작한다. 업무 상태와 보고서는 .local/hh-harness/, 격리 checkout은 .local/worktrees/에 둔다. Lead가 등록된 Herdr 터미널에서만 업무 상태를 쓴다.

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

위임은 동결한 AC·검사와 보고서 위치를 전달한다. QA의 PASS에는 독립 회차의 보고서와 함께 고정 release를 사용한 후보 tree별 실행 영수증이 필요하다. 복구는 recover로 현재 연결된 실행을 조회하고, 차단 업무는 flow-resume ID --evidence "달라진 조건"으로 재개한다.

## 게시와 병합

Lead는 publish-check ID를 확인한 뒤 공통 launcher의 publisher-command ID가 돌려준 argv를 사용한다. 게시자는 같은 ID의 후보를 확인하고 승인된 파일만 명시적으로 stage한다. 로컬 커밋 뒤 publish-check ID --committed로 Git tree·변경 경로·mode·blob을 대조한다. 이 판정을 얻은 뒤 해당 업무 브랜치만 push하고 main을 대상으로 PR을 만든다. PR 본문에 원래 AC, 독립 QA 회차·후보·실행한 검사, 남은 검증을 기록한다.

Lead는 flow-attach-pr ID --pr N으로 실제 PR을 대장에 연결한다. flow-deliver ID는 현재 후보와 CI·보호 규칙을 확인한다. flow-deliver ID --apply 또는 watch-delivery ID는 열린 결정이 없고 공통 DEV-14 조건이 충족됐을 때만 squash한다. 이미 병합된 PR은 flow-prove-merged ID로 읽기 전용 증명을 확인한다. 최초 게시 anchor, 최종 head의 CI, squash 부모와 tree, GitHub main 포함이 확인되면 대장이 DONE으로 바뀐다.

GitHub Actions 검사 이름은 harness-ci (ubuntu-latest)와 harness-ci (windows-latest)다. 서버에서 검사 이름과 GitHub Actions App을 필수로 지정하고 strict up-to-date와 우회 없는 보호를 확인해야 자동 병합할 수 있다.

결정 요청은 decision request KEY --file JSON으로 등록한다. 실제 사용자 답변과 출처는 decision resolve KEY --file JSON --revision N으로 기록한다. 설치된 Herdr 패널은 이 저장소의 업무·결정함과 현재 Lead를 읽는다.

최초 도입 QA는 후보 밖에 보관한 기준 commit·검증 계획·고정 release에서 판정하고 별도 bootstrap ID를 사용한다. .local/hh-harness/의 실제 v2 업무에는 그 조사·QA·게시 판정을 복사하지 않는다.
