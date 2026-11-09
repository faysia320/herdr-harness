# Herdr Harness

개인 AI 개발 하네스의 공통 결정함, 실행 진입점, Herdr mod를 함께 관리한다. 프로젝트의 승인·QA·스케줄링 정책과 실제 업무 데이터는 각 프로젝트에 남긴다.

Herdr 패널은 모든 로컬 저장소 공간에 표시한다. `projects.json`에 등록된 smart-workspace, vms-design-platform, v-project는 브리핑과 Git Tree를 제공하고, 나머지는 Git Tree 탭만 제공한다. 일반 저장소는 별도 등록 없이 공간의 첫 터미널 현재 경로를 사용한다. 전체 저장소 보기는 등록된 하네스 프로젝트에서만 제공한다.

## 관리 경계

| 여기에서 한 번 관리 | 프로젝트에서 관리 | 로컬에만 보관 |
|---|---|---|
| 질문 등록·수정·해소와 revision | 조사·구현·QA·architect 스킬 | `projects.json`, 설치 계획 |
| 결정함 검증·원자 저장 | 모델·effort·Fast·실행 프로필 | 고정 release 경로와 binding |
| mod 브리핑·Git Tree·Fetch/Pull | 승인 근거·후보 지문·겹침·재시도 | 대장·결정 기록·실행 로그·인증 |
| 실행 결과·timeout·설치/복구 | 기존 CLI와 대장 writer·잠금 | UI 읽음 상태와 개인 설정 |

세 프로젝트의 스케줄러를 동일한 알고리즘으로 바꾸는 작업은 포함하지 않는다. Python의 안내 전용 `next`, JS의 자동 실행·예약 겹침 검사를 유지한다. 공통 launcher가 실제 회사 CLI를 실행하고, 기존 CLI의 `decision` 명령이 같은 공통 저장기를 호출한다. mod도 같은 순수 검증기를 사용한다.

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

지원 fixture 이름은 `sw`, `vp`(kind `python`), `vdp`다. 실제 AI·공유 DB·운영 대장을 쓰지 않는다. 기존 회사 하네스 회귀 시험도 해당 checkout에서 실행한다. SW 결정함 회귀에는 build가 반환한 release 경로를 `HERDR_HARNESS_TEST_RELEASE`로 지정한다.

## 설치·업데이트

1. `examples/install.example.json`을 `.local/install.json`으로 복사해 로컬 경로를 채운다. 프로젝트 `command`는 공통 bridge가 연결된 실제 CLI를 가리켜야 한다. 설치 대상 mod는 `harness`다.
2. 테스트를 통과한 뒤 `node scripts/install.mjs .local/install.json`을 실행한다. `harness`와 같은 상위 폴더의 `harness-auto`도 함께 설치·백업·검증한다. 기존 layout의 `harness-auto` 블록이 공간 전환에 맞춰 패널을 표시한다.
3. staging native check → 소스·binding 백업 → 설치 → native check를 통과하면 active 기록을 바꾼다. `node scripts/verify-install.mjs <store>`로 실제 설치 파일 지문을 검증한다.
4. 기존 Lead가 새 CLI와 프로젝트의 `COMMON.md` 지침을 사용하는지 별도로 확인한다. 설치는 Lead에 메시지를 보내거나 현재 업무를 재시작하지 않는다.

각 상태 폴더의 `harness-binding.json`은 release 경로·manifest 지문·project ID·기존 CLI command/cwd만 담는다. 업무 내용·인증 정보는 넣지 않는다. 설치 프로그램은 프로젝트의 추적 파일을 수정하지 않으므로 회사 adapter 변경은 별도 브랜치로 검토·게시한다.

기존 `projects.json`은 보존하고 처음 설치에만 빈 설정을 만든다. 예시는 `examples/projects.example.json`이다. 업무 대장·결정 기록·Herdr 읽음 상태는 설치와 복구가 건드리지 않는다. 소스를 수정해도 설치본은 자동으로 바뀌지 않는다. 검증 후 명시적으로 재설치한다.

```powershell
node <release>/bin/harness.mjs --binding <상태폴더>/harness-binding.json decision list
node scripts/rollback.mjs <store>
```

rollback은 직전 소스·binding을 복원한다. 설치 이후 수동 변경이 있으면 덮어쓰지 않고 거부한다. 새 질문이나 사용자 설정은 되돌리지 않는다. 로컬 백업에는 이전 개인 파일 내용이 있으므로 store를 Git에 넣지 않는다.

## 결정함 규칙

현재 대장에 등록된 살아 있는 Lead가 `decision request KEY --file 질문.json`으로 먼저 등록한다. 질문은 `question`, `source`, 선택 `task`, `kind`, `options`, `reason`, `recommendation`으로 구성한다. 업무 등록 전에는 `task:null`, DONE 이후에도 후속 질문을 남길 수 있다.

질문을 수정할 때는 `--revision 현재값`을 요구한다. 해소는 실제 답변의 `quote`와 `source`를 담은 파일로 `decision resolve KEY --file 답변.json --revision 질문revision`을 실행한다. 같은 입력의 재시도는 멱등적이다. 읽음·다른 업무 완료·Lead 새 보고는 해소 근거가 아니다. 결정함 해소는 업무 승인이나 Git 작업을 대신하지 않는다.

읽기 오류·다른 프로젝트·설치 변조는 정상적인 빈 결정함으로 취급하지 않는다. 입력 파일과 설치본이 유효하지 않으면 기존 기록을 보존하고 실패한다. 상태 파일의 기록 크기는 mod 읽기 한도인 1 MiB를 넘기지 않는다.
