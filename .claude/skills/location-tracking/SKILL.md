---
name: location-tracking
description: >-
  walkmon 위치 추적 작업 — 포그라운드 watchPositionAsync(src/useLocation.js)와
  백그라운드 expo-task-manager(src/backgroundLocation.js, App 마운트 시 연결됨)를 다룬다.
  위치/GPS/좌표 갱신, 백그라운드 추적, 권한 흐름(foreground→background), expo-task-manager
  defineTask/startLocationUpdatesAsync 작업, 시뮬레이터·브라우저 이동 시뮬레이션을
  손볼 때 사용한다. 후속 신호 — "위치 다시", "추적 재실행", "권한 수정", "백그라운드 보완",
  "이동 시뮬 추가", "GPS 안 잡혀" 도 이 스킬로 받는다. 좌표를 받은 뒤의 셀 키 변환·점령·XP
  계산은 이 스킬이 아니라 game-mechanics 의 몫이다(아래 경계 참고).
---

# location-tracking — walkmon 위치 추적

walkmon 은 위치 기반 게임이다. 위치 파이프라인은 **좌표를 만들어 내는 단계**(이 스킬)와
**좌표를 게임 보상으로 바꾸는 단계**(game-mechanics)로 나뉜다. 이 스킬은 앞 단계만 책임진다:
권한을 받고, 좌표 스트림을 켜고, 콜백으로 `coords` 를 흘려보내는 데까지.

## 절대 먼저 할 일

코드를 쓰기 전에 **Expo 56 문서**(https://docs.expo.dev/versions/v56.0.0/)에서 expo-location /
expo-task-manager 항목을 연다. API 시그니처가 의심되면 Context7(`resolve-library-id` → `query-docs`,
libraryId `/expo/expo`)로 현행 시그니처를 대조한다. 기억으로 스니펫을 쓰지 않는다.
Expo 는 마이너 버전에서도 위치 옵션 키가 바뀐 적이 있다.

외과적 최소 변경: 요청과 직결된 라인만 고친다. `useLocation` 의 옵션 한 줄을 바꾸라는 요청에
백그라운드 로직까지 손대지 않는다.

## 두 경로의 분리 (왜 둘인가)

| 경로 | 파일 | 언제 동작 | 정확도/간격 |
| --- | --- | --- | --- |
| 포그라운드 | `src/useLocation.js` | 앱이 화면에 떠 있을 때 | `Accuracy.High`, 10m / 3s |
| 백그라운드 | `src/backgroundLocation.js` | 화면이 꺼져도(주머니 걷기) | `Accuracy.Balanced`, 25m, deferred 10s |

포그라운드는 React 훅이라 컴포넌트 안에서 산다. 백그라운드는 **OS 가 앱을 깨워 실행**하므로
React 밖, 모듈 최상위에서 살아야 한다. 이 차이가 아래 모든 제약의 뿌리다.

현재 백그라운드는 **App 에 연결됨** — `App.js` 마운트 effect 가 `registerBackgroundLocation()` 을
한 번 호출한다. 포그라운드가 active 인 동안엔 배치 처리를 skip 해 단일 writer 를 유지한다.

## 포그라운드 — src/useLocation.js

이미 구현돼 있다. 핵심 형태(현행 SDK 56 API, 검증됨):

```js
const { status: fg } = await Location.requestForegroundPermissionsAsync();
if (fg !== 'granted') { /* 'denied' 처리 */ return; }

const sub = await Location.watchPositionAsync(
  { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 3000 },
  (loc) => onUpdate(loc.coords)   // loc.coords = { latitude, longitude, ... }
);
// 언마운트 시 반드시
sub.remove();
```

- `watchPositionAsync` 의 구독은 **반드시 정리**한다(`subRef.current.remove()`). 정리 안 하면
  화면을 떠난 뒤에도 GPS 가 돌아 배터리를 먹고 콜백이 죽은 컴포넌트를 건드린다.
- `distanceInterval` 10m 와 `timeInterval` 3s 는 OR 조건처럼 동작한다(둘 중 먼저 충족되면 갱신).
  보행 페이스에 맞춘 값이다. 더 촘촘히 받고 싶다면 두 값을 함께 내린다.
- 옵션 키를 바꾸면 콜백 빈도가 바뀌고, 그게 game-mechanics 의 보상 빈도에 직접 영향을 준다.
  game-core-engineer 와 합의 없이 임의로 키우지 않는다.

## 백그라운드 — src/backgroundLocation.js

```js
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
const TASK_NAME = 'walkmon-bg-location';

// 모듈 최상위(컴포넌트 밖)에서 등록해야 한다.
TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
  if (error) return;
  const { locations } = data || {};
  if (!locations?.length) return;
  // 여기서 좌표를 저장소(AsyncStorage)에 누적. state 아님 — React 밖이라 state 가 없다.
});

await Location.startLocationUpdatesAsync(TASK_NAME, {
  accuracy: Location.Accuracy.Balanced,
  distanceInterval: 25,
  deferredUpdatesInterval: 10000,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: 'WalkMon',
    notificationBody: '이동을 따라 지역을 점령하는 중...',
  },
});
```

세 가지 함정(이유 포함):

1. **`defineTask` 는 모듈 로드 시점에 등록**한다. OS 가 앱을 백그라운드로 깨우면 컴포넌트가
   하나도 마운트되지 않은 상태일 수 있다. 그때 태스크가 이미 등록돼 있어야 콜백이 불린다.
   컴포넌트 `useEffect` 안에서 `defineTask` 하면 백그라운드에서 안 불린다.
2. **콜백 안에서 state 를 쓰지 않는다.** React 밖이라 setState 가 의미 없다. 좌표는
   AsyncStorage(또는 SQLite)에 누적하고, 포그라운드 복귀 시 읽어서 화면에 반영한다.
3. **중복 등록 방지.** `Location.hasStartedLocationUpdatesAsync(TASK_NAME)` 로 이미 켜졌는지
   확인하고 시작한다. 끌 때는 `Location.stopLocationUpdatesAsync(TASK_NAME)`.

포그라운드와 백그라운드를 동시에 켜면 같은 이동이 양쪽에서 잡혀 **보상이 중복**될 수 있다.
점령 처리를 셀 키 + lastVisit 쿨다운으로 **멱등하게** 만들어 한쪽에서만 확정한다
(이 멱등 처리는 game-mechanics 책임).

## 권한 흐름 — 순서가 강제된다

**포그라운드 → 백그라운드 순서**를 반드시 지킨다. 백그라운드 권한은 포그라운드 권한 없이는
받을 수 없다(OS 규칙).

```js
const { status: fg } = await Location.requestForegroundPermissionsAsync();
if (fg !== 'granted') return false;
const { status: bg } = await Location.requestBackgroundPermissionsAsync();
if (bg !== 'granted') return false;
```

플랫폼 차이:

- **iOS**: 백그라운드 위치는 **개발 빌드에서만** 동작한다(Expo Go 불가). `UIBackgroundModes: ["location"]`
  가 Info.plist 에 있어야 한다 — app.json 에 이미 설정됨. 사용자는 "앱 사용 중에만" → "항상 허용"
  으로 2단계로 승격할 수 있어, 백그라운드 권한이 처음엔 거절돼도 정상 흐름이다.
- **Android 11+**: `requestBackgroundPermissionsAsync()` 가 **시스템 설정 페이지를 연다**(인앱 팝업이
  아님). 그래서 호출 전에 왜 필요한지 사용자에게 먼저 설명해야 한다. `ACCESS_BACKGROUND_LOCATION` +
  `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION` 권한이 필요 — app.json 에 이미 있음.

app.json 설정은 이미 완비돼 있다(infoPlist `UIBackgroundModes`, android `permissions`,
`expo-location` 플러그인의 `isAndroidBackgroundLocationEnabled: true`). 권한 문자열을 새로
지어내지 말고 기존 값을 쓴다. 설정을 바꿨다면 **네이티브 재빌드**가 필요하다(expo-build-qa 가 처리).

## 웹에서의 위치

expo-location 은 웹에서 `navigator.geolocation` 을 감싸 동작한다. 그래서 `useLocation` 은
웹에서도 좌표를 받는다. 단:

- **https 또는 localhost** 에서만 위치 권한이 뜬다(브라우저 보안 정책).
- 웹에는 **백그라운드 추적이 없다.** `backgroundLocation.js` 경로는 웹에서 의미 없다.
- walkmon 의 웹 화면은 지도 없이 상태 카드 + 획득 로그만 보여준다(AGENTS 규약). 위치 갱신은
  여전히 게임 상태를 굴리므로 웹에서도 `useLocation` 은 살아 있다.

## GPS 없이 테스트하기

시뮬레이터·브라우저엔 실제 GPS 가 없다. 이동을 흉내 내려면:

- **iOS Simulator**: Features → Location → **Custom Location**(고정 좌표) 또는 **Freeway Drive**
  (자동 이동, 셀 경계를 넘나드는 점령 테스트에 유용).
- **Android Emulator**: Extended controls(`...`) → Location 으로 좌표 주입 / 경로 재생.
- **브라우저**: DevTools → Sensors 패널에서 위치를 오버라이드. 안드로이드 에뮬레이터의 일부
  환경에선 GPS 가 아예 안 잡히니, 실패하면 실기기로 확인한다.

## game-mechanics 와의 경계 (가장 중요)

이 스킬은 **`coords` 를 내보내는 데서 끝난다.** 그다음은 game-mechanics 영역이다.

```
[location-tracking]                 [game-mechanics]
watchPositionAsync ─ coords ──▶ cellKeyAt(lat,lng)  (src/grid.js)
                                      │
                                      ▼
                                 occupied 갱신 + 쿨다운(COOLDOWN_MS) 판정
                                 + XP/포인트 부여  (src/game.js)
```

- 좌표를 셀 키로 바꾸는 `cellKeyAt`(src/grid.js)과 점령/XP/쿨다운 처리(src/game.js)는
  **이 스킬이 손대지 않는다.** "위치를 받으면 점령된다"까지 한 번에 고치라는 요청이 오면,
  좌표 수집까지만 이 스킬로 처리하고 점령 로직은 game-core-engineer 에게 넘긴다.
- 거꾸로, 보상이 안 들어온다는 증상이 "콜백이 아예 안 불린다"이면 그건 위치 문제라 이 스킬 소관.
  "콜백은 불리는데 점령이 안 된다"이면 game-mechanics 소관. 증상으로 경계를 가른다.

## 팀 통신

- 위치 옵션(간격·정확도)을 바꿔 보상 빈도에 영향이 갈 때는 **game-core-engineer** 와 맞춘다.
- app.json 권한/플러그인을 바꿔 네이티브 재빌드가 필요해지면 **expo-build-qa** 에 알린다.

## 에러 핸들링

권한 거절·좌표 미수신은 한 번 재시도하고, 그래도 안 되면 상태를 `'denied'` 등으로 명시해
사용자에게 드러낸다(조용히 삼키지 않는다). "아직 안 붙은 것"(예: 걸음수 pedometer 축)은
누락으로 명시하고 진행한다.

## 이전 산출물 처리

`_workspace/` 에 이전 결과가 있으면 읽고 개선한다. 부분 피드백이면 지적된 부분만 고치고
나머지는 건드리지 않는다.
