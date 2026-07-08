---
name: expo-build-run
description: >-
  walkmon(Expo SDK 56) 앱을 빌드·실행하고 두 단계(컴파일/런타임)로 검증·QA한다.
  네이티브 모듈(react-native-maps, expo-location 백그라운드, expo-task-manager) 때문에
  Expo Go 로는 못 돌고 dev build 가 필요하다는 전제를 다룬다.
  트리거: "빌드", "실행", "run:ios", "run:android", "안드로이드/아이폰으로 띄워",
  "expo start --web", "웹으로 띄워", "시뮬레이터/에뮬레이터", "GPS 주입", "config/플러그인 반영",
  "prebuild", "검증", "QA", "스크린샷으로 확인", "번들 에러", "웹 번들 깨짐", "import 해도 깨짐".
  후속 키워드: "다시 빌드", "재실행", "검증 다시", "수정", "보완", "추가", "--clean 으로 다시".
  트리거하지 말 것(인접 케이스): XP/쿨다운/점령 같은 게임 규칙 변경은 game-mechanics,
  watchPositionAsync/백그라운드 추적 로직 변경은 location-tracking,
  Skia 픽셀 타일맵 구현은 pixel-rendering 이 담당한다. 이 스킬은 그 결과물을
  빌드·실행·검증하거나, 새 네이티브 모듈 설치 후 재빌드할 때만 작동한다.
---

# expo-build-run — walkmon 빌드·실행·검증

walkmon 을 시뮬레이터/실기기/웹에서 돌리고, 변경이 깨지지 않았는지 두 단계로 검증한다.
이 스킬은 expo-build-qa 에이전트가 쓴다. 코드 로직을 새로 짜는 게 아니라,
이미 나온 결과물을 **빌드 가능 상태로 만들고 핵심 루프가 도는지 눈으로 확인**하는 게 목적이다.

## 0. 절대 규칙 (작업 전 확인)

- **Expo 56 문서 우선**: 명령·플래그·config 키가 의심되면 기억에 의존하지 말고
  https://docs.expo.dev/versions/v56.0.0/ 또는 Context7(`/expo/expo`)로 현행 API 를 확인한다.
  Expo CLI 는 마이너 버전마다 플래그가 바뀐다.
- **최소 변경**: 빌드를 통과시키려고 무관한 코드/서식을 건드리지 않는다.
  설정 파일(app.json)도 요청과 직결된 키만 손댄다.
- **웹/네이티브 분리 유지**: 네이티브 전용 모듈은 항상 `.web.js` 짝으로 분리한다(§5).
  이 분리를 깨는 변경은 빌드를 통과시켜도 되돌린다.

## 1. 왜 Expo Go 가 아니라 dev build 인가

walkmon 은 Expo Go 에 없는 네이티브 의존성을 쓴다. 그래서 Expo Go 로는 못 돈다.

- `react-native-maps` — 네이티브 지도 뷰. Android 는 Google Maps API 키를 네이티브 설정에
  주입해야 한다(아래 §3). Expo Go 는 이 네이티브 설정을 반영하지 못한다.
- `expo-location` 백그라운드 모드 + `expo-task-manager` — `UIBackgroundModes: ["location"]`,
  Android `FOREGROUND_SERVICE_LOCATION` 권한이 네이티브 manifest/plist 에 들어가야 한다.
  이건 config plugin(app.json 의 `plugins`)이 prebuild 때 주입한다.
- `newArchEnabled: true` — 새 아키텍처 빌드.

결론: **dev build** 로 간다. 즉 `npx expo prebuild` 로 네이티브 프로젝트를 생성하고
`npx expo run:ios` / `run:android` 로 로컬 네이티브 빌드를 만든다.
웹은 네이티브 빌드가 필요 없으니 `npx expo start --web` 로 바로 띄운다.

## 2. 실행 명령 (검증된 Expo 56 CLI)

```bash
# iOS 시뮬레이터에 dev build 빌드·설치·실행
#   native 디렉터리(ios/)가 없으면 prebuild 가 자동으로 먼저 돈다.
npx expo run:ios

# 특정 시뮬레이터/실기기 지정
npx expo run:ios --device            # 연결된 실기기(자동 서명)

# Android 에뮬레이터/실기기에 dev build
npx expo run:android

# 웹(지도 없음, 상태 카드 + 획득 로그만)
npx expo start --web
```

**footgun — `-p` 의미가 명령마다 다르다**
- `expo start -p <n>` 의 `-p` 는 `--port`(기본 8081)다.
- `expo prebuild -p ios` 의 `-p` 는 `--platform` 이다.
혼동을 피하려면 prebuild 에선 긴 형태 `--platform ios` 를 쓴다.

## 3. app.json config 체크 (빌드 전 확인할 키)

빌드 실패·런타임 지도 미표시는 대부분 여기서 난다. `app.json` 의 `expo` 아래를 본다.

- **iOS 지도** — react-native-maps 는 iOS 에서 **Apple Maps** 를 기본으로 쓴다.
  **API 키 불필요.** 대신 위치 권한 문자열만 있으면 된다:
  `infoPlist.NSLocationWhenInUseUsageDescription`,
  `NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes: ["location"]`.
- **Android 지도** — Google Maps 라서 **API 키 필수**:
  `android.config.googleMaps.apiKey`. 현재 app.json 엔
  `"여기에_ANDROID용_GOOGLE_MAPS_API_KEY"` 플레이스홀더가 들어 있다. 실제 키로 바꾸지 않으면
  Android 빌드는 되지만 지도 타일이 회색으로 비어 나온다. (런타임 증상으로 기억해 둘 것.)
- **Android 권한** — `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`,
  `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`.
- **plugins** — `expo-location` 플러그인이 `isAndroidBackgroundLocationEnabled: true` 로
  들어 있다. 이 값을 바꾸면 네이티브 설정이 달라지므로 prebuild 를 다시 돌려야 한다(§4).

## 4. 플러그인/네이티브 설정을 바꿨을 때 — prebuild 재생성

app.json 의 `plugins`, 권한, `googleMaps.apiKey`, `newArchEnabled` 등 **네이티브에 반영되는
값**을 바꾸면, JS 만 리로드해선 안 먹는다. 네이티브 프로젝트를 다시 생성해야 한다.

```bash
# ios/android 네이티브 디렉터리를 app.json 기준으로 깨끗이 재생성
npx expo prebuild --clean

# 한 플랫폼만
npx expo prebuild --platform ios --clean

# 재생성 후 다시 빌드
npx expo run:ios
```

`--clean` 은 기존 `ios/`·`android/` 를 지우고 새로 만든다. 네이티브를 직접 수정한 게 없다면
항상 `--clean` 으로 동기화하는 게 안전하다(설정 드리프트 방지).

**새 네이티브 모듈을 설치한 경우**(예: pixel-rendering 작업에서 `react-native-skia` 추가):
`npm install` → `npx expo prebuild --clean` → `npx expo run:ios`/`run:android` 순서로
네이티브 재빌드까지 해야 모듈이 링크된다. JS 리로드만으로는 절대 안 잡힌다.

## 5. 웹 번들 가드 — 네이티브 전용 모듈은 .web 으로 분리 (체크리스트)

react-native-maps 는 **import 만 해도 웹 번들이 깨진다.** 그래서 walkmon 은
플랫폼 분리 파일을 둔다. 새 시각 기능을 넣을 때 이 표를 어기지 않는지 본다.

| 모듈/파일 | 네이티브 | 웹 |
|---|---|---|
| 도트 렌더 | `src/PixelHexMap.js`(react-native-skia) | `src/PixelHexMap.web.js`(`return null`) |
| import 경로 | App.js 는 `./src/PixelHexMap` 만 import — 번들러가 플랫폼별 짝을 고른다 | 동일 |

체크리스트(웹이 깨졌을 때 / 새 네이티브 모듈을 추가할 때):

- [ ] 네이티브 전용 모듈(react-native-skia, 레거시 react-native-maps 등)을 **직접 import 하는
      파일에 `.web.js` 짝이 있는가?** 없으면 웹 번들이 깨진다.
- [ ] `.web.js` 는 같은 props 시그니처를 받고 웹에서 안전한 것(보통 `null` 또는 상태 카드)을
      반환하는가?
- [ ] App.js 등 공용 코드는 확장자 없이(`./src/PixelHexMap`) import 하는가?
      `./src/PixelHexMap.js` 처럼 못 박으면 웹 짝이 안 골라진다.
- [ ] 위치/격자/아이템 로직(`src/useLocation.js`, `src/grid.js`, `src/items.js`)은
      웹에서도 그대로 도는가? 이게 도는 한 웹은 지도 없이도 상태 검증용으로 충분하다.

## 6. 검증 2단계

### (a) 컴파일 검증 — 웹 export 로 번들 깨짐 조기 발견

런타임까지 가지 않고, 정적 번들 단계에서 웹 비호환 import(react-native-skia 직접 import 등)를
잡는다. 시뮬레이터 빌드보다 빠르고, .web 분리 누락을 가장 먼저 드러낸다.

```bash
npx expo export --platform web
```

- 성공: `dist/` 가 생성된다 → 웹 번들 정상.
- 실패: react-native-skia 같은 네이티브 전용 모듈을 웹에서 import 했을 가능성이 크다 → §5 체크리스트로.
- 이건 **모든 변경 후 가장 먼저 돌리는 값싼 게이트**다. 네이티브 빌드 전에 먼저 통과시킨다.

### (b) 런타임 검증 — 시뮬레이터 + GPS 주입 + 핵심 루프 스크린샷

핵심 루프 = **좌표 → 셀 판정 → 점령 → XP 증가**. 코드 위치:
`useLocation`(좌표) → `cellKeyAt`/`cellsAround`(`src/grid.js`, H3 res 11 ≈ 50m) →
`applyVisit`(`src/occupy.js`, stageXp 누적·`rollItem`) → `levelInStage`/`canEvolve`(`src/game.js`).

시뮬레이터엔 실제 GPS 가 없으니 좌표를 주입해 루프를 돌린다.

```bash
# iOS 시뮬레이터: Features ▸ Location ▸ Custom Location 으로 좌표 입력(권장).
#   CLI 대안(Xcode 15+에서 사용 가능 여부 확인 후):
xcrun simctl location booted set 37.5665,126.9780

# Android 에뮬레이터: 인자 순서가 (경도 위도)임에 주의.
adb emu geo fix 126.9780 37.5665
```

확인 순서:
1. 첫 좌표 주입 → 상태 카드에 `현재 지역`/`Lv.`/`이번 단계 XP` 가 뜨고, 네이티브에선 현재 셀
   헥스 타일이 그려지는가.
2. 50m 이상 떨어진 다른 좌표를 주입 → 새 셀로 판정되어 **stageXp 가 NEW_CELL_XP 만큼 증가**하고
   점령 칸 수가 늘어나는가(`Object.keys(occupied).length`).
3. 같은 셀을 쿨다운(COOLDOWN_MS = 1시간) 전에 다시 밟으면 보상이 안 들어가는가
   (재방문 보상은 쿨다운 후에만).
4. 스크린샷으로 위 상태 카드/지도를 남긴다. 웹은 지도가 없으니 **상태 카드 + 획득 로그**
   스크린샷으로 갈음한다.

**Android 지도 회색 화면** = §3 의 Google Maps 키 플레이스홀더 문제이지 코드 버그가 아니다.
이 경우 핵심 루프(셀/XP)는 상태 카드로 검증하고, 지도 렌더는 키 주입 후 재확인한다.

### (c) 파괴적 플레이 시나리오 — 케어 모델 엣지

정상 루프(a·b)만으론 안 잡힌다. walkmon 이 케어 모델(meters 3종·AP·건강코드·쿨다운·이모지·파티클)로
커지며 손댈 상태가 늘었고, 늘어난 만큼 경계·중복·손상 입력의 엣지도 늘었다. 아래를 **일부러 흔들어**
크래시·레드박스·NaN·음수·중복 보상이 안 나는지 본다. 상태 값 실측 대조는 (d) 디버그 훅으로 한다.

- **케어 버튼 연타** — 같은 액션·다른 액션을 빠르게 여러 번 탭. AP 가 음수로 안 가는지(부스트 OFF 자동
  전환 포함), `careEvent`(연출 이벤트)가 매번 `at` 바뀌며 재생되는지, 크래시가 없는지. `doCare` 는 매 탭
  `careAction` + 새 `{action,at}` 을 찍으므로 연타에도 재생이 씹히면 안 된다.
- **미터 경계값(0·100)** — GPS 정지로 미터를 오래 방치해 0 까지, 또는 케어 연타로 100 까지 몰아본다.
  게이지 fill 이 0~100% 밖으로 안 새는지(`clamp`), 40 미만 신호등 빨강·건강코드 발현·머리 위 말풍선이
  경계에서 정상 전환되는지, 어디에도 `NaN` 이 안 뜨는지.
- **쿨다운 재방문 악용** — 같은 셀을 COOLDOWN_MS(1시간) 전에 반복해서 밟는다(같은 좌표 재주입).
  점령 보상이 멱등인지 = 쿨다운 전이면 stageXp·occupied 가 안 늘어야 한다(무보상). 포그라운드·백그라운드
  경로가 같은 결과를 내는지도 함께 본다(occupy.js 는 순수 함수라 양쪽 동치여야 한다).
- **NaN·손상 저장본** — AsyncStorage 의 `walkmon_state_v4`(occupy.js `STORAGE_KEY`)를 손상값(meters 에 NaN, ap 없음,
  health 가 배열 아님)으로 넣고 재기동. `hydrate` 가 방어적 backfill 로 기본값 복구하는지 = 앱이 레드박스
  없이 뜨고 미터/AP 가 정상 범위로 채워지는지.
- **표시 무결성** — 상단 상태 카드·돌봄 방 어디에도 `NaN`/`undefined`/빈값이 노출 안 되는지 육안 +
  (d) 디버그 훅 실제 값 대조(육안은 반올림·게이지라 NaN 을 숨길 수 있어 훅으로 원값 확인).
- **앱 전환·재기동** — 백그라운드→포그라운드 복귀 시 `loadGameState` 가 오프라인 경과(미터 감소·건강코드)를
  tick 으로 정산하는지, 강제 종료 후 재기동 시 상태가 복원되는지(occupied·stageXp·meters·ap 유지).

### (d) 시뮬레이터 상태 디버그 훅 — global.__WALKMON__

육안 상태 카드는 반올림·게이지·이모지라 실제 값(NaN·음수·부동소수)을 숨긴다. App.js 는 개발 빌드에서만
(`__DEV__` 가드) 상태를 전역에 노출한다. 프로덕션 번들엔 안 들어가고, 웹/네이티브 모두 안전하다.

```js
// App.js — __DEV__ 가드 안에서 매 상태 변경 시 갱신
global.__WALKMON__ = { gameState, coords, currentKey, occupiedCount };
```

읽는 값(핵심 루프·케어 엣지 대조용):
- `__WALKMON__.gameState.meters` — `{ satiety, happiness, cleanliness }`. 0~100 밖·NaN 이면 결함.
- `__WALKMON__.gameState.ap` — AP. 음수면 결함(연타 시나리오).
- `__WALKMON__.gameState.health` — 활성 건강코드 배열. 배열이 아니면 손상 저장본 방어 실패.
- `__WALKMON__.occupiedCount` — 점령 칸 수. 새 셀에서 늘고 쿨다운 재방문엔 안 느는지.
- `__WALKMON__.gameState.stageXp` / `.stageIndex` — XP 누적·단계.
- `__WALKMON__.currentKey` — 현재 셀 키(H3). `null` 이 오래 지속되면 위치 미수신.

읽는 방법(택1):
- **JS 디버거 콘솔**(RN dev menu ▸ Open JS Debugger, 또는 Metro 의 `j`): 콘솔에
  `global.__WALKMON__` 입력 → 스냅샷 확인. 시나리오 직후(연타·경계값 도달) 값을 찍어 대조한다.
- **로그 임시 삽입 없이** 콘솔에서 반복 조회로 충분하다. 값이 안 보이면 개발 빌드가 아닌지(`__DEV__`
  false), 또는 아직 상태 변경 커밋이 없어 훅이 안 돈 건지 확인(첫 fix/케어 후 갱신됨).

## 7. 막혔을 때 / 핸드오프

- 빌드 실패가 **설정·네이티브 동기화** 문제면(plugin 변경 미반영, 모듈 미링크):
  `npx expo prebuild --clean` 후 재빌드를 1회 시도한다.
- export/런타임에서 드러난 게 **코드 로직 버그**(셀 판정·XP 계산·추적 동작)면 이 스킬 범위
  밖이다. 해당 결과물을 만든 쪽(game-mechanics / location-tracking / pixel-rendering 작업)으로
  돌려보내고, 재현 절차와 스크린샷을 함께 넘긴다.

## 8. 이전 산출물 처리

`_workspace/` 에 이전 빌드/검증 기록이나 스크린샷이 있으면 먼저 읽는다.
- 같은 검증을 다시 요청받으면 이전 결과와 비교해 **달라진 부분만** 재검증한다.
- "특정 부분만 보완" 피드백이면 그 단계(예: 웹 export 만, Android 만)만 다시 돌린다.
- 전부 새로 하라는 신호가 없으면 처음부터 다시 빌드하지 않는다.
