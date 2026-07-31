---
name: walkmon-dev
description: >-
  walkmon(Expo 56, 위치 기반 도트 게임)의 기능 개발·수정 요청을 팀으로 조율하는 오케스트레이터.
  트리거 = 점령/그리드(H3)/위치추적/도트렌더(Skia)/빌드 중 하나라도 손대는 작업.
  예: "점령 셀을 도트로 색칠", "H3 해상도 바꿔", "백그라운드 위치 App 에 연결",
  "Skia 설치하고 픽셀 타일맵", "시뮬레이터로 점령 동작 검증", "획득 로그 깨짐 고쳐".
  후속 키워드 = 다시 실행/재실행/업데이트/수정/보완/"~만 다시"/이전 결과 기반 →
  _workspace/ 의 이전 산출물을 읽어 개선하거나 해당 부분만 재실행한다.
  단순 질문(개념·코드 위치·한 줄 확인·"이 함수 뭐 하냐")은 팀을 만들지 말고 직접 답한다.
  game-mechanics / location-tracking / pixel-rendering / expo-build-run 스킬을 직접 호출하지 말고,
  그 스킬을 가진 에이전트에게 위임한다.
---

# walkmon-dev — 팀 오케스트레이터

walkmon 의 위치 기반 도트 게임 기능을 세 명의 전문 에이전트로 나눠 만든다.
이 스킬은 "누가 무엇을 하고, 산출물을 어떻게 주고받고, 어떤 순서로 검증하나"만 정한다.
실제 구현 방법(API·코드 스니펫)은 각 에이전트가 자기 스킬에서 가져온다.
오케스트레이터가 직접 코드를 쓰지 않는 이유: 한 곳에서 다 짜면 플랫폼 분리(웹/네이티브)와
Expo56 문서 확인이 누락되기 쉽다. 분업이 곧 안전장치다.

## 에이전트 ↔ 스킬 매핑 (글자 그대로, 변경 금지)

| 에이전트 | 담당 축 | 사용 스킬 | 주요 파일 |
|---|---|---|---|
| game-core-engineer | 점령 로직 / H3 그리드 / 위치 추적 / 영속화 | game-mechanics, location-tracking | src/game.js, src/grid.js, src/items.js, src/occupy.js(applyVisit·evolve·STORAGE_KEY), src/useLocation.js, src/backgroundLocation.js, App.js(handleCoords 배선) |
| pixel-render-engineer | 도트(픽셀) 렌더 / 헥스 오버레이 / 스프라이트 / 케어룸 크리처 | pixel-rendering | src/PixelHexMap.js, src/CareRoom.js, src/FullMap.js 와 각 `.web.js` 짝 (react-native-skia) |
| expo-build-qa | Expo 빌드·실행·네이티브 재빌드·시뮬 검증 | expo-build-run | app.json, package.json, app/index.tsx, App.js(배선/통합 검증용 읽기만, 게임상태 편집은 game-core-engineer) |

스킬은 네 개(game-mechanics / location-tracking / pixel-rendering / expo-build-run)뿐이다.
이 매핑을 벗어난 스킬·에이전트 이름을 지어내지 않는다.

## 공유 계약 (SSOT — 모든 에이전트가 여기서 읽는다)

여러 에이전트가 공유하는 계약은 아래 네 범주로만 둔다. 구체 수치·필드·prop 목록은 **코드가 최종 출처**이고, 이 절은 "어느 코드가 출처인가"만 가리킨다. 에이전트 정의 파일은 이 계약을 다시 서술하지 말고 이 절을 참조한다. literal(키 이름·shape·prop 목록)을 여러 문서에 복제하면 drift 난다 — 실제로 저장 키가 v3→v4 로 바뀌며 문서 곳곳이 옛 값을 가리킨 적이 있다.

1. **플랫폼 분리(웹/네이티브)** — react-native-skia·react-native-maps 는 네이티브 전용이라 import 만 해도 웹 번들이 깨진다. 규약: 네이티브 시각 컴포넌트는 `src/X.js`(네이티브) + `src/X.web.js`(웹 스텁 = `null` 또는 상태 카드) **쌍**으로 분리한다. 웹 = 상태/로그만, 네이티브 = 보드 + 도트 + 크리처. 현재 쌍(출처 = 파일 존재): `PixelHexMap` · `CareRoom` · `FullMap` · `GameMap`(레거시). 새 시각 컴포넌트를 추가하면 반드시 `.web.js` 짝을 만든다.

2. **저장 계약(영속화)** — 단일 출처: `src/occupy.js` 의 `STORAGE_KEY` · `INITIAL_STATE` · `hydrate`(정규화·마이그레이션). 케어 성장 모델로 shape 이 확장됐고(현재 키 v4), 정확한 필드·기본값·구버전 backfill 규칙은 occupy.js 가 최종 출처다 — 이 문서·에이전트 파일에 shape literal 을 복제하지 않는다. shape 을 바꾸면 game-core-engineer 가 occupy.js 에서 확정(키 버전을 올리거나 `hydrate` 에 마이그레이션 추가)하고, 렌더 쪽은 그 shape 을 읽기만 한다. occupy.js 는 React 비의존 순수 함수라 포그라운드(App.js)·백그라운드가 같은 결과를 내야 한다 — 점령/AP 규칙을 바꾸면 양 경로를 함께 확인한다.

3. **prop 계약(App.js → 렌더 컴포넌트)** — 단일 출처: `App.js` 의 각 컴포넌트 JSX 호출부. 렌더 에이전트는 prop 목록을 자기 정의에 복제하지 말고 호출부를 읽는다. `<PixelHexMap .../>` 와 `<CareRoom .../>` 가 넘기는 prop 집합(케어 모델로 `health` · `needMeter` · `careEvent` · `petType` 등이 추가됨)이 곧 계약이다. game-core 가 상태 shape 을 바꾸면 App.js 호출부가 바뀌고, 그게 렌더 계약의 변경점이다.

4. **소유권 경계** — 위 "에이전트 ↔ 스킬 매핑" 표가 소유의 단일 출처다. 요약: game-core-engineer = 로직·상태·영속화(occupy.js SSOT 소유), pixel-render-engineer = Skia 렌더·아틀라스(App.js 호출부 prop 을 읽기만), expo-build-qa = 빌드·검증(저장 shape ↔ 렌더 prop 경계면 교차 비교). 경계를 벗어난 결함은 계약을 깬 쪽으로 되돌린다.

### 프로세스 규칙 (계약 아님 · 모든 Phase 공통)

- 코드 작성 전 Expo 56 문서(https://docs.expo.dev/versions/v56.0.0/)와 라이브러리 현행 API(Context7)를 확인하도록 각 에이전트에 지시한다. 기억에 의존하지 않는다.
- 외과적 최소 변경: 요청과 직결된 라인만. 추측성 추상화·기능·예외처리 금지, 인접 서식 임의 변경 금지.

---

## Phase 0 — 컨텍스트 확인 (초기 / 새 실행 / 부분 재실행 판별)

`_workspace/` 존재 여부로 상태를 가른다. 왜: 이전 산출물을 모르고 새로 만들면 작업이 충돌하거나 덮어쓴다.

- `_workspace/` 없음 → 초기 실행. 디렉터리를 만들고 처음부터 진행한다.
- `_workspace/` 있고 요청이 새 기능 → 새 실행. 기존 산출물은 컨텍스트로만 읽고, 새 파일을 추가한다.
- 후속 키워드(다시/재실행/수정/보완/"~만 다시") → 부분 재실행. 해당 축의 이전 산출물 파일만 읽어 그 부분만 고치도록 지시하고, 나머지 축은 건드리지 않는다.

부분 재실행일 때 어떤 축을 고치는지 Phase 1 에서 확정한 뒤, 그 축을 담당하는 에이전트 한 명만 다시 부르는 것을 우선한다(불필요한 전체 재실행 방지).

## Phase 1 — 요청 분석 + 축 분류

요청을 네 축 중 어디에 닿는지 분류한다. 한 요청이 여러 축에 걸칠 수 있다(예: "점령 셀을 도트로 색칠" = 로직 shape + 렌더).

- 로직 축(점령·XP·아이템·쿨다운·영속화) → game-core-engineer / game-mechanics
- 위치 축(포그라운드·백그라운드 watch, distanceInterval, 권한) → game-core-engineer / location-tracking
- 렌더 축(픽셀 타일맵·헥스 오버레이·스프라이트·nearest-neighbor 스케일) → pixel-render-engineer / pixel-rendering
- 빌드 축(설치·prebuild·네이티브 재빌드·시뮬/디바이스 실행·웹 번들 확인) → expo-build-qa / expo-build-run

가정은 한 줄로 먼저 드러낸다(예: "occupied 는 Set<cellKey> 전제로 간다"). 모호하면 추측하지 말고 사용자에게 먼저 확인한다.

## Phase 2 — 팀 구성 + 작업 할당

1. `TeamCreate` 로 팀을 만든다. 분류된 축에 해당하는 에이전트만 부른다(빌드 검증은 거의 항상 포함).
2. 각 에이전트를 `Agent` 로 부를 때 `model` 을 그 에이전트 정의(frontmatter)의 tier 에 맞춰 명시한다. 현재 세 에이전트는 모두 코드 생성(game-core·pixel-render) 또는 QA(expo-build-qa)라 `opus` 다. 뒤에 기계적 IO 전용 에이전트(로그 수집·포맷 변환·배포 스크립트 실행 등)를 붙이면 그것만 `sonnet` 으로 둔다.
   - game-core-engineer (.claude/agents/game-core-engineer.md)
   - pixel-render-engineer (.claude/agents/pixel-render-engineer.md)
   - expo-build-qa (.claude/agents/expo-build-qa.md)
3. `TaskCreate` 로 작업과 의존성을 건다. 데이터 흐름이 의존성을 결정한다:
   - 보통 game-core-engineer 가 상태 shape 을 먼저 확정(SSOT) → pixel-render-engineer 가 그 shape 을 읽어 렌더 → expo-build-qa 가 둘을 합쳐 빌드·검증.
   - 따라서 렌더 작업은 로직 shape 작업에 의존, 검증 작업은 둘 다에 의존하도록 TaskCreate 의존성을 설정한다.

## Phase 3 — 데이터 전달

세 경로를 함께 쓴다. 왜 세 개냐: 실시간 합의(SendMessage), 순서 보장(TaskCreate 의존성), 영속 산출물(파일)은 역할이 다르다.

- `SendMessage` — 에이전트 간 실시간 질의·합의(예: pixel-render-engineer 가 game-core-engineer 에게 "occupied 가 Set 이냐 Array 냐" 확인). 오케스트레이터는 중계·중재만 한다.
- `TaskCreate` 의존성 — 누가 먼저 끝나야 누가 시작하는지.
- `_workspace/` 파일 산출물 — 합의된 결과물. 파일명 규칙: `{phase}_{agent}_{artifact}` (예: `p2_game-core-engineer_state-shape.md`, `p3_pixel-render-engineer_hex-overlay.md`, `p4_expo-build-qa_verify-report.md`).

상태 shape, 좌표 계약(cellsAround 의 {key, corners:[{latitude,longitude}x6]}), 색 팔레트 같은 공유 계약은 반드시 `_workspace/` 파일로 남겨 다음 에이전트가 읽게 한다. 말로만 전달하지 않는다.

## Phase 4 — expo-build-qa 의 점진적 검증

한 번에 몰아서 빌드하지 않는다. 왜: 네이티브 의존성(Skia 등)을 새로 깔면 prebuild/재빌드가 필요한데, 끝에 한꺼번에 하면 어느 변경이 깼는지 못 가린다.

- 로직만 바뀜 → 웹/Metro 핫리로드로 빠르게 확인.
- 네이티브 패키지 추가/네이티브 코드 변경 → expo-build-qa 가 prebuild + 네이티브 재빌드까지 수행하고 시뮬레이터에서 점령·렌더 동작을 확인.
- 매 통합 지점마다 expo-build-qa 가 `p4_expo-build-qa_verify-report.md` 에 결과(통과/실패·재현 절차)를 남긴다.

## Phase 5 — 종합

각 에이전트 산출물과 검증 보고서를 모아 사용자에게 보고한다. 무엇이 바뀐 파일인지(절대 경로), 검증 결과, 남은 위험·미구현 축(예: 걸음수 pedometer)을 명시한다. 트레이드오프가 남으면 짧게 던지고 결정은 사용자에게 넘긴다.

---

## 에러 핸들링

- 에이전트 실패·무응답 시 1회 재시도. 그래도 실패하면 멈추지 말고 진행하되, 그 축의 결과 누락을 Phase 5 보고서에 명시한다.
- 에이전트 간 산출물이 상충하면(예: 한쪽은 occupied 를 Set, 다른 쪽은 Array 로 가정) 한쪽을 삭제하지 말고 두 출처를 모두 병기해 사용자가 판단하게 한다.
- 검증 실패는 실패로 보고한다. 흐릿하게 "대체로 동작" 으로 끝내지 않는다. 확신 없으면 없다고 쓴다.

## 이전 산출물 처리

`_workspace/` 에 이전 결과가 있으면 먼저 읽고 개선한다. 처음부터 다시 만들지 않는다.
부분 피드백("렌더만 다시", "쿨다운만 수정")이면 해당 축 파일만 고치고 나머지는 그대로 둔다.
파일명의 `{agent}` 로 누구 산출물인지 식별해 그 에이전트만 다시 부른다.

---

## 테스트 시나리오

### 정상 흐름 — "점령한 셀을 도트로 색칠해줘"

1. Phase 0: `_workspace/` 없음 → 초기 실행, 디렉터리 생성.
2. Phase 1: 로직 축(점령 상태 shape) + 렌더 축(오버레이) + 빌드 축(검증)으로 분류.
3. Phase 2: TeamCreate → game-core-engineer·pixel-render-engineer·expo-build-qa 를 각각 model:"opus" 로 Agent 호출. TaskCreate 의존성: 렌더 → 로직, 검증 → 렌더+로직.
4. Phase 3:
   - game-core-engineer 가 game-mechanics 스킬로 점령 상태 shape(occupied 의 셀 키 집합 + 색 결정 규칙)을 확정해 `p2_game-core-engineer_state-shape.md` 저장.
   - pixel-render-engineer 가 SendMessage 로 shape 을 확인하고, pixel-rendering 스킬로 src/PixelHexMap.js 에 헥스(H3 역매핑) 위 픽셀 색칠 오버레이를 만들어 `p3_pixel-render-engineer_hex-overlay.md` 저장. src/PixelHexMap.web.js 는 null 유지(웹 분리).
5. Phase 4: expo-build-qa 가 expo-build-run 스킬로 시뮬레이터에서 점령 시 해당 헥스가 도트로 칠해지는지 확인, `p4_expo-build-qa_verify-report.md` 작성.
6. Phase 5: 바뀐 파일·검증 결과 종합 보고.

### 에러 흐름 — Skia 설치 후 네이티브 재빌드 누락

1. pixel-render-engineer 가 react-native-skia 로 픽셀 타일맵을 추가(미설치 패키지 → 설치 필요).
2. expo-build-qa 가 Phase 4 에서 Metro 만 리로드하고 실행 → Skia 네이티브 모듈 not found 로 시뮬 크래시.
3. expo-build-qa 가 원인을 "네이티브 패키지 추가 후 prebuild/재빌드 누락" 으로 진단하고 `p4_expo-build-qa_verify-report.md` 에 실패로 기록, prebuild + 네이티브 재빌드를 수행해 재검증.
4. 재시도 1회로 통과하면 진행, 실패하면 누락으로 명시하고 Phase 5 에서 사용자에게 보고.
