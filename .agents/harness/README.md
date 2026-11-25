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

위임은 동결한 AC·검사와 보고서 위치를 전달한다. 고정 release가 [검증 계획 실행 위치 분류](../../README.md#검증-계획-실행-위치와-해소-결정-인계)를 지원하면(`planScopeVersion === 1`) 조사는 verification-plan.json에 checkScopes를 함께 쓰고, collect는 공통 freeze에 config.json의 qa_executors를 넘겨 동결한다(어댑터 필수 검사는 없다). 지원하지 않는 release에서는 기존 ID 배열 계획과 기존 지시서를 그대로 쓰고 새 조회를 부르지 않는다.

    {"run":"<토큰>","version":2,"criteria":["AC1","AC2"],"checks":["hh-focused","hh-policy-review"],
     "checkScopes":[
      {"id":"hh-focused","location":"independent-qa","executor":"node-test","command":"node --test test/self-harness.test.mjs","criteria":["AC1","AC2"]},
      {"id":"hh-policy-review","location":"independent-qa","executor":"git-read","command":"git diff <base> -- .agents/harness README.md","criteria":["AC2"]},
      {"id":"mobile-browser-copy","location":"follow-up","criteria":["AC2"],"environment":"배포 후 Galaxy Chrome","verify":"제목을 복사해 Teams에 붙여넣고 원문과 대조"}]}

HH의 독립 QA 실행 수단은 node-test(`node --test <test·mod 아래 .test.mjs 파일>`. 파일을 하나씩 적고 와일드카드는 동결에서 거부한다), git-read(`git diff|ls-files|show|log|grep` 읽기 명령. config.json 허용 목록의 조회 옵션과 리비전·경로만 받고 `--output`·`-O`·`--ext-diff`·`--no-index` 같은 옵션과 셸 확장 문자는 동결에서 거부한다)다. 이 밖의 검사(배포 후·실기기·브라우저·외부 계정)는 follow-up으로 적는다. follow-up의 environment·verify는 PR 본문에 그대로 싣는 일반 문장이며 링크·이미지 대괄호, 꺾쇠(HTML 태그·주석·`<URL>`), 백틱, HTML 엔티티가 있으면 동결을 거부한다. 매 위임 전에 이 업무의 해소 결정을 조회해 지시서에 `해소 결정: <JSON>`으로 넣는다. 조회는 run 폴더를 만들거나 대장을 바꾸기 전에 하며, 결정함을 읽지 못하면 위임하지 않는다. 결정이 계획과 충돌할 때의 재조사는 [LEAD.md](LEAD.md#해소-결정이-동결-계획과-충돌할-때)를 따른다.

### 시험 범위: 바뀐 파일 시험만(HH-020)

HH는 저장소 전체가 하네스이므로 자체 QA는 전체 suite 대신 «바뀐 파일 시험만» 실행한다(2026-11-24 사용자 결정). 조사는 예정 변경과 연결되는 기존 시험 파일(그 모듈의 시험, 모듈을 import하거나 실행하는 통합 시험, 바뀐 시험 파일 자체)을 경로 그대로 node-test 행 하나에 동결한다. 파일명 일치만으로 찾지 않는다. 예를 들어 .agents/harness/stages.mjs·hh.mjs에는 test/self-harness.test.mjs가 대응한다. 대응 시험이 없는 변경(문서 등)은 git-read 행 하나만으로 동결한다.

- 구현·수리 지시서: 바뀐 모듈에 대응하는 시험 파일만 `node --test <파일들>`로 실행하고, 대응 시험이 없으면 Git 읽기 명령(예: `git diff --stat <base>`)과 실제 종료 코드를 implement.json checks에 남긴다. 전체 suite·와일드카드·heavy·Docker·영수증 발급기는 실행하지 않는다.
- 독립 QA 지시서: 동결한 독립 QA 명령을 Windows 후보 worktree에서 적힌 그대로 실행하고, 동결한 시험 파일이 실제 변경 경로(`git diff --name-only <base>`)와 맞는지 대조한다. QA runner·QA 실행 영수증·hh-suite 로그·Docker Linux 실행은 없다.
- collect는 공통 수집(회차·후보·AC별 근거·검사 명령과 결과·결함)만으로 PASS를 받는다. 실패한 검사, 동결 검사 누락, 후보 변경은 계속 거부한다.
- 이 변경 전에 hh-suite 행을 동결한 업무는 hh-suite 실행 수단이 선언에서 빠졌으므로 flow-resume ID --stage research로 다시 동결한다. 동결된 계획을 임의로 고쳐 통과시키지 않는다.
- 감수한 위험: 전체 회귀를 PR 전에 잡지 못해 공통 release 배포 뒤 SW·VDP·VP에서 발견될 수 있다. 필요하면 Lead가 별도로 전체 suite를 heavy로 실행한다.

복구는 recover로 현재 연결된 실행을 조회하고, 차단 업무는 flow-resume ID --evidence "달라진 조건"으로 재개한다.

[QA 실행 영수증 v2](../../README.md#qa-실행-영수증과-ci-검증)의 발급기·검증기(core/qa-receipt-*, bin/qa-receipt.mjs, bin/verify-qa-receipt.mjs)는 다른 저장소가 쓰는 공통 기능이라 그대로 둔다. policy/qa-receipt.json도 공통 시험 fixture가 읽으므로 남기지만 **HH 자체 QA·CI는 사용하지 않는다.**

## 게시와 병합

Lead는 publish-check ID를 확인한 뒤 공통 launcher의 publisher-command ID가 돌려준 argv를 사용한다. 게시자는 같은 ID의 후보를 확인하고 승인된 파일만 명시적으로 stage한다. 로컬 커밋 뒤 publish-check ID --committed로 Git tree·변경 경로·mode·blob을 대조한다. 이 판정을 얻은 뒤 해당 업무 브랜치만 push하고 main을 대상으로 PR을 만든다. PR 본문에 원래 AC, 독립 QA 회차·후보·실행한 검사(바뀐 파일 시험 명령과 결과), 남은 검증을 기록한다. QA 실행 영수증 줄은 넣지 않는다.

publish-check는 remainingVerification(동결 계획의 후속 확인)과 decisions(이 업무의 해소 결정)를 함께 돌려준다. 게시자는 PR 본문의 «남은 검증» 절에 remainingVerification 각 항목의 line을 `- [ ] <line>` 목록 줄(들여쓰기 0~3칸)로 한 줄씩 그대로 넣고, 이 절을 raw HTML(`<details>` 등)·들여쓴 코드 블록보다 앞에 둔다. 줄을 고치거나 합친 줄, 순서 목록·표시 없는 줄, HTML 주석·속성 안의 줄, 그런 HTML 뒤의 줄은 PR 화면에 보이는지 확정할 수 없어 누락으로 판정된다. 인라인 코드·울타리 코드 안의 `<!--`는 문자 그대로라 판정에 영향이 없다. 판정 규칙은 [공통 README](../../README.md#qa와-남은-검증)를 따른다. 후속 확인이 없으면 이 절의 형식은 기존과 같다. flow-status도 같은 remainingVerification을 보여 준다.

publish-check는 QA 실행 영수증(qaReceipt)을 돌려주지 않는다. HH PR 본문에는 영수증 줄이 필요 없고 CI도 검사하지 않는다.

독립 QA PASS 뒤에 이 업무의 결정이 해소되면 그 결정은 PASS한 QA 지시서에 없었다. publish-check·flow-attach-pr·flow-close·flow-deliver(병합 증명 제외)는 Lead가 flow-resume ID --decision KEY --revision N으로 판정을 기록할 때까지 멈춘다. 계획을 바꾸는 결정이면 --stage research로 QA 판정·게시 허가를 철회하고 재조사로 돌린다. PR이 연결돼 있으면 철회 전에 조회해, 이미 병합됐거나 상태를 확정할 수 없으면 거부하고 대장을 그대로 둔다(flow-prove-merged로 증명한 뒤 결정은 후속 업무). 절차는 [LEAD.md](LEAD.md#해소-결정이-동결-계획과-충돌할-때)에 있다.

    ## 남은 검증
    - [ ] mobile-browser-copy (AC2) | 환경: 배포 후 Galaxy Chrome | 확인: 제목을 복사해 Teams에 붙여넣고 원문과 대조

Lead는 flow-attach-pr ID --pr N으로 실제 PR을 대장에 연결한다. 연결 전에 gh pr view의 실제 body를 대조해 남은 검증 줄이 하나라도 빠지면 빠진 줄을 알려 주고 대장을 바꾸지 않는다. 연결 뒤 본문에서 줄을 지우면 flow-deliver의 병합 전 확인이 blocked로 막는다. flow-deliver ID는 현재 후보와 CI·보호 규칙을 확인한다. flow-deliver ID --apply 또는 watch-delivery ID는 열린 결정이 없고 공통 DEV-14 조건이 충족됐을 때만 squash한다. 이미 병합된 PR은 flow-prove-merged ID로 읽기 전용 증명을 확인한다. 최초 게시 anchor, 최종 head의 CI, squash 부모와 tree, GitHub main 포함이 확인되면 대장이 DONE으로 바뀐다.

PR을 만들지 않기로 승인된 업무는 flow-close ID --evidence "승인 출처와 적용 이유"로 정책 예외 종결한다. 등록된 Lead만 실행하며, 업무가 독립 QA PASS 후 publish 단계에 있고 활성 실행·열린 결정·판정을 기록하지 않은 QA 이후 해소 결정·연결된 PR이 없으며 현재 후보(지문·tree)가 QA PASS 보고의 후보와 같을 때만 DONE이 된다. 실행 영수증은 요구하지 않는다. 대장에는 phase=closed와 x_flow.closure(kind=policy-exception, 시각, Lead 터미널, 근거, 직전 phase, QA 판정)가 남아 병합 증명(phase=merged)과 구분된다. 후속 확인이 있으면 PR 대신 closure.remainingVerification에 남는다. PR이 이미 연결된 업무는 병합 증명 절차를 따른다.

    node .agents/harness/launch.mjs flow-close HH-123 --evidence "사용자 승인(대화 2026-01-01): PR 없는 검증 업무"

게시·병합 권한 없이 로컬·QA까지만 하는 업무는 add에서 --authorization을 생략한다(x_flow.authorization=null). 독립 QA PASS 뒤 게시 없이 멈추고 publish-check·flow-attach-pr·flow-close를 거부한다. Lead가 flow-close-local ID --evidence "종결 근거"로 닫는다. 후보·결정 조건은 flow-close와 같고 사용자의 정책 예외 승인은 필요 없다. 대장에는 phase=closed와 x_flow.closure(kind=local-only, published=false, merged=false, 근거, 남은 검증)가 남고, 정리는 예외 종결과 같이 후보 patch와 브랜치를 보존한다. 나중에 게시하려면 권한을 받은 새 업무로 등록한다.

    node .agents/harness/launch.mjs flow-close-local HH-123 --evidence "로컬 확인까지만 요청, 독립 QA PASS"

## 끝난 업무 정리

DONE이 되면 같은 Lead 잠금 안에서 공통 [worktree 정리](../../README.md#끝난-업무-worktree-정리)를 한 번 부른다. 호출 시점은 flow-deliver ID --apply(watch-delivery 포함)와 flow-prove-merged ID가 병합을 증명했을 때, flow-close ID가 예외 종결했을 때, flow-close-local ID가 로컬 종결했을 때다. 미병합·차단·조회 전용 결과에는 부르지 않는다. 명령 응답에 cleanup 항목이 붙고 대장의 x_cleanup과 x_cleanup 사건에 같은 결과가 남는다. 결과가 이전과 같으면 다시 기록하지 않는다.

- 정리가 거부되거나 실패해도 DONE·병합 증명·예외 종결은 되돌리지 않고 명령의 종료 코드도 바꾸지 않는다. cleanup에는 status(done·refused·partial·failed), 사유, 남은 worktree·브랜치, 재시도 명령이 있다. failed는 binding·release 문제처럼 공통 정리를 실행하지 못한 경우다.
- 병합 업무는 worktree를 지운 뒤 로컬 업무 브랜치를 -d, 거부되면 증명 조건을 다시 확인해 -D로 지운다. 예외 종결 업무는 미커밋 후보를 .local/hh-harness/tasks/ID/worktree-*.patch로 보존하고 브랜치를 남긴다.
- config.json의 cleanup.keep_ignored(target/hh-verify/)는 상태 폴더의 tasks/ID/artifacts/에 보관한 뒤 지우고, cleanup.discard_ignored(dist/, mod/harness/contract.js, mod/harness/decisions.js)는 생성물로 보고 그대로 지운다. 그 밖의 무시 파일이 있으면 정리를 거부한다.
- 정리는 status가 깨끗하다는 것만 믿지 않고 사전검사와 worktree remove 직전에 추적 파일 전체의 내용 해시를 index blob과 비교하고, worktree 폴더를 링크를 따라가지 않고 순회해 모든 항목이 추적 파일이나 위 keep·discard·과정 문서로 설명되는지 대조한다. .git 이름 항목(중첩 저장소), 확인된 추적 링크(index mode 120000이고 status가 보고하지 않으며 링크 대상=index blob)가 아닌 링크·junction(discard 폴더 안, 예외 종결 후보 경로 포함), worktree 전용 ref(refs/worktree·refs/bisect·refs/rewritten), 진행 중인 병합·rebase 등이 있으면 지우지 않는다. 후보 되돌리기(git checkout)와 worktree remove처럼 Git이 경로를 지우는 단계 직전에는 대상 경로와 worktree 안 상위 구성요소가 링크·junction이 아닌지 lstat으로 다시 보고, 아니면 멈춘다. 이 확인의 한도는 config.json의 cleanup.content_ms(60000ms)다. DONE 직후 자동 정리가 watch-delivery 한 회(180초) 안에 끝나게 한 값이다. 한도를 넘으면 지우지 않고 refused로 남긴다. 아래 재시도 명령은 cleanup.retry_content_ms(600000ms)를 쓴다.
- 이미 DONE인 업무, 거부·부분 완료된 정리는 Lead가 아래 명령으로 다시 실행한다. 보관된 업무(x_archive)와 열린 결정이 있는 업무는 거부한다. 정리가 끝나지 않으면 종료 코드 1이다.

      node .agents/harness/launch.mjs cleanup-worktree HH-123

collect는 단계 보고를 정상 수집해 회차를 저장한 뒤 그 회차의 위임 터미널을 hc kill로 닫는다. 대장에 기록된 주소이고 harness.task·harness.run 레이블이 그 회차와 같을 때만이다. Lead 터미널, 다른 업무 터미널, 레이블 불일치, 조회 실패, 아직 working인 에이전트는 닫지 않고 회차의 x_terminal에 사유를 남긴다(outcome=kept). kill 뒤에는 응답과 무관하게 다시 조회한다. 종료나 제거(not_found)를 확인하면 killed(after=finished·removed), 여전히 live면 still-live, 조회에 실패하면 unknown이다. finished로 확인한 터미널(처음부터 끝나 있던 터미널 포함)은 hc rm으로 목록에서도 지우고 removed=true, 실패하면 removed=false와 rm 사유를 남긴다. 종료 실패는 수집 결과를 되돌리지 않는다. 남긴 터미널(kept·still-live·unknown·rm 실패)은 같은 업무의 다음 위임(next --go·dispatch) 직전, DONE 뒤 정리(병합 증명·정책 예외·승인 병합 종결과 cleanup-worktree 재시도)의 활동 조회 전, FAILED 업무는 그 뒤의 Lead 명령마다 다시 닫는다. 이때는 회차가 이미 끝났으므로 working이어도 닫으며, 대장 주소·레이블 확인과 Lead 제외는 같다. 결과는 그 회차의 x_terminal에 갱신한다. 게시자 세션은 대장에 회차·레이블이 없어 정체를 확인할 수 없으므로 자동 종료 대상이 아니다. Lead가 flow-attach-pr 뒤 직접 닫는다. 게시자 세션이 worktree를 cwd로 잡고 있으면 Windows에서는 정리가 «사용 중»으로 거부된다.

GitHub Actions 검사 이름은 harness-ci (ubuntu-latest)와 harness-ci (windows-latest)다. 서버에서 검사 이름과 GitHub Actions App을 필수로 지정하고 strict up-to-date와 우회 없는 보호를 확인해야 자동 병합할 수 있다. 보호 규칙이 이 이름을 필수로 볼 수 있어 job 이름은 유지하고, 단계는 `node scripts/build.mjs` 하나(수 초)만 실행한다(PR 이벤트에서만 실행한다. main push 검사는 없다). 영수증 검사·전체 시험은 없고 검사를 더하지 않는다.

결정 요청은 decision request KEY --file JSON으로 등록한다. 실제 사용자 답변과 출처는 decision resolve KEY --file JSON --revision N으로 기록한다. 사용자가 선택지를 골랐으면 답변 JSON에 그 label을 selection으로 넣는다(예: `{"quote":"[사용자 결정 · Herdr 하네스 모드] 질문 browser-check(revision 1)의 답: \"배포 후 실기기 확인\"","source":"Herdr 하네스 모드 사용자 선택","selection":"배포 후 실기기 확인"}`). 설치된 Herdr 패널은 이 저장소의 업무·결정함과 현재 Lead를 읽는다.

최초 도입 QA는 후보 밖에 보관한 기준 commit·검증 계획·고정 release에서 판정하고 별도 bootstrap ID를 사용한다. .local/hh-harness/의 실제 v2 업무에는 그 조사·QA·게시 판정을 복사하지 않는다.
