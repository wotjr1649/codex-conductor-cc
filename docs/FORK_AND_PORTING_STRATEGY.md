# Codex Conductor Fork 및 점진적 포팅 전략

## 1. 문서 목적

이 문서는 `openai/codex-plugin-cc`를 기반으로 비공식 안정화 Fork를 만들고,
필요한 경우 런타임 코어를 Go로 점진적으로 교체하기 위한 의사결정과 실행
계획을 정리한다.

실제 구현은 별도 PC에서 진행한다. 따라서 이 문서의 명령, 버전, 저장소
상태는 실행 시점에 다시 확인해야 한다.

## 2. 최종 결정

전면 재작성보다 공식 저장소를 먼저 Fork한다.

> **Fork-first, Go-core-later**

초기에는 기존 Claude Code 플러그인 구조와 `/codex:*` 명령 호환성을
유지한다. Node.js 구현을 안정화하고 외부 계약과 회귀 테스트를 확정한
뒤, 문제가 집중된 런타임 코어만 Go로 단계적으로 교체한다.

Rust 전면 포팅은 현재 프로젝트의 규모와 요구에 비해 복잡도가 크므로
우선 선택하지 않는다.

## 3. 프로젝트 이름

| 대상 | 값 |
|---|---|
| 제품명 | **Codex Conductor** |
| GitHub 저장소 | `<GH_ID>/codex-conductor-cc` |
| Marketplace 이름 | `codex-conductor` |
| Claude Code 플러그인 이름 | `codex` |
| 명령 namespace | `/codex:*` |
| 향후 네이티브 바이너리 | `codex-conductor` |
| 초기 버전 | `0.1.0` |
| Upstream | `openai/codex-plugin-cc` |
| 환경 변수 접두사 | `CODEX_CONDUCTOR_*` |

권장 슬로건:

> Orchestrate Codex reliably from Claude Code.

권장 GitHub 설명:

> A hardened, unofficial Codex orchestration plugin for Claude Code.

`conductor`는 코드 리뷰, 작업 위임, 백그라운드 작업, 세션 이전과 프로세스
감독을 함께 조율한다는 프로젝트의 역할을 포괄한다.

## 4. 왜 Fork를 먼저 하는가

현재 프로젝트의 핵심 문제는 JavaScript 문법이나 npm 의존성보다 실행
모델에 있다.

- 상태 파일의 동시 갱신과 원자성
- 브로커 생성 및 종료 수명주기
- 세션별 소유권과 lease 관리
- 백그라운드 작업의 heartbeat, timeout 및 복구
- Windows 경로 정규화와 프로세스 트리 종료
- Codex app-server 연결 손실과 재개

Go나 Rust로 언어만 바꿔도 이 문제가 자동으로 해결되지는 않는다. 기존
동작을 테스트와 데이터 계약으로 먼저 고정해야 포팅 과정에서 개선과
회귀를 구분할 수 있다.

Fork를 먼저 선택하면 다음 자산을 유지할 수 있다.

- 기존 Claude Code 명령과 사용자 경험
- 공식 저장소의 변경 이력과 Fork 관계
- 기존 테스트, fixture 및 prompt
- upstream 변경사항 추적과 선택적 기여
- Codex app-server 프로토콜 생성 절차

## 5. 왜 장기적으로 Go인가

향후 네이티브 런타임이 필요하다는 근거가 확보되면 Go를 우선한다.

이 프로젝트의 핵심 런타임 작업은 다음과 같다.

- 외부 프로세스 실행과 취소
- JSON-RPC 및 JSONL 처리
- 로컬 소켓 통신
- 작업 큐와 timeout
- 상태 파일 저장
- 로그 스트리밍
- OS별 프로세스 제어

Go는 `context`, goroutine, 표준 라이브러리 중심으로 이 요구를 비교적
단순하게 구현할 수 있고, 단일 바이너리와 크로스 플랫폼 배포에도
적합하다.

Rust는 다음 조건이 생겼을 때 재검토한다.

- 팀의 주력 언어가 Rust가 됨
- 고처리량 다중 사용자 서버로 발전함
- 극도로 세밀한 자원 제어가 필요함
- Codex의 Rust 코드와 동일 workspace에서 직접 통합해야 함

## 6. 목표 아키텍처

```text
Claude Code
 ├─ commands/*.md
 ├─ agents/*.md
 ├─ hooks/hooks.json
 └─ .claude-plugin/plugin.json
             │
             ▼
     Cross-platform launcher
             │
             ▼
       Go Runtime Core
 ├─ CLI argument parser
 ├─ Codex app-server JSON-RPC client
 ├─ Broker / process supervisor
 ├─ Durable job state machine
 ├─ Atomic state store
 ├─ Session ownership / lease manager
 ├─ Git review adapter
 ├─ Claude session import adapter
 └─ Platform layer
      ├─ Windows Job Object
      └─ Unix process group / signals
             │
             ▼
       local codex app-server
```

Claude Code 플러그인 외피는 유지한다.

- `.claude-plugin/plugin.json`
- Marketplace 설정
- slash command Markdown
- agent Markdown
- hook 선언 JSON
- prompt template
- review output schema

Go 교체 후보는 런타임 책임에 한정한다.

- Codex app-server 클라이언트
- 브로커 및 수명주기 관리
- 작업 registry와 상태 저장
- 프로세스 supervisor
- foreground/background 실행기
- 일부 Git 및 세션 이전 adapter

## 7. 보안 및 신뢰 경계

민감 표면은 플러그인 훅, 로컬 프로세스 실행, 작업 상태 파일, Codex
app-server 통신이다.

```text
Claude Code
    │ 비신뢰 작업 입력, 경로, 환경 및 hook payload
    ▼
Codex Conductor
    │ JSON-RPC/JSONL, 프로세스 및 파일 시스템 경계
    ▼
local codex app-server
```

구현 시 다음 오용 사례를 방어해야 한다.

- 문자열 결합을 통한 명령 또는 인자 주입
- 경로 정규화 오류에 의한 잘못된 파일 접근
- 경쟁 상태에 의한 작업 상태 손상 또는 유실
- PID 재사용으로 무관한 프로세스를 종료
- 세션 종료가 다른 세션의 공유 브로커를 종료
- 연결 손실 후 detached worker가 무기한 생존
- 로그나 상태 파일에 자격 증명 또는 민감한 경로가 노출

필수 완화 원칙:

- 셸 문자열보다 실행 파일과 인자 배열을 사용한다.
- 상태 갱신은 lock과 atomic replace를 적용한다.
- PID만 믿지 않고 instance nonce 또는 process start token을 함께 확인한다.
- Windows는 Job Object, Unix는 process group 기반으로 자식 트리를 관리한다.
- owner lease, active job, idle timeout을 모두 확인한 후 브로커를 종료한다.
- 모든 timeout과 강제 종료에는 단계적 escalation과 상한을 둔다.
- 로그와 진단 결과에서 비밀값을 기록하지 않는다.

구현이 인증, 권한, 외부 네트워크 송신 또는 임의 명령 실행 범위를
확장한다면 별도의 전체 보안 검토를 수행한다.

## 8. Fork 및 Clone 절차

원본 파일을 복사하거나 `.git`을 제거해 새 저장소를 만들지 않는다.
GitHub의 공식 Fork 관계를 유지한다.

```powershell
gh auth status

gh repo fork openai/codex-plugin-cc `
  --fork-name codex-conductor-cc `
  --clone=false

gh repo clone <GH_ID>/codex-conductor-cc
Set-Location .\codex-conductor-cc
git remote -v
```

목표 remote 구성:

```text
origin    https://github.com/<GH_ID>/codex-conductor-cc.git
upstream  https://github.com/openai/codex-plugin-cc.git
```

`upstream`이 없다면 추가한다.

```powershell
git remote add upstream https://github.com/openai/codex-plugin-cc.git
git config remote.pushDefault origin
git config push.default current
```

Fork 생성, 저장소 이름 변경, remote 수정, push 등 원격 변경 작업은 실행
전에 대상 계정과 저장소를 다시 확인한다.

## 9. 초기 기준점 기록

실제 구현을 시작하는 날 upstream을 다시 조회한다.

```powershell
git fetch upstream --tags --prune
git rev-parse upstream/main
git tag --list
```

확인할 정보:

- Fork 시작일
- upstream commit
- upstream release 또는 package version
- 지원할 Codex CLI 최소 버전
- Node.js 최소 버전
- LICENSE와 NOTICE 상태

기준 태그가 필요하면 확인한 날짜를 사용한다.

```powershell
git tag -a upstream-base-YYYYMMDD upstream/main `
  -m "Initial upstream base from openai/codex-plugin-cc"
git push origin upstream-base-YYYYMMDD
```

태그 push는 원격 변경이므로 실제 실행 전에 승인과 대상을 확인한다.

## 10. Fork 신원 변경

첫 변경은 기능 추가가 아니라 downstream 신원 확립에 한정한다.

권장 커밋:

```text
chore(fork): establish Codex Conductor downstream identity
```

주요 변경 대상:

- `package.json`
- `.claude-plugin/marketplace.json`
- `plugins/codex/.claude-plugin/plugin.json`
- `README.md`
- `docs/UPSTREAM.md`
- `CHANGELOG.md`

원칙:

- 패키지와 Marketplace에서 OpenAI 공식 소유자로 오인될 표현을 제거한다.
- Marketplace 이름은 `codex-conductor`로 변경한다.
- 플러그인 이름 `codex`와 `/codex:*` 명령은 유지한다.
- 초기 버전은 `0.1.0`으로 시작한다.
- `private: true`는 npm 배포 계획이 없다면 유지한다.

README 상단에 다음 의미의 고지를 포함한다.

```markdown
> [!IMPORTANT]
> Codex Conductor is an unofficial downstream fork of
> `openai/codex-plugin-cc`.
>
> It is not affiliated with or endorsed by OpenAI or Anthropic.
> Original copyright and attribution notices are retained under
> the Apache License 2.0.
```

공식 `codex` 플러그인과 동시에 설치하면 `/codex:*` 명령이 겹칠 수
있으므로 drop-in replacement라는 점도 안내한다.

## 11. 초기 디렉터리 구조

upstream 병합 충돌을 줄이기 위해 기존 구조를 최대한 유지한다.

```text
codex-conductor-cc/
├── .claude-plugin/
├── plugins/
│   └── codex/
├── scripts/
├── tests/
├── docs/
│   ├── UPSTREAM.md
│   ├── ARCHITECTURE.md
│   ├── ROADMAP.md
│   └── FORK_AND_PORTING_STRATEGY.md
├── CHANGELOG.md
├── LICENSE
├── README.md
├── package.json
└── package-lock.json
```

초기에 기존 Node 파일을 별도 `runtime/node` 디렉터리로 이동하지 않는다.
대규모 파일 이동은 upstream 동기화 충돌을 불필요하게 키운다.

Go 실험을 시작할 때만 최소 구조를 추가한다.

```text
native/
├── go.mod
├── cmd/
│   └── codex-conductor/
│       └── main.go
└── internal/
    ├── appserver/
    ├── broker/
    ├── jobs/
    ├── state/
    ├── protocol/
    └── platform/
```

실제 패키지는 책임이 분리될 필요가 확인될 때만 만든다. 미래 사용을
가정한 인터페이스, factory 또는 추상화는 미리 추가하지 않는다.

## 12. 브랜치 전략

별도 `develop` 브랜치를 두지 않고 짧은 수명의 작업 브랜치를 사용한다.

```text
main
├── sync/upstream-YYYYMMDD
├── fix/state-atomic-write
├── fix/broker-lifecycle
├── fix/windows-path-normalization
├── fix/windows-process-tree
├── feat/job-watchdog
├── feat/session-lease
└── exp/go-runtime
```

| 브랜치 | 역할 |
|---|---|
| `main` | 검증된 사용 가능 버전 |
| `sync/upstream-*` | upstream 동기화 |
| `fix/*` | 독립적인 버그 수정 |
| `feat/*` | 검증 가능한 기능 추가 |
| `exp/*` | 호환성이 보장되지 않은 실험 |
| `release/*` | 실제 릴리스 안정화가 필요할 때만 생성 |

Fork 전용 변경과 upstream에 다시 기여할 일반 수정은 섞지 않는다.
upstream 기여 후보는 `upstream/main`에서 별도 브랜치를 만든다.

```powershell
git fetch upstream
git switch -c upstream/fix-windows-paths upstream/main
```

이 브랜치에는 Fork 브랜딩, Marketplace 변경, Go 런타임 또는 독자적인
버전 정책을 포함하지 않는다.

## 13. Upstream 동기화

`main`에서 직접 병합하지 않고 동기화 전용 브랜치를 사용한다.

```powershell
git fetch upstream --tags --prune
git switch main
git pull --ff-only origin main
git switch -c sync/upstream-YYYYMMDD
git merge --no-ff upstream/main
```

충돌 해결 후 저장소가 실제로 제공하는 스크립트를 확인하고 가장 작은
검증부터 실행한다.

예상 검증 예시:

```powershell
npm ci
npm run build
npm test
```

명령 이름과 요구되는 Codex CLI 버전은 실행 시점의 `package.json`,
README와 CI 설정을 기준으로 확정한다.

## 14. 단계별 로드맵

### v0.1.0 — Fork Bootstrap

목표는 기능을 바꾸지 않고 독립 프로젝트로 만드는 것이다.

- Fork 신원 및 브랜딩 변경
- 비공식 downstream 고지
- 라이선스와 귀속 고지 유지
- upstream 추적 정책 문서화
- 기존 빌드와 테스트 기준선 확보
- Windows, Linux, macOS CI
- 공식 버전과 동일한 동작 확인

완료 조건:

- clean clone에서 의존성 설치, 빌드 및 테스트가 통과한다.
- 공식 플러그인과 동일한 주요 명령을 실행할 수 있다.
- upstream 기준 commit과 지원 버전이 기록되어 있다.
- Fork 전용 변경이 하나의 검토 가능한 범위로 정리되어 있다.

### v0.2.0 — Runtime Hardening

Go를 추가하기 전에 기존 Node 런타임의 근본 문제를 수정한다.

우선순위:

1. 상태 파일 atomic write
2. 상태 갱신 직렬화 또는 파일 lock
3. 브로커 중복 생성 방지
4. session owner lease와 reference count
5. Windows extended-length, UNC 및 drive-letter 경로 정규화
6. Windows Job Object와 Unix process group 기반 프로세스 트리 종료
7. background worker heartbeat
8. 작업 timeout과 stall 감지
9. 비정상 종료 후 orphan 판정과 복구
10. 결정론적인 JSON 결과

각 수정은 먼저 하나의 재현 가능한 회귀 테스트로 고정한 뒤 최소한의
공유 경로에서 수정한다.

### v0.3.0 — Go Runtime Preview

Node 구현의 외부 계약을 먼저 고정한다.

- task request와 result
- status와 cancel
- broker protocol
- state schema
- log event
- exit code
- thread 및 turn 식별자

권장 교체 순서:

1. 상태 저장소
2. 작업 registry
3. 프로세스 supervisor
4. 브로커
5. Codex app-server JSON-RPC client
6. background worker
7. foreground/background CLI
8. Git review adapter
9. Claude session transfer

전환 기간에는 Node와 Go 구현을 선택할 수 있게 한다.

```text
CODEX_CONDUCTOR_RUNTIME=node
CODEX_CONDUCTOR_RUNTIME=go
```

이 선택 옵션은 실제 병행 운영이 필요할 때만 추가한다. Go preview가
단일 실험 경로로 충분하다면 환경 변수와 fallback 코드를 미리 만들지
않는다.

### v1.0.0 — Native Runtime Default

다음 조건을 모두 만족한 후에만 Go 런타임을 기본값으로 전환한다.

- 공식 명령의 동작 동등성
- Windows, Linux, macOS 통합 테스트
- 동시에 여러 Claude Code 세션 실행
- 브로커 crash 후 복구
- 상태 파일 손상 대응
- background 작업 timeout과 stall 감지
- 취소 시 전체 프로세스 트리 종료
- Node와 Go 결과 schema 일치
- 최소 한 번 이상의 upstream 동기화 성공

## 15. 작업 상태 모델

기본 상태 후보:

```text
queued
  └─ starting
       └─ running
            ├─ succeeded
            ├─ failed
            ├─ degraded
            ├─ cancelled
            ├─ timed_out
            └─ orphaned
```

`degraded`는 실제로 사용자에게 의미 있는 부분 성공 상태가 확인될 때만
도입한다. 예:

- write 작업이 성공으로 보고됐지만 변경 파일이 없음
- Codex 결과는 받았지만 최종 로그 저장이 실패함
- 작업은 끝났지만 필수 검증을 실행하지 못함

상태 수가 늘어날수록 복구와 UI 처리 비용도 증가하므로 구분 가능한 후속
행동이 없는 상태는 추가하지 않는다.

권장 작업 기록 필드:

```json
{
  "schemaVersion": 1,
  "jobId": "task-123",
  "status": "running",
  "workerInstanceId": "generated-instance-id",
  "threadId": "codex-thread-id",
  "turnId": "turn-id",
  "heartbeatAt": "ISO-8601 timestamp",
  "lastProgressAt": "ISO-8601 timestamp",
  "deadlineAt": "ISO-8601 timestamp",
  "touchedFiles": [],
  "diagnostics": []
}
```

실제 구현 전에는 각 필드가 복구나 사용자 행동에 필요한지 검증한다.

## 16. Codex app-server 프로토콜 전략

Codex app-server의 공개 프로토콜 경계를 유지하고 Codex 내부 구현체에
직접 결합하지 않는다.

```text
codex app-server schema/type generation
                    │
                    ▼
          versioned schema snapshot
                    │
                    ▼
             generated Go types
                    │
                    ▼
       handwritten compatibility adapter
```

검토할 정책:

- 지원 Codex 최소 버전 명시
- 현재 및 직전 지원 버전 contract test
- 알 수 없는 notification 처리 정책
- 필수 response field 누락 시 명시적 오류
- initialize capability negotiation
- JSONL golden fixture
- 실제 Codex CLI와의 통합 contract test

프로토콜 생성 명령과 산출물 경로는 사용 중인 Codex CLI 버전에서 공식
도움말 또는 문서를 통해 다시 확인한다.

## 17. 검증 전략

작은 검증부터 시작하고 변경 범위에 따라 넓힌다.

### 문서 및 Fork 신원 변경

- JSON 파일 구문 검사
- Markdown 링크와 설치 명령 검토
- 버전 값의 일관성
- LICENSE와 NOTICE 보존
- OpenAI 공식 프로젝트로 오인될 표현이 없는지 검토

### 상태 저장

- concurrent writer 회귀 테스트
- 중간 crash 후 JSON 무결성
- 임시 파일 write, flush 및 atomic replace
- lock 획득 실패와 timeout

### 브로커 및 작업 수명주기

- 동시 시작 시 단일 브로커만 생성
- owner가 남아 있을 때 브로커가 종료되지 않음
- 마지막 owner와 active job이 없을 때만 idle 종료
- crash 후 stale state reconciliation
- timeout, cancel 및 강제 종료의 상태 전이

### 플랫폼

- Windows extended-length 및 UNC 경로
- drive-letter 대소문자
- PowerShell, cmd.exe 및 Git Bash 호출 경계
- Windows Job Object 자식 종료
- Unix process group 및 signal escalation

### Go 동등성

동일 fixture에 대해 Node와 Go 구현의 다음 결과를 비교한다.

- exit code
- JSON 결과
- 상태 전이
- 이벤트 순서
- touched files
- thread와 turn 식별자
- cancel 결과
- 실행 후 고아 프로세스 존재 여부

대규모 전체 테스트는 한 번에 실행하지 않고 저장소 정책에 맞게 worker와
메모리를 제한한다.

## 18. 권장 초기 커밋 순서

```text
1. chore(fork): establish Codex Conductor downstream identity
2. docs: document upstream tracking and compatibility policy
3. ci: establish cross-platform upstream baseline
4. test(state): cover concurrent state updates
5. fix(state): make state updates atomic and serialized
6. test(broker): cover concurrent broker startup and shutdown
7. fix(broker): add ownership leases and idle shutdown
8. test(windows): cover path and process-tree edge cases
9. fix(windows): normalize paths and supervise process trees
10. feat(jobs): add heartbeat, timeout and recovery
```

각 커밋은 한 가지 논리적 목적만 가져야 한다. Fork 브랜딩, 동작 변경,
대규모 formatting을 같은 커밋에 섞지 않는다.

## 19. 구현 PC에서 시작할 때 확인할 체크리스트

### 저장소

- [ ] GitHub 계정과 목표 Fork 이름 확인
- [ ] Fork 관계를 유지해 저장소 생성
- [ ] `origin`과 `upstream` URL 확인
- [ ] upstream 기본 브랜치 확인
- [ ] 시작 commit과 날짜 기록

### 도구

- [ ] Git 및 GitHub CLI 버전 확인
- [ ] Node.js와 npm 요구 버전 확인
- [ ] Codex CLI 설치 및 app-server 지원 여부 확인
- [ ] Go 도입 전 실제 필요성과 범위 재확인

### 기준선

- [ ] 변경 전 clean clone 빌드
- [ ] 변경 전 테스트
- [ ] 주요 `/codex:*` 명령 smoke test
- [ ] Windows/Linux/macOS CI 요구사항 확인
- [ ] 기존 open issue와 upstream PR 상태 재확인

### 보안

- [ ] hook 입력과 CLI 인자를 비신뢰 입력으로 처리
- [ ] 셸 문자열 실행 최소화
- [ ] 로그와 fixture에 비밀값이 없는지 확인
- [ ] 상태 파일 권한과 저장 위치 확인
- [ ] 프로세스 종료 대상의 instance identity 확인
- [ ] 외부 네트워크 송신이 생기면 별도 보안 검토

## 20. 이번 계획에서 의도적으로 제외한 것

다음 항목은 필요성이 입증되기 전까지 만들지 않는다.

- 전면 Rust 재작성
- 장기 `develop` 브랜치
- 초기 단계의 대규모 디렉터리 재구성
- 단일 구현을 위한 interface와 factory
- 필요가 확인되지 않은 설정 계층
- Node와 Go 이중 런타임을 위한 복잡한 fallback
- 별도 daemon 또는 외부 데이터베이스

## 21. 미검증 사항

이 문서는 이전 설계 대화를 정리한 계획 문서다. 다음 항목은 구현 시점의
공식 저장소와 문서에서 다시 확인해야 한다.

- upstream의 최신 commit과 package version
- 기존 issue와 PR의 현재 상태
- Claude Code 플러그인 hook 형식
- Codex app-server의 schema/type 생성 명령
- Apache License 2.0 배포 시 실제 NOTICE 구성
- GitHub 및 Claude Code 설치 명령
- 지원 OS와 런타임 최소 버전

검증 전에는 이 항목들을 확정된 사실로 취급하지 않는다.

## 22. 한 문장 요약

> `codex-plugin-cc`의 호환성과 upstream 관계를 유지하는
> `codex-conductor-cc` Fork를 먼저 만들고, Node 런타임을 안정화한 뒤
> 프로세스 감독·작업 상태·브로커 수명주기만 검증된 Go 코어로 점진적으로
> 교체한다.
