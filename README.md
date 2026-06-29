# WalkMon — 이동 기반 지역 점령 + 다마고치 육성 (MVP)

이동하면서 지나가는 지역(S2 셀)을 점령하고, 쌓인 경험치로 다마고치를 키우며,
지역마다 테마가 다른 아이템을 획득하는 토이 프로젝트의 시작점입니다.

## 핵심 루프

이동 → S2 셀 판정 → 지도에 그리드 + 점령 셀 색칠 → 신규/재방문 보상(XP·포인트)
→ XP로 다마고치 성장 → 셀 진입 시 지역 테마 아이템 드랍

## 중요 — 실행 환경

`react-native-maps`와 백그라운드 위치는 네이티브 모듈이라 **Expo Go에서는 동작하지 않습니다.**
반드시 개발 빌드로 실행하세요.

## 1) 프로젝트 생성

```bash
npx create-expo-app@latest walkmon --template blank
cd walkmon
```

생성된 기본 파일 위에 이 저장소의 `App.js`, `app.json`, `src/` 폴더를 덮어쓰세요.

## 2) 의존성 설치

```bash
npx expo install react-native-maps expo-location expo-task-manager @react-native-async-storage/async-storage
npm install s2-geometry
```

## 3) 지도 키 (Android만)

`app.json`의 `android.config.googleMaps.apiKey` 자리에 Android용 Google Maps API 키를 넣으세요.
iOS는 기본 Apple Maps를 쓰므로 별도 키가 필요 없습니다.

## 4) 개발 빌드 실행

```bash
# Android
npx expo run:android

# iOS (macOS + Xcode 필요)
npx expo run:ios
```

실기기 또는 위치를 흉내 낼 수 있는 에뮬레이터에서 테스트하세요.
(에뮬레이터는 위치 시뮬레이션 기능으로 경로를 흘려보내면 점령이 됩니다.)

## 파일 구조

- `App.js` — 지도 + 그리드 오버레이 + 점령 처리 + 다마고치/아이템 UI
- `src/grid.js` — 좌표 → S2 셀 키, 주변 셀 타일링(꼭짓점 폴리곤)
- `src/game.js` — XP·포인트·재방문 쿨다운·레벨/성장 단계 (밸런스 조정 지점)
- `src/items.js` — 셀 키 시드 기반 지역 테마 아이템 드랍
- `src/useLocation.js` — 포그라운드 위치 추적 훅
- `src/backgroundLocation.js` — [선택] 백그라운드 추적(MVP 검증 후 연결)

## 어디를 만지면 무엇이 바뀌나

- 지역 한 칸 크기: `src/grid.js`의 `CELL_LEVEL` (16=보행, 13~14=차량)
- 보상/쿨다운/성장 곡선: `src/game.js` 상단 상수
- 지역별 아이템: `src/items.js`의 `ITEM_POOLS`, `DROP_CHANCE`

## 다음 단계 후보

- 다마고치 커스터마이즈(이름·외형·스탯) 화면
- 진화 분기(돌본 방식에 따라 갈래)
- OSM 태그 기반 바이옴 드랍(현재는 셀 키 해시로 테마 고정)
- 백그라운드 누적 연결(`src/backgroundLocation.js`)
- 위치 스푸핑/순간이동 방지(속도 게이팅·정확도 필터)
