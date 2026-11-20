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
