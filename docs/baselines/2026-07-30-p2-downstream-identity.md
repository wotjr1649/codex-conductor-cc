# P2 downstream identity baseline

상태: product source complete, local-only

공식 자료 확인일: 2026-07-30

제품 source commit 일시: 2026-07-31T00:26:17+09:00

## 1. 범위와 기준점

이 checkpoint는 verified Windows x64 제품 baseline 위에 downstream identity,
독립 version/upstream provenance와 app-server `clientInfo`만 설정한다. Release,
push, PR, P3 구현은 범위 밖이다.

| 항목 | exact value |
| --- | --- |
| P2 branch | `codex/p2-downstream-identity` |
| 시작 제품 commit | `9be83f26780429cd693bef62a20eebc70f54cec1` |
| P2 product source final commit | `bcb5efa9b2e16f85acdb06bba2b1c9e58f4de7a6` |
| planning checkpoint | `aa36bc78a5b90bcbd38b2dc3e0bd63d095049185` |
| upstream base | `db52e28f4d9ded852ab3942cea316258ae4ef346` |
| upstream repository | `openai/codex-plugin-cc` |

이 baseline 문서를 추가하는 후속 docs commit은 제품 source final과 분리한다.
문서 commit의 exact SHA는 commit 후 최종 readback과 session 보고서에 기록한다.

## 2. 고정한 downstream identity

| surface | P2 value | 이유 |
| --- | --- | --- |
| npm/package identity | `codex-conductor-cc` | downstream 제품 이름, 계속 `private: true` |
| marketplace | `codex-conductor` | 설치 시 official marketplace와 구분 |
| internal plugin | `codex` | `/codex:*` command contract 유지 |
| owner/author | `wotjr1649`, `https://github.com/wotjr1649` | repository owner와 일치하는 최소 가정 |
| downstream version | `0.1.0` | upstream version과 독립인 최초 downstream version |
| upstream provenance | `downstream.json`의 `openai/codex-plugin-cc`와 exact base | version과 독립 read 가능 |
| app-server name | `codex_conductor` | machine-readable integration originator |
| app-server title | `Codex Conductor` | human-readable integration title |
| app-server version | plugin manifest `0.1.0` | 실제 연결 identity와 release metadata 일치 |

버전의 canonical source는 `package.json.version`이다. 기존
`scripts/bump-version.mjs`가 package lock, marketplace 두 위치와 plugin
manifest를 함께 동기화한다. `downstream.json.upstreamBase`는 별도 provenance
source이며 version bump 대상에 넣지 않았다.

## 3. 공식 근거

다음 자료를 2026-07-30에 확인했다.

- OpenAI app-server protocol:
  <https://developers.openai.com/codex/app-server/>
- OpenAI Codex exact source `ClientInfo`:
  <https://github.com/openai/codex/blob/578c1b2230288104041e880a86d0f7f3a5ca6e47/codex-rs/app-server-protocol/schema/typescript/ClientInfo.ts>
- OpenAI brand guidance: <https://openai.com/brand/>
- OpenAI developer apps terms, 2026-07-09 update:
  <https://openai.com/policies/developer-apps-terms/>
- Claude Code marketplace schema:
  <https://code.claude.com/docs/en/plugin-marketplaces>
- Claude Code plugin schema:
  <https://code.claude.com/docs/en/plugins-reference>
- npm package name and `private` metadata:
  <https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#name>
- npm package name guidelines:
  <https://docs.npmjs.com/package-name-guidelines/>

OpenAI protocol은 `clientInfo.name`, `title`, `version`을 요구한다.
`name`은 originator/compliance identity에 사용되고 `version`은 user agent에
결합된다. `title`의 현재 server-side 사용은 durable contract로 가정하지
않았다. `experimentalApi: false`를 포함한 기존 capabilities는 변경하지
않았다.

Claude의 공식 schema에 따라 marketplace의 root name/owner와 plugin
name/source를 유지 가능한 최소 shape로 작성했다. `codex-conductor`가 공식
문서 예시나 reserved name으로 나타나지 않았고 npm 조회는 public package를
찾지 못했지만, 둘 다 이름의 법적 또는 향후 가용성을 보장하지 않는다.

GitHub API readback에서 downstream repository는 `openai/codex-plugin-cc`의
fork로 확인했다. Brand와 developer terms에 따라 OpenAI 또는 Anthropic의
제작, 지원, 인증, endorsement나 partnership를 암시하지 않는다.

## 4. 변경 allowlist

제품 source final에는 다음 surface만 변경했다.

- package/lock, marketplace, plugin manifest identity와 version
- `downstream.json`
- README의 unofficial fork, attribution, coexistence, install 문구
- `docs/UPSTREAM.md`
- plugin changelog
- app-server default `clientInfo`
- fake app-server의 최소 `clientInfo` capture와 direct/broker assertion
- P2 identity/provenance/protected-tree test

Authentication, provider, transport, app-server capabilities, command content,
agent, skill, hook와 runtime execution flow는 변경하지 않았다.

## 5. 보호 contract readback

시작 제품 commit부터 P2 product source final까지 다음 path의
`git diff --name-status`는 0이다.

- `plugins/codex/commands`
- `plugins/codex/agents`
- `plugins/codex/skills`
- `plugins/codex/hooks`

| protected tree | exact tree id |
| --- | --- |
| commands | `01dee9ba76393439e179c5676ea92e538358d86b` |
| agents | `e3d07a2c1a1acf9a986ecccd7e2b1c865b9da709` |
| skills | `1272de32547df5bb365e114feb590bfa002e53c1` |
| hooks | `39821e61e8b99bf415b7b05098b97d545fd377af` |

보호된 16개 파일의 canonical inventory는 UTF-8로 인코딩한
`relative-path<TAB>Git-blob-id<LF>` 레코드를 relative path의 ordinal
순서로 연결한다. SHA-256은
`b24fec394e331f6b550dfdb614be07ec19955c9f95288951afbcac4e4c8d0473`이며
시작/final의 path, blob과 tree가 모두 동일하다.

Root와 plugin의 LICENSE SHA-256은 모두
`5382d9ba43803da42433ae0025fe38d93c6e730d8824bd9e01af8e2f3c9c3833`,
NOTICE SHA-256은 모두
`d8d0168f4940626032fe7a9d6e7a9b767b37f6c777a2140679e72e07afd1b8e0`로
동일하다.

## 6. RED에서 GREEN으로

### Identity와 provenance

첫 RED 실행은 3개 중 보호 tree 1개만 통과했다. Package name은 기존
`@openai/codex-plugin-cc`였고 `downstream.json`은 없어서 identity와
provenance 2개가 기대대로 실패했다. 구현 뒤 같은 suite는 3/3 통과했다.

### Direct와 broker `clientInfo`

Direct setup과 shared broker의 기존 seam에 exact assertion을 추가했다.
두 RED 모두 기존
`{name: "Claude Code", title: "Codex Plugin", version: "1.0.6"}`를 capture해
목표 값과 불일치했다. 구현 뒤 두 경로 모두 다음 값을 capture했다.

```json
{
  "name": "codex_conductor",
  "title": "Codex Conductor",
  "version": "0.1.0"
}
```

두 경로에서 기존 capabilities도 다음 exact 값으로 유지됐다.

```json
{
  "experimentalApi": false,
  "requestAttestation": false,
  "optOutNotificationMethods": [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
}
```

## 7. 검증 ledger

| 검증 | 결과 |
| --- | --- |
| `npm ci` | exit 0, 3 packages, vulnerability 0 |
| version check | 6 metadata slots `0.1.0`, exit 0 |
| bump-version tests | 2/2 |
| platform-policy tests | 2/2 |
| P2 identity tests | 3/3 |
| direct `clientInfo` | 1/1 |
| broker `clientInfo` | 1/1 |
| full product tests final | 116/116, fail 0, single concurrency |
| build | exit 0 |
| generated schema | `e504c5f04a3157a41a481bfc20cc77b8af58e4c750dcb47ad4453899779d4834` |
| Claude current | 2.1.220, strict root/plugin 2/2 |
| Claude selected minimum | 2.1.196, strict root/plugin 2/2 |
| minimum binary | SHA-256 `180d7b279455e8b89d4353a5146447be2f80b80fb0db14bdc6dd9cb98c0aef09`, Authenticode valid |
| protected path/tree/blob | 0 diff, exact digest 일치 |
| LICENSE/NOTICE | 네 파일 시작/final SHA-256 일치 |
| final P2-scoped process inventory | 0 |

실패와 무효 evidence도 숨기지 않았다.

1. 첫 PowerShell inventory는 빈 JSON key의 `ConvertFrom-Json` 처리와 지원되지
   않는 `ls-tree --format` 사용 때문에 실패했다. Evidence로 사용하지 않았다.
2. 수정한 PowerShell inventory는 locale/culture sort를 사용해
   `e44ec676db92f68dc872597ca1fd3d5247f0b5d75f0afdfb8d361315915b2755`를
   냈다. 개별 path/blob/tree는 맞았지만 선언한 ordinal algorithm과 달라
   identity test RED가 발견했다. Harness만 수정했고 canonical digest는
   `b24fec394e331f6b550dfdb614be07ec19955c9f95288951afbcac4e4c8d0473`다.
3. Platform targeted invocation에서 존재하지 않는 `tests/platform.test.mjs`를
   지정해 실제 platform test가 포함되지 않았다. 이 실행은 platform
   evidence로 사용하지 않고 `tests/platform-policy.test.mjs`를 다시 실행해
   2/2를 확인했다.
4. Full suite 첫 실행은 180초 outer timeout으로 종료됐다. P2 경로에 남은
   test-owned process만 PID/parent/command line으로 식별했다. 첫 cleanup은
   종료 중 PID race를 만났고, 재조회 후 남은 64개 process/descendant를
   정리해 matching root 0을 확인했다.
5. Timeout을 늘린 full suite는 115/116이었다. 변경하지 않은 Windows cancel
   test에서 `taskkill`이 이미 종료 중인 child PID를 만나 exit 255를 냈다.
   같은 test는 P2와 시작 제품 baseline에서 각각 단독 1/1 통과했고, 최종
   full suite도 116/116 통과해 P2 identity 회귀가 아닌 비결정적 종료
   race로 분류했다.
6. Minimum Claude 첫 호출 시도는 shell guard가 PowerShell call operator를
   실행 전에 거부했다. Preserved tool directory를 PATH 앞에 둔 retry에서
   exact binary identity를 확인하고 strict validation 2/2를 실행했다.
7. Final manifest readback의 첫 PowerShell 명령도 package lock의 빈 root key
   때문에 기본 `ConvertFrom-Json`에서 실패했다. 이어진 inline Node
   correction은 shell guard가 실행 전에 거부했다. 둘 다 evidence로 쓰지
   않았고, `ConvertFrom-Json -AsHashtable` readback에서 lock top/root의
   name `codex-conductor-cc`와 version `0.1.0`을 확인했다.
8. 첫 final process query의 broker/fixture 보조 filter는 query를 실행한
   PowerShell 자신의 command line을 각 1건으로 잘못 포함했다. Process
   이름을 `node.exe`/`cmd.exe`로 제한한 correction에서 P2 runtime,
   P2 broker와 test fixture process가 모두 0임을 확인했다.

Node child-process helper의 기존 DEP0190 warning은 모든 관련 test run에서
관찰됐다. P2 변경으로 추가된 warning은 아니며 이번 identity 범위에서
helper execution policy를 변경하지 않았다.

## 8. 독립 read-only 조사

초기 세 agent는 쓰기 없이 독립 수행했다.

- Identity inventory: baseline manifest, license/notice와 보호 tree/blob 확인
- Official research: OpenAI, Claude, npm, GitHub의 현재 공식 근거 확인
- Contract seam review: direct/broker initialize capture 지점과 기존
  capability-preserving assertion 설계 확인

최종 구현은 agent output을 그대로 채택하지 않고 main session이 source,
공식 문서와 test output을 교차 확인했다. 네 번째 read-only final reviewer는
시작 제품 commit 대비 committed source와 untracked baseline 전체를 검토해
actionable finding 0건으로 판정했다. 보호 surface, LICENSE/NOTICE, privacy
scan과 generated schema digest도 독립 readback에서 ledger와 일치했다.
Reviewer가 분리한 residual release gate는 working-name legal/trademark 승인,
이름 가용성 재확인, credential/signing/ownership, update/rollback과
independent privileged review이며 현재 source finding은 아니다.

## 9. 남은 결정과 release gate

- `Codex Conductor`는 working downstream name이다. Trademark/legal owner의
  명시적 승인 전에는 public release하지 않는다.
- npm E404와 현재 marketplace 문서만으로 package/marketplace 이름의
  독점권이나 미래 가용성을 주장하지 않는다. Release 직전에 다시 확인한다.
- Public release에는 attribution, credential, signing, package ownership,
  marketplace update/rollback과 independent privileged reviewer가 필요하다.
- 필요하면 owner 결정으로 neutral fallback name을 선택하되 P2에서 추측해
  바꾸지 않는다.
- 이 checkpoint는 push, PR, package publication, tag, release와 P3 구현을
  수행하지 않았다.
