---
name: game-mechanics
description: >-
  walkmon 게임 규칙(H3 헥스 그리드, 셀 점령/재방문 쿨다운, XP·레벨·성장 단계, 지역
  아이템 테마, 상태 영속화)을 추가·수정할 때 쓴다. 트리거 상황 — "점령 로직 고쳐줘",
  "그리드 해상도 바꿔줘", "XP 곡선 조정", "레벨업 너무 빠르다/느리다", "성장 단계 추가",
  "쿨다운 1시간을 30분으로", "아이템 테마 추가", "드랍 확률 올려줘", "셀 키 규칙 변경",
  "상태 저장 구조 바꿔줘", "밸런스 조정". 후속 키워드 — 다시/재실행/수정/보완/추가/되돌려도
  이 스킬을 쓴다. 단, 위치 추적(watchPositionAsync·권한·distanceInterval)은
  location-tracking 스킬, 화면 렌더(헥스 폴리곤·도트 스프라이트)는 pixel-rendering
  스킬이 담당하니 이 스킬로 처리하지 않는다.
---

# game-mechanics — walkmon 게임 규칙

walkmon 의 게임 로직은 순수 JS 모듈 세 개와 App.js 의 점령 처리기에 모여 있다. 렌더·위치·플랫폼과 무관한 "규칙 계층"이다. 이 스킬은 그 규칙을 바꿀 때 어디를 만지고, 왜 그렇게 되어 있는지를 다룬다.

## 절대 규칙 (먼저 확인)

- 게임 로직은 플랫폼 무관이다. `src/game.js` `src/grid.js` `src/items.js` 는 web/iOS/Android 가 똑같이 쓴다. 여기에 `Platform.OS` 분기나 렌더 코드를 넣지 마라. 시각 분리는 `GameMap.js` / `GameMap.web.js` 와 pixel-rendering 스킬의 몫이다.
- AsyncStorage 등 Expo/네이티브 API 를 새로 쓸 때만 Expo 56 문서(https://docs.expo.dev/versions/v56.0.0/)와 라이브러리 현행 API 를 확인한다. 순수 게임 로직(곡선·상수·해시)은 레포 내부 규칙이라 외부 문서가 필요 없다.
- 최소 변경: 밸런스 한 줄 바꾸려고 함수 시그니처를 갈아엎지 마라. 상수는 상수만, 곡선은 곡선만 손댄다. 인접 서식·주석 임의 변경 금지.

## 파일 지도 (무엇이 어디에)

| 관심사 | 파일 | 핵심 export |
|---|---|---|
| 밸런스 상수·성장 곡선 | `src/game.js` | `COOLDOWN_MS`, `NEW_CELL_XP`, `REVISIT_XP`, `NEW_CELL_POINTS`, `REVISIT_POINTS`, `levelFromXp`, `stageFromLevel` |
| H3 헥스 그리드 | `src/grid.js` | `H3_RESOLUTION`, `cellKeyAt`, `cellsAround` |
| 지역 아이템 테마·드랍 | `src/items.js` | `cellTheme`, `rollItem` |
| 점령 판정·상태·영속화 | `App.js` | `handleCoords`, `STORAGE_KEY` |

규칙을 바꾸려면 거의 항상 이 넷 중 하나다. 새 규칙 모듈을 만들기 전에 위 파일에 들어갈 자리가 없는지 먼저 본다(과한 분리 회피).

## H3 헥스 그리드 규약

`src/grid.js` 가 좌표를 육각 셀로 변환한다. h3-js **v4** API 만 쓴다(v3 의 `geoToH3`/`h3ToGeoBoundary`/`kRing` 아님).

- `latLngToCell(lat, lng, res)` → 셀 키(H3 인덱스 문자열). 이 키 자체가 "지역" 식별자다. DB id 처럼 다룬다.
- `cellToBoundary(key)` → `[[lat, lng], ...]` 꼭짓점 6개(육각이므로 항상 6개).
- `gridDisk(origin, ring)` → 중심 포함 주변 셀 키 배열. ring=6 이면 약 127칸.

```js
export const H3_RESOLUTION = 10; // ≈ 한 칸 폭 130m, 보행 적합

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

`cellsAround` 의 반환 shape 은 `[{ key, corners: [{latitude, longitude} x6] }]` 다. `corners` 가 `{latitude, longitude}` 객체 배열인 이유는 네이티브 `react-native-maps` 의 `<Polygon coordinates>` 가 그 모양을 그대로 먹기 때문이다. 이 shape 을 바꾸면 `GameMap.js` 도 같이 깨지니, 바꿀 거면 pixel-rendering 쪽과 맞춰야 한다.

**해상도(res) 바꿀 때.** `H3_RESOLUTION` 한 곳만 고치면 `cellKeyAt`/`cellsAround` 가 같이 따라온다(둘 다 기본값으로 참조). 9 로 낮추면 칸이 커져 자동차 이동에 맞고, 11 로 올리면 칸이 잘게 쪼개져 보행도 빡빡해진다. **주의:** 해상도를 바꾸면 셀 키 체계가 전부 달라진다 → 기존에 저장된 `occupied`(이전 해상도 키)와 호환되지 않는다. 마이그레이션이 없으면 점령 기록이 통째로 무의미해진다. 해상도 변경은 곧 저장 키 스키마 변경임을 인지하고, 필요하면 `STORAGE_KEY` 버전을 올린다(아래 영속화 절 참고).

**ring 바꿀 때.** `cellsAround` 의 `ring` 은 화면에 깔 타일 개수만 정한다(시각 범위). 점령 판정과는 무관하다. ring 을 키우면 칸 수가 ring² 으로 늘어 렌더 비용이 커지니 보행 화면에선 6 안팎이 적당하다.

## 점령 / 재방문 쿨다운

점령 판정은 `App.js` 의 `handleCoords` 에 있다. 좌표가 들어올 때마다 현재 셀 키를 구하고, 보상 지급 여부를 결정한다.

```js
setOccupied((prev) => {
  const now = Date.now();
  const cell = prev[key];
  const isNew = !cell;
  const cooled = cell && now - cell.lastVisit > COOLDOWN_MS;
  if (!isNew && !cooled) return prev; // 아직 보상 없음

  setXp((x) => x + (isNew ? NEW_CELL_XP : REVISIT_XP));

  const item = rollItem(key);
  if (item) setItems((arr) => [{ item, key, t: now }, ...arr].slice(0, 20));

  return {
    ...prev,
    [key]: {
      points: (cell?.points || 0) + (isNew ? NEW_CELL_POINTS : REVISIT_POINTS),
      lastVisit: now,
    },
  };
});
```

규칙은 세 갈래다.

1. **신규 셀**(`isNew`): 큰 보상. 탐험을 유도하는 핵심.
2. **재방문 + 쿨다운 경과**(`cooled`): 작은 보상. 같은 길을 다시 걸어도 약간은 준다.
3. **재방문 + 쿨다운 미경과**: `return prev` 로 아무것도 안 준다. **제자리 파밍 방지**의 본체다.

**왜 쿨다운인가.** 위치 게임의 고질병은 한자리에 서서 GPS 흔들림으로 보상을 긁는 행위다. `COOLDOWN_MS`(1시간) 가 같은 셀의 재보상 간격을 막아 "걸어야 보상이 난다"는 규칙을 강제한다. 쿨다운을 짧게(예: 30분) 하면 회유 동선이 짧은 사용자에게 유리해지고, 길게 하면 신규 탐험 압력이 커진다.

**비교는 `>` 다(`>=` 아님).** `now - cell.lastVisit > COOLDOWN_MS`. 경계에서 1ms 차이는 게임상 의미가 없으니 둘 중 무엇을 써도 되지만, 기존 코드가 `>` 이므로 바꿀 이유가 없으면 그대로 둔다(최소 변경).

**상태가 갈래마다 다르다.** `points`(셀 누적치)는 `occupied[key]` 안에, `xp`(전역 경험치)는 별도 state 다. 새 보상 종류를 넣을 땐 "셀 단위로 쌓이는 값인가, 전역으로 쌓이는 값인가"를 먼저 정하고 자리를 고른다.

## XP / 레벨 / 성장 단계

`src/game.js` 의 두 순수 함수가 전부다.

```js
export function levelFromXp(xp) {
  return Math.floor(Math.sqrt(xp / 50)) + 1; // sqrt 곡선: 초반 빠르고 뒤로 완만
}

const STAGES = ['알', '아기', '청소년', '성체', '진화체'];
export function stageFromLevel(level) {
  if (level >= 20) return STAGES[4];
  if (level >= 12) return STAGES[3];
  if (level >= 6) return STAGES[2];
  if (level >= 2) return STAGES[1];
  return STAGES[0];
}
```

**왜 sqrt 곡선인가.** 선형(`xp/50`)이면 후반에도 같은 노력으로 같은 레벨이 올라 지루해진다. sqrt 는 초반 레벨업을 빠르게 줘 첫인상을 살리고, 뒤로 갈수록 같은 한 레벨에 필요한 XP 가 제곱으로 늘어 장기 목표가 된다. 레벨 L 에 필요한 XP 는 `50 * (L-1)²` 다.

**레벨업 속도 조정.** 분모 `50` 이 손잡이다. 키우면(예: 100) 전체적으로 느려지고, 줄이면 빨라진다. 더하는 `+ 1` 은 "XP 0 = Lv.1" 을 만드는 오프셋이라 보통 건드리지 않는다.

**성장 단계 추가/분기.** `STAGES` 배열과 `stageFromLevel` 의 임계 레벨이 짝이다. 단계를 넣으면 두 곳을 같이 고친다(배열에 라벨 추가 + 임계 `if` 한 줄 추가). 임계는 위에서 아래로 큰 레벨부터 검사하니 순서를 지킨다. 다마고치식 진화 분기(같은 레벨인데 조건에 따라 다른 성체)를 넣으려면 `stageFromLevel(level)` 을 `stageFromLevel(level, context)` 로 넓히고 분기 조건을 인자로 받는다 — 이때만 시그니처 변경이 정당하다.

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

게임 상태는 App.js 의 React state 세 개이고, 그중 영속화 대상도 셋이다.

```js
const STORAGE_KEY = 'walkmon_state_v1';

// shape
occupied: { [cellKey]: { points: number, lastVisit: number } }
xp:       number
items:    [{ item: string, key: cellKey, t: number }]  // 최근 20개
```

- `occupied`: 셀별 누적 점수와 마지막 방문 시각(쿨다운 판정용 epoch ms). 키는 H3 셀 키.
- `xp`: 전역 경험치. 레벨·단계는 여기서 파생(저장 안 함).
- `items`: 최근 획득 로그, 최신순 20개로 잘린다.

영속화 패턴은 "불러오기 1회 + 변경마다 저장" 이다.

```js
const loaded = useRef(false);

// 1) 마운트 시 1회 로드
useEffect(() => {
  (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        setOccupied(s.occupied || {});
        setXp(s.xp || 0);
        setItems(s.items || []);
      }
    } catch {}
    loaded.current = true;
  })();
}, []);

// 2) 상태가 바뀔 때마다 저장 (단, 첫 로드 전엔 건너뜀)
useEffect(() => {
  if (!loaded.current) return;
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ occupied, xp, items })).catch(() => {});
}, [occupied, xp, items]);
```

**`loaded` 가드가 핵심이다.** 이게 없으면 마운트 직후 빈 초기값(`{}`, `0`, `[]`)이 저장 effect 를 먼저 발동시켜, 로드가 끝나기 전에 저장된 데이터를 빈 값으로 덮어쓴다. 새 영속 필드를 추가할 때도 이 가드 안쪽에서 저장한다.

**새 필드 영속화.** 저장 객체 `{ occupied, xp, items }` 에 키를 더하고, 로드 쪽에서 `s.새필드 || 기본값` 으로 받는다. `|| 기본값` 은 구버전 저장본에 그 키가 없을 때를 위한 하위호환이다 — 빼먹으면 기존 사용자에서 `undefined` 가 새어 나온다.

**스키마가 깨지는 변경엔 키 버전을 올린다.** `walkmon_state_v1` → `_v2`. 셀 키 해상도 변경, `occupied` 값 구조 변경처럼 옛 데이터로 못 읽는 경우다. 키를 올리면 옛 데이터는 그냥 버려진다(마이그레이션 코드를 따로 안 짜는 한). 버리기 싫으면 옛 키를 읽어 변환 후 새 키로 저장하는 일회성 마이그레이션을 로드 effect 에 넣는다.

## 밸런스 손잡이 한눈에

전부 `src/game.js`(보상·곡선)와 `src/items.js`(드랍)에 있다. 밸런스만 만질 땐 이 상수들만 건드리고 함수 구조는 두는 게 정석이다.

| 손잡이 | 위치 | 효과 |
|---|---|---|
| `COOLDOWN_MS` | game.js | 재방문 재보상 간격. 짧으면 회유 동선 유리, 길면 신규 탐험 압력 ↑ |
| `NEW_CELL_XP` / `REVISIT_XP` | game.js | 신규 vs 재방문 XP 보상비. 격차가 클수록 탐험 유도 강함 |
| `NEW_CELL_POINTS` / `REVISIT_POINTS` | game.js | 셀 누적 점수(`occupied[key].points`) 증가량 |
| `levelFromXp` 분모 `50` | game.js | 전체 레벨업 속도. ↑ 느리게, ↓ 빠르게 |
| `STAGES` + 임계 레벨 | game.js | 성장 단계 라벨과 진화 시점 |
| `DROP_CHANCE` | items.js | 셀 진입 시 아이템 드랍 확률 |
| `ITEM_POOLS` | items.js | 지역 테마와 아이템 풀 |
| `H3_RESOLUTION` | grid.js | 셀 크기(보행/자동차). 바꾸면 저장 키 호환 깨짐 — 영속화 절 참고 |

## 변경 후 점검

- 밸런스만 바꿨으면 곡선 의도가 맞는지 손계산으로 확인한다(예: `levelFromXp(50)` = Lv.2, `levelFromXp(200)` = Lv.3).
- `cellsAround` 반환 shape 을 건드렸으면 `GameMap.js`(네이티브 Polygon)와 어긋나지 않는지 확인하고, 시각 쪽은 pixel-rendering 스킬 영역임을 인지한다.
- 저장 스키마를 바꿨으면 구버전 저장본 로드 시 `|| 기본값` 방어가 되는지, 필요하면 `STORAGE_KEY` 를 올렸는지 확인한다.
- 실행 확인(`expo start`, 시뮬레이터/웹 구동, 네이티브 재빌드 여부)은 expo-build-run 스킬(expo-build-qa 에이전트)에 맡긴다.

## 관련

- 이 스킬의 주 사용자는 **game-core-engineer** 에이전트다.
- 좌표가 어떻게 `handleCoords` 로 들어오는지(권한·watchPositionAsync·distanceInterval)는 **location-tracking** 스킬을 본다. 이 스킬은 "좌표가 들어온 다음"의 규칙만 다룬다.
- 셀·캐릭터를 화면에 그리는 일은 **pixel-rendering** 스킬이다.
