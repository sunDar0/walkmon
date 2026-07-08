@AGENTS.md

## 하네스: walkmon 위치 기반 도트 게임

**목표:** Expo 56 위치 기반 도트 게임을 게임로직·위치·도트렌더·빌드 4축 전문 에이전트 팀으로 개발한다.

**트리거:** walkmon 게임 기능 개발/수정 요청(점령·H3 그리드·위치추적·도트렌더·빌드) 시 `walkmon-dev` 스킬을 사용하라. 단순 질문(개념·코드 위치·한 줄 확인)은 직접 응답 가능.

## 빌드·실행

Expo Go 로는 못 띄운다(네이티브 모듈 때문). 개발 빌드가 필요하다.

| 명령 | 용도 |
|------|------|
| `npm start` | Metro 개발 서버(`expo start`) |
| `npm run ios` / `npm run android` | 네이티브 개발 빌드 실행(`expo run:*`) |
| `npm run web` | 웹(`expo start --web`) — 지도 렌더는 제한됨, 함정 참고 |
| `npm run lint` | `expo lint` |

빌드·실행·검증 자체는 `expo-build-run` 스킬 / `expo-build-qa` 에이전트가 맡는다.

## 코드 지도

엔트리는 `expo-router/entry` → `app/`. 게임 상태와 저장은 `App.js`(AsyncStorage; 저장 키·shape 은 `src/occupy.js` 의 `STORAGE_KEY`/`hydrate` 가 단일 출처).

| 파일 | 역할 | 담당 스킬 / 에이전트 |
|------|------|----------------------|
| `src/grid.js` | H3 좌표→셀 키 변환, 주변 셀 타일링 (해상도 10 ≈ 130m) | game-mechanics / game-core-engineer |
| `src/game.js` | 밸런스 상수·성장 (쿨다운 1h, XP, 단계별 만렙·수동 진화, 레벨당 30XP) | game-mechanics / game-core-engineer |
| `src/occupy.js` | 점령·보상 판정 순수 함수(`applyVisit`). 포그라운드·백그라운드 공유 | game-mechanics / game-core-engineer |
| `src/items.js` | 지역 테마 아이템 드롭 | game-mechanics / game-core-engineer |
| `src/useLocation.js` | 포그라운드 위치 추적(`watchPositionAsync`) | location-tracking / game-core-engineer |
| `src/backgroundLocation.js` | 백그라운드 추적(expo-task-manager) — **현재 App 에 미연결** | location-tracking / game-core-engineer |
| `src/PixelHexMap.js` | Skia 도트 타일맵·스프라이트·카메라 | pixel-rendering / pixel-render-engineer |
| `src/GameMap.js` | 네이티브 지도 헥스 렌더(react-native-maps) | pixel-rendering / pixel-render-engineer |

상세 설계는 `walkmon_concept_plan.md`, 개요는 `README.md` 참고. 밸런스 수치를 바꿀 때는 이 표가 아니라 `src/game.js` 가 단일 출처.

## 핵심 함정

- **웹 분기**: `react-native-maps`·`react-native-skia` 는 웹 미지원. 네이티브 시각 컴포넌트마다 `.web.js` 짝이 따로 있다(PixelHexMap·CareRoom·FullMap·GameMap). 네이티브 파일만 고치고 웹 짝을 빠뜨리지 말 것. (전체 규약은 walkmon-dev SKILL 의 "공유 계약 SSOT".)
- **h3-js 패치**: `patches/` 의 Hermes 패치를 `postinstall`(`patch-package`)이 자동 적용한다. `npm install` 이 패치를 못 붙이면 h3 호출이 깨진다.
- **점령 동치성**: `occupy.js` 는 React 에 의존하지 않는 순수 함수다. 포그라운드(`App.js`)와 백그라운드가 같은 결과를 내야 하므로, 점령 규칙을 바꾸면 양쪽 경로를 함께 확인할 것.
- **저장 호환성**: 저장 키·상태 shape·마이그레이션은 `src/occupy.js`(`STORAGE_KEY`/`INITIAL_STATE`/`hydrate`)가 단일 출처다. shape 을 바꾸면 키 번호를 올려 옛 저장본을 무시(초기화)하거나 `hydrate` 마이그레이션을 같이 처리할 것. (상세는 walkmon-dev SKILL 의 "공유 계약 SSOT".)

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-26 | 초기 구성 (3 에이전트 + 4 스킬 + 오케스트레이터) | 전체 | - |
| 2026-06-30 | 빌드·실행·코드 지도·핵심 함정 블록 추가 | CLAUDE.md | 세션마다 코드베이스 재탐색하던 비용 제거 |
| 2026-07-02 | 고정 줌 뷰 + 보드 배경(실제 지도 제거), res11(50m), 시야 400m, 단계별 만렙·수동 진화 성장 재작업(저장 v3) | 전체 | LOD 폐기 후 카메라·성장 모델 확정 |
| 2026-07-02 | 하네스 정의(에이전트 3 + 스킬 4) drift 동기화 — PixelHexMap 렌더러·res11·단계별 만렙 성장·저장 v3 반영 | .claude/agents, .claude/skills | 코드 변경 후 정의가 옛 GameMap/sqrt/v1 을 가리켜 에이전트 오작성 위험 |
| 2026-07-02 | 모델 tier 정책 반영 — walkmon-dev 의 "모두 opus" 못박기를 tier 기준으로 완화(현 3 에이전트는 코드생성/QA라 opus 유지) | skills/walkmon-dev | 메타 하네스 스킬의 역할별 opus/sonnet tier 도입 반영 |
| 2026-07-08 | 하네스 개선 3건 — 에셋 슬라이싱 스크립트(pixel-rendering `scripts/slice_sheet.py`), 파괴적 플레이 시나리오+디버그 훅(expo-build-run §6 + App.js `__DEV__` 상태 전역), 계약 SSOT(walkmon-dev 신설, 에이전트·도메인 스킬 v3→v4 drift 제거) | .claude/skills, .claude/agents, App.js, CLAUDE.md | 외부 tower-defense 하네스 분석 반영 + 코드는 v4인데 문서가 v3 가리키던 진행 중 drift 정리 |
