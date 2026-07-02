---
name: game-mechanics
description: >-
  walkmon 게임 규칙(H3 헥스 그리드, 셀 점령/재방문 쿨다운, XP·레벨·성장 단계, 지역
  아이템 테마, 상태 영속화)을 추가·수정할 때 쓴다. 트리거 상황 — "점령 로직 고쳐줘",
  "그리드 해상도 바꿔줘", "XP 곡선 조정", "레벨업 너무 빠르다/느리다", "성장 단계 추가",
  "쿨다운 1시간을 30분으로", "아이템 테마 추가", "드랍 확률 올려줘", "셀 키 규칙 변경",
  "상태 저장 구조 바꿔줘", "밸런스 조정". 후속 키워드 — 다시/재실행/수정/보완/추가/되돌려도
  이 스킬을 쓴다. 단, 위치 추적(watchPositionAsync·권한·distanceInterval)은
  location-tracking 스킬, 화면 렌더(헥스 도트 타일·스프라이트)는 pixel-rendering
  스킬이 담당하니 이 스킬로 처리하지 않는다.
---

# game-mechanics — walkmon 게임 규칙

walkmon 의 게임 로직은 순수 JS 모듈 세 개와 App.js 의 점령 처리기에 모여 있다. 렌더·위치·플랫폼과 무관한 "규칙 계층"이다. 이 스킬은 그 규칙을 바꿀 때 어디를 만지고, 왜 그렇게 되어 있는지를 다룬다.

## 절대 규칙 (먼저 확인)

- 게임 로직은 플랫폼 무관이다. `src/game.js` `src/grid.js` `src/items.js` 는 web/iOS/Android 가 똑같이 쓴다. 여기에 `Platform.OS` 분기나 렌더 코드를 넣지 마라. 시각 분리는 `PixelHexMap.js` / `PixelHexMap.web.js` 와 pixel-rendering 스킬의 몫이다.
- AsyncStorage 등 Expo/네이티브 API 를 새로 쓸 때만 Expo 56 문서(https://docs.expo.dev/versions/v56.0.0/)와 라이브러리 현행 API 를 확인한다. 순수 게임 로직(곡선·상수·해시)은 레포 내부 규칙이라 외부 문서가 필요 없다.
- 최소 변경: 밸런스 한 줄 바꾸려고 함수 시그니처를 갈아엎지 마라. 상수는 상수만, 곡선은 곡선만 손댄다. 인접 서식·주석 임의 변경 금지.

## 파일 지도 (무엇이 어디에)

| 관심사 | 파일 | 핵심 export |
|---|---|---|
| 밸런스 상수·성장 | `src/game.js` | `COOLDOWN_MS`, `NEW_CELL_XP`, `REVISIT_XP`, `NEW_CELL_POINTS`, `REVISIT_POINTS`, `STAGES`, `STAGE_MAX_LEVEL`, `XP_PER_LEVEL`, `levelInStage`, `canEvolve` |
| H3 헥스 그리드 | `src/grid.js` | `H3_RESOLUTION`, `cellKeyAt`, `cellsAround`, `cornersOf` |
| 지역 아이템 테마·드랍 | `src/items.js` | `cellTheme`, `rollItem` |
| 점령 판정·진화·영속화(순수 함수) | `src/occupy.js` | `applyVisit`, `evolve`, `STORAGE_KEY`, `INITIAL_STATE` |
| 좌표 처리·상태 배선 | `App.js` | `handleCoords`(applyVisit 호출), 진화 버튼(evolve) |

규칙을 바꾸려면 거의 항상 이 넷 중 하나다. 새 규칙 모듈을 만들기 전에 위 파일에 들어갈 자리가 없는지 먼저 본다(과한 분리 회피).

## H3 헥스 그리드 규약

`src/grid.js` 가 좌표를 육각 셀로 변환한다. h3-js **v4** API 만 쓴다(v3 의 `geoToH3`/`h3ToGeoBoundary`/`kRing` 아님).

- `latLngToCell(lat, lng, res)` → 셀 키(H3 인덱스 문자열). 이 키 자체가 "지역" 식별자다. DB id 처럼 다룬다.
- `cellToBoundary(key)` → `[[lat, lng], ...]` 꼭짓점 6개(육각이므로 항상 6개).
- `gridDisk(origin, ring)` → 중심 포함 주변 셀 키 배열. ring=6 이면 약 127칸.

```js
export const H3_RESOLUTION = 11; // ≈ 한 칸 폭 50m, 보행·고정 줌 뷰

export function cellKeyAt(lat, lng, res = H3_RESOLUTION) {
  return latLngToCell(lat, lng, res);
}

export function cellsAround(lat, lng, res = H3_RESOLUTION, ring = 6) {
  const origin = latLngToCell(lat, lng, res);
  return gridDisk(origin, ring).map((key) => ({
    key,
    corners: cellToBoundary(key).map(([clat, clng]) => ({
      latitude: clat,
      longitude: clng,
    })),
  }));
}
```

`cellsAround` 의 반환 shape 은 `[{ key, corners: [{latitude, longitude} x6] }]` 다. `corners` 가 `{latitude, longitude}` 객체 배열인 건 레거시 react-native-maps Polygon 규약의 잔재다. 현재 렌더(`PixelHexMap.js`, react-native-skia)는 화면 격자를 H3 에 역매핑해 그리므로 이 배열을 prop(gridCells)으로 받진 않지만, `cellsAround`/`cornersOf` 의 이 shape 자체는 유지한다. 바꿀 거면 pixel-rendering 쪽과 맞춘다.

**해상도(res) 바꿀 때.** `H3_RESOLUTION` 한 곳만 고치면 `cellKeyAt`/`cellsAround` 가 같이 따라온다(둘 다 기본값으로 참조). 9 로 낮추면 칸이 커져 자동차 이동에 맞고, 11 로 올리면 칸이 잘게 쪼개져 보행도 빡빡해진다. **주의:** 해상도를 바꾸면 셀 키 체계가 전부 달라진다 → 기존에 저장된 `occupied`(이전 해상도 키)와 호환되지 않는다. 마이그레이션이 없으면 점령 기록이 통째로 무의미해진다. 해상도 변경은 곧 저장 키 스키마 변경임을 인지하고, 필요하면 `STORAGE_KEY` 버전을 올린다(아래 영속화 절 참고).

**ring 바꿀 때.** `cellsAround` 의 `ring` 은 화면에 깔 타일 개수만 정한다(시각 범위). 점령 판정과는 무관하다. ring 을 키우면 칸 수가 ring² 으로 늘어 렌더 비용이 커지니 보행 화면에선 6 안팎이 적당하다.

## 점령 / 재방문 쿨다운

점령 판정은 `src/occupy.js` 의 순수 함수 `applyVisit` 에 있고, `App.js` 의 `handleCoords` 가 이를 호출한다(`setGameState((prev) => applyVisit(prev, coords, Date.now()).state)`). React 에 의존하지 않는 순수 함수라 포그라운드와 백그라운드가 같은 규칙을 공유한다.

```js
export function applyVisit(state, coords, now) {
  const key = cellKeyAt(coords.latitude, coords.longitude);
  const cell = state.occupied[key];
  const isNew = !cell;
  const cooled = cell && now - cell.lastVisit > COOLDOWN_MS;
  if (!isNew && !cooled) return { state, changed: false, currentKey: key }; // 보상 없음: 같은 참조 반환

  const stageXp = state.stageXp + (isNew ? NEW_CELL_XP : REVISIT_XP);
  const item = rollItem(key);
  const items = item ? [{ item, key, t: now }, ...state.items].slice(0, 20) : state.items;
  const occupied = {
    ...state.occupied,
    [key]: {
      points: (cell?.points || 0) + (isNew ? NEW_CELL_POINTS : REVISIT_POINTS),
      lastVisit: now,
    },
  };
  return { state: { occupied, stageIndex: state.stageIndex, stageXp, items }, changed: true, currentKey: key };
}
```

규칙은 세 갈래다.

1. **신규 셀**(`isNew`): 큰 보상. 탐험을 유도하는 핵심.
2. **재방문 + 쿨다운 경과**(`cooled`): 작은 보상. 같은 길을 다시 걸어도 약간은 준다.
3. **재방문 + 쿨다운 미경과**: `changed: false` 로 입력 state 를 같은 참조로 돌려줘 보상도 리렌더도 없다. **제자리 파밍 방지**의 본체다.

**왜 쿨다운인가.** 위치 게임의 고질병은 한자리에 서서 GPS 흔들림으로 보상을 긁는 행위다. `COOLDOWN_MS`(1시간) 가 같은 셀의 재보상 간격을 막아 "걸어야 보상이 난다"는 규칙을 강제한다. 쿨다운을 짧게(예: 30분) 하면 회유 동선이 짧은 사용자에게 유리해지고, 길게 하면 신규 탐험 압력이 커진다.

**비교는 `>` 다(`>=` 아님).** `now - cell.lastVisit > COOLDOWN_MS`. 경계에서 1ms 차이는 게임상 의미가 없으니 둘 중 무엇을 써도 되지만, 기존 코드가 `>` 이므로 바꿀 이유가 없으면 그대로 둔다(최소 변경).

**상태가 갈래마다 다르다.** `points`(셀 누적치)는 `occupied[key]` 안에, XP 는 현재 단계 누적 `stageXp`(gameState 최상위) 다. 새 보상 종류를 넣을 땐 "셀 단위로 쌓이는 값인가, 전역으로 쌓이는 값인가"를 먼저 정하고 자리를 고른다.

## XP / 레벨 / 성장 단계

성장은 단계별 만렙 + 수동 진화 모델이다. `src/game.js` 가 단계·상수·판정 함수를 갖고, 진화 실행(`evolve`)은 `src/occupy.js` 에 있다.

```js
export const STAGES = ['알', '유년', '소년', '청년', '성년']; // 일직선 5단계
export const STAGE_MAX_LEVEL = [10, 20, 30, 40, 50];          // 단계별 만렙
export const XP_PER_LEVEL = 30;                                // 레벨당 필요 XP(구간 무관)

// 현재 단계 내 레벨. 만렙에서 클램프 → 초과 XP 는 stageXp 에만 쌓였다가 진화 시 이월.
export function levelInStage(stageXp, stageIndex) {
  return Math.min(Math.floor(stageXp / XP_PER_LEVEL), STAGE_MAX_LEVEL[stageIndex]);
}

// 진화 가능 여부. 만렙 도달 + 마지막 단계 아님. 실제 진화는 플레이어가 직접(자동 없음).
export function canEvolve(stageXp, stageIndex) {
  return stageIndex < STAGES.length - 1 &&
    levelInStage(stageXp, stageIndex) >= STAGE_MAX_LEVEL[stageIndex];
}
```

**왜 단계별 만렙인가.** 전역 곡선(옛 sqrt)은 진화가 자동으로 일어나 "키우는 맛"이 약했다. 이제 단계마다 레벨 0부터 다시 시작하고 만렙에서 멈춰, 플레이어가 직접 진화 버튼을 눌러야 다음 단계로 간다(다마고치식). `XP_PER_LEVEL`(=30)은 레벨당 신규 3칸(신규 +10)이며 구간·단계와 무관하게 일정하다.

**진화와 이월.** 만렙 도달 후에도 XP 는 `stageXp` 에 계속 쌓이지만 레벨은 만렙에서 클램프된다. 진화(`occupy.js` 의 `evolve`)는 `stageIndex` 를 +1 하고 `stageXp -= STAGE_MAX_LEVEL[old] * XP_PER_LEVEL` 로 초과분을 다음 단계로 이월한다. 만렙 후 걸은 XP 는 버려지지 않는다.

**단계 추가/만렙 조정.** `STAGES` 와 `STAGE_MAX_LEVEL` 은 인덱스로 짝이다(같은 길이 유지). 단계를 넣으면 두 배열의 같은 자리에 추가하고, 만렙만 바꾸려면 `STAGE_MAX_LEVEL` 숫자만 만진다. `levelInStage`/`canEvolve` 는 배열을 참조하므로 함수는 안 건드려도 된다.

## 지역 아이템 테마 (셀 키 시드 결정성)

`src/items.js` 는 셀 키를 시드로 한 결정적 RNG 로 "이 지역엔 이 아이템" 느낌을 만든다. 같은 셀은 언제 와도 같은 테마, 같은 드랍 결과다.

- `hashStr(셀키)` → 32bit 해시. 이걸 `ITEM_POOLS` 길이로 나눈 나머지가 테마 인덱스 → 테마는 셀마다 고정.
- `cellTheme(cellKey)` → 그 셀의 테마 이름(풀숲/도심/물가/언덕). App 카드의 "현재 지역" 표시에 쓴다.
- `rollItem(cellKey)` → `mulberry32(hashStr(cellKey + ':loot'))` 시드 RNG 로 드랍 판정. `DROP_CHANCE`(0.6) 미만이면 아이템, 아니면 `null`.

```js
const DROP_CHANCE = 0.6; // 셀 진입 시 아이템이 나올 확률

export function rollItem(cellKey) {
  const pool = ITEM_POOLS[hashStr(cellKey) % ITEM_POOLS.length];
  const rng = mulberry32(hashStr(cellKey + ':loot'));
  if (rng() > DROP_CHANCE) return null;
  return pool.items[Math.floor(rng() * pool.items.length)];
}
```

**왜 결정적 RNG 인가.** `Math.random()` 을 쓰면 같은 셀이 매번 다른 아이템을 뱉어 "지역색"이 사라지고, 저장 없이는 재현도 안 된다. 셀 키를 시드로 박으면 서버·저장 없이도 "강가 셀은 조개가 잘 나온다" 같은 일관성이 공짜로 생긴다.

**테마 추가.** `ITEM_POOLS` 배열에 `{ theme, items }` 를 더하면 끝이다(나머지 연산이 자동으로 새 길이에 맞춘다). 단, 풀 개수가 바뀌면 기존 셀들의 테마 배정이 통째로 재배치된다 — "어제 풀숲이던 동네가 오늘 도심"이 된다. 출시 후라면 이 점을 감안한다.

**드랍률·횟수 의존.** `DROP_CHANCE` 를 올리면 더 자주 나온다. "방문할수록 다른 드랍"을 원하면 파일 상단 주석대로 시드에 방문 횟수를 섞는다(예: `hashStr(cellKey + ':loot:' + visitCount)`). 단, 그러면 결정성이 "셀+횟수" 단위가 되니 `occupied[key].points` 같은 횟수 정보를 `rollItem` 에 넘겨야 한다 — `handleCoords` 호출부도 같이 바뀐다.

향후 OSM 태그(공원/물가/도심)로 테마를 정하는 계획이 파일 주석에 적혀 있다. 지금은 셀 키 해시가 그 자리표(placeholder)다.

## 상태 shape 과 영속화

게임 상태는 `App.js` 의 단일 `gameState` 객체이고, 그 shape·기본값·저장 키는 `src/occupy.js` 가 정의한다(포그라운드·백그라운드 공유).

```js
// src/occupy.js
export const STORAGE_KEY = 'walkmon_state_v3';
export const INITIAL_STATE = { occupied: {}, stageIndex: 0, stageXp: 0, items: [] };

// shape
occupied:   { [cellKey]: { points: number, lastVisit: number } }
stageIndex: number   // 0~4 (현재 성장 단계)
stageXp:    number   // 현재 단계 내 누적 XP (진화 시 이월 계산)
items:      [{ item: string, key: cellKey, t: number }]  // 최근 20개
```

- `occupied`: 셀별 누적 점수와 마지막 방문 시각(쿨다운 판정용 epoch ms). 키는 H3 셀 키.
- `stageIndex`/`stageXp`: 성장 단계와 단계 내 XP. 레벨·진화는 여기서 파생(`levelInStage`/`canEvolve`).
- `items`: 최근 획득 로그, 최신순 20개로 잘린다.

영속화는 `App.js` 에서 "불러오기 1회 + 변경마다 저장" 이다. `gameState` 를 통째로 직렬화한다.

```js
const loaded = useRef(false);

// 1) 마운트 시 1회 로드. 누락 필드는 INITIAL_STATE 로 메워 하위호환.
useEffect(() => {
  (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) setGameState({ ...INITIAL_STATE, ...JSON.parse(raw) });
    } catch {}
    loaded.current = true;
  })();
}, []);

// 2) 상태가 바뀔 때마다 저장 (첫 로드 전엔 건너뜀)
useEffect(() => {
  if (!loaded.current) return;
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(gameState)).catch(() => {});
}, [gameState]);
```

**`loaded` 가드가 핵심이다.** 이게 없으면 마운트 직후 빈 초기값(`INITIAL_STATE`)이 저장 effect 를 먼저 발동시켜, 로드가 끝나기 전에 저장된 데이터를 빈 값으로 덮어쓴다. 새 영속 필드를 추가할 때도 이 가드 안쪽에서 저장한다.

**새 필드 영속화.** `INITIAL_STATE` 에 키를 더하면 `{ ...INITIAL_STATE, ...저장본 }` 병합이 구버전 저장본의 누락 필드를 자동으로 기본값으로 메운다 — 별도 `|| 기본값` 방어가 필요 없다.

**스키마가 깨지는 변경엔 키 버전을 올린다.** `walkmon_state_v3` → `_v4`. 셀 키 해상도 변경, 상태 shape 변경처럼 옛 데이터로 못 읽는 경우다. 키를 올리면 옛 데이터는 그냥 버려진다(=초기화). 버리기 싫으면 옛 키를 읽어 변환 후 새 키로 저장하는 일회성 마이그레이션을 로드 effect 에 넣는다. (성장 shape 을 xp → stageIndex/stageXp 로 바꾸며 v2→v3 로 올린 게 이 경우다.)

## 밸런스 손잡이 한눈에

전부 `src/game.js`(보상·곡선)와 `src/items.js`(드랍)에 있다. 밸런스만 만질 땐 이 상수들만 건드리고 함수 구조는 두는 게 정석이다.

| 손잡이 | 위치 | 효과 |
|---|---|---|
| `COOLDOWN_MS` | game.js | 재방문 재보상 간격. 짧으면 회유 동선 유리, 길면 신규 탐험 압력 ↑ |
| `NEW_CELL_XP` / `REVISIT_XP` | game.js | 신규 vs 재방문 XP 보상비. 격차가 클수록 탐험 유도 강함 |
| `NEW_CELL_POINTS` / `REVISIT_POINTS` | game.js | 셀 누적 점수(`occupied[key].points`) 증가량 |
| `XP_PER_LEVEL`(=30) | game.js | 레벨당 필요 XP. ↑ 느리게, ↓ 빠르게(레벨당 신규 칸 수) |
| `STAGES` + `STAGE_MAX_LEVEL` | game.js | 성장 단계 라벨과 단계별 만렙(진화 시점) |
| `DROP_CHANCE` | items.js | 셀 진입 시 아이템 드랍 확률 |
| `ITEM_POOLS` | items.js | 지역 테마와 아이템 풀 |
| `H3_RESOLUTION` | grid.js | 셀 크기(보행/자동차). 바꾸면 저장 키 호환 깨짐 — 영속화 절 참고 |

## 변경 후 점검

- 밸런스만 바꿨으면 의도가 맞는지 손계산으로 확인한다(예: `levelInStage(90, 0)` = Lv.3, `canEvolve(300, 0)` = true, `canEvolve(299, 0)` = false).
- `cellsAround` 반환 shape 을 건드렸으면 렌더(`PixelHexMap.js`, react-native-skia)의 H3 역매핑과 어긋나지 않는지 확인하고, 시각 쪽은 pixel-rendering 스킬 영역임을 인지한다.
- 저장 스키마를 바꿨으면 구버전 저장본 로드 시 `|| 기본값` 방어가 되는지, 필요하면 `STORAGE_KEY` 를 올렸는지 확인한다.
- 실행 확인(`expo start`, 시뮬레이터/웹 구동, 네이티브 재빌드 여부)은 expo-build-run 스킬(expo-build-qa 에이전트)에 맡긴다.

## 관련

- 이 스킬의 주 사용자는 **game-core-engineer** 에이전트다.
- 좌표가 어떻게 `handleCoords` 로 들어오는지(권한·watchPositionAsync·distanceInterval)는 **location-tracking** 스킬을 본다. 이 스킬은 "좌표가 들어온 다음"의 규칙만 다룬다.
- 셀·캐릭터를 화면에 그리는 일은 **pixel-rendering** 스킬이다.
