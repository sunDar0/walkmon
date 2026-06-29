---
name: pixel-rendering
description: >-
  walkmon 도트(픽셀) 렌더링 작업을 수행한다. react-native-skia 로 정사각 바닥
  타일맵 + H3 헥스 점령 오버레이 + 중앙 캐릭터 스프라이트를 그리고, nearest-neighbor
  정수배 스케일로 픽셀을 선명하게 유지하며, H3 cellToBoundary 위경도를 화면 픽셀로
  투영하고, 플레이어=화면중앙 카메라/스크롤을 구현한다. 트리거 — 도트/픽셀 그래픽,
  Skia 렌더, 타일맵/스프라이트/헥스 시각화, 맵 아트, 카메라/스크롤, 타일셋 에셋 규격을
  만들거나 다시/재실행/수정/보완/추가할 때. 위치 추적 로직(useLocation)이나 점령/XP
  규칙(game.js) 자체를 바꾸는 작업은 이 스킬이 아니다 — 그건 location-tracking·
  game-mechanics 영역이다. 네이티브 빌드 실행/디버깅 자체는 expo-build-run 으로 넘긴다.
---

# pixel-rendering — walkmon 도트 렌더

이 스킬은 pixel-render-engineer 가 walkmon 의 시각 레이어를 만들 때 쓴다. 위치/점령/아이템
로직은 이미 `src/useLocation.js`, `src/game.js`, `src/grid.js`, `src/items.js` 에 있다.
여기서는 그 상태를 **도트 그래픽으로 그리는 일**만 한다.

## 절대 규칙 (작업 전 반드시 확인)

- **Expo 56 문서 우선**: 코드 작성 전 https://docs.expo.dev/versions/v56.0.0/ 와
  react-native-skia 현행 문서(https://shopify.github.io/react-native-skia/)를 확인한다.
  기억에만 의존하지 않는다. Skia 는 SDK 버전·아키텍처에 민감하다.
- **외과적 최소 변경**: 요청과 직결된 라인만 건드린다. 추측성 추상화·옵션·예외처리를
  새로 만들지 않는다. 인접 코드 서식을 임의로 바꾸지 않는다.
- **웹/네이티브 분리 유지**: 기존 `GameMap.js`(네이티브) / `GameMap.web.js`(웹=null)
  패턴을 그대로 따른다. 아래 "플랫폼 분리 결정"을 지킨다.
- **주석 언어**: 도메인 설명은 한국어, 라이브러리/API 설명은 영어 허용. 식별자는 영어.

## 왜 "정사각 바닥 + 헥스 오버레이"인가 (이걸 먼저 이해할 것)

두 격자가 공존하는 이유를 모르면 레이어를 잘못 섞는다.

- **도트의 본질은 정사각**이다. 픽셀 아트 타일·스프라이트는 정사각(또는 직사각) 그리드에서만
  선명하게 정렬된다. 그래서 **바닥 타일맵은 정사각 픽셀 타일**로 깐다.
- **점령의 단위는 헥스(H3)**다. `grid.js` 가 위치를 H3 셀로 양자화하고, 점령/쿨다운/아이템
  드랍이 전부 셀 키 기준이다(`game.js`, `items.js`). 그래서 **점령 상태만 헥스 오버레이**로
  덮는다. 바닥을 헥스로 깔면 픽셀이 깨지고, 점령을 정사각으로 표시하면 도메인과 어긋난다.

결론: 바닥=정사각 픽셀(시각), 오버레이=헥스(도메인). 둘을 레이어로 분리해 각자의 격자를 쓴다.

## 플랫폼 분리 결정 — 네이티브만 Skia, 웹은 그대로 null

walkmon 의 기존 규약은 "웹 = 상태/로그만, 네이티브 = 지도/도트"다. 이 스킬은 그 규약을
**그대로 따른다**:

- 새 렌더러는 `src/PixelMap.js`(네이티브, Skia) / `src/PixelMap.web.js`(웹, `return null`)로
  플랫폼 파일을 나눈다. `GameMap.js` / `GameMap.web.js` 와 똑같은 패턴이다.
- **이유**: react-native-skia 의 웹 동작은 CanvasKit(WASM) 로딩 + Metro/Webpack 추가 설정이
  필요하다(아래 "웹 CanvasKit" 참고). walkmon 웹은 어차피 상태 카드 + 획득 로그만 보여주면
  되므로, 웹에 Skia 를 끌어들이면 번들·설정 비용만 늘고 얻는 게 없다. 그래서 **웹은 null**.
- 나중에 웹에서도 픽셀맵을 보여줘야 한다면 그때 CanvasKit 셋업을 추가한다. 지금은 하지 않는다.

`PixelMap` 은 `GameMap` 과 **같은 props 모양**(`coords`, `gridCells`, `occupied`, `currentKey`)을
받게 만든다. 그래야 App 쪽 호출부를 거의 안 바꾸고 갈아끼울 수 있다(최소 변경).

## (1) 설치 + 네이티브 재빌드

react-native-skia 는 **네이티브 모듈**이라 Expo Go 에서 안 돈다. dev build 가 필요하다.

```bash
# 설치 (Expo 버전에 맞는 핀을 골라줌 — npm install 대신 expo install 을 쓴다)
npx expo install @shopify/react-native-skia
```

설치 후 **네이티브 재빌드가 필수**다. JS 만 리로드해서는 네이티브 모듈이 안 잡힌다:

```bash
npx expo run:ios       # 또는
npx expo run:android
```

- 빌드 실행·실패 디버깅 자체는 이 스킬이 직접 끌고 가지 않는다. **expo-build-qa 에게 넘기고
  expo-build-run 스킬 절차를 따른다**(누가=에이전트, 어떻게=그 스킬). 여기서는 "설치했고
  재빌드가 필요하다"는 신호만 명확히 남긴다.
- new architecture(`newArchEnabled: true`)는 app.json 에 이미 켜져 있다. Skia 는 new arch 를
  지원하므로 추가 토글은 없다. 다만 재빌드 후 Pod 설치(iOS)가 한 번 더 돈다는 점만 기억한다.

## (2) 픽셀 선명도 — nearest-neighbor 정수배 스케일

픽셀이 흐려지는 원인은 두 가지다: (a) 보간 필터가 Linear, (b) 비정수 배율. 둘 다 막는다.

- **샘플링은 Nearest 로 고정**한다. Skia `<Image>` 의 `sampling` prop:

```js
import { FilterMode, MipmapMode } from "@shopify/react-native-skia";

// 작은 원본 타일/스프라이트를 큰 화면 사각형에 그릴 때 — 픽셀 경계가 또렷하게 유지된다.
<Image
  image={tile}
  x={px} y={py}
  width={TILE * SCALE} height={TILE * SCALE}
  fit="fill"
  sampling={{ filter: FilterMode.Nearest, mipmap: MipmapMode.Nearest }}
/>
```

  (Skia 기본값에 의존하지 말고 항상 `FilterMode.Nearest` 를 **명시한다**. 어떤 게 기본 샘플링인지에 기대지 않는다.)

- **배율은 정수만** 쓴다. 16px 타일을 3배로 키우면 48px. 1.5 같은 분수 배율은 픽셀이 뭉갠다.
  전체 월드를 한 `<Group transform={[{ scale: SCALE }]}>` 로 감싸고, 아트는 전부 1x(원본 px)로
  그린 뒤 Group 에서 정수배 확대한다. 이러면 좌표 계산도 1x 기준이라 단순해진다.
- **정수 픽셀 스냅**: 카메라 오프셋을 `Math.round` 로 정수 px 에 맞춘다. 서브픽셀 위치는 Nearest
  에서도 가장자리를 떨리게 만든다.

```js
export const TILE = 16;   // 원본 타일 한 변(px)
export const SCALE = 3;   // 정수 확대 배율 → 화면상 48px
```

## (3) H3 헥스 → 화면 픽셀 투영

`grid.js` 의 `cellsAround()` 가 각 셀의 6 꼭짓점을 `{ latitude, longitude }` 로 준다
(`cellToBoundary` 결과를 매핑한 것). 이 위경도를 **카메라 중심 기준 등거리 근사**로 화면 px 에
꽂는다. 작은 영역(보행 반경 수백 m)에서는 평면 근사로 충분하다.

```js
// 위경도 → 화면 픽셀. center = 플레이어 좌표(= 화면 중앙).
const M_PER_DEG_LAT = 111320; // 위도 1도 ≈ 111.32km (거의 상수)

function projectToScreen(lat, lng, center, screenW, screenH, pxPerMeter) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((center.latitude * Math.PI) / 180);
  const dxMeters = (lng - center.longitude) * mPerDegLng;
  const dyMeters = (lat - center.latitude) * M_PER_DEG_LAT;
  return {
    // 카메라 오프셋: 플레이어를 화면 중앙에 두고, 월드를 그 주위에 배치
    x: Math.round(screenW / 2 + dxMeters * pxPerMeter),
    // 화면 y 는 아래로 증가, 위도(북)는 위로 증가 → 부호 뒤집기
    y: Math.round(screenH / 2 - dyMeters * pxPerMeter),
  };
}
```

- `pxPerMeter` 는 한 헥스(H3 res 10, 지름 약 130m)가 화면에서 보기 좋은 크기가 되도록 정한다.
  예: `pxPerMeter ≈ 1.5` 면 헥스 지름이 약 195px. 줌은 이 값으로 조절한다(아래 카메라).
- 6 꼭짓점을 각각 투영해 `Skia.Path` 로 닫힌 다각형을 만들면 헥스 한 칸이 된다(다음 절).

## (4) 레이어 구조 — 뒤에서 앞으로 (painter's order)

Skia 는 선언 순서대로 위에 덮어 그린다. 순서가 곧 z-index 다.

```jsx
<Canvas style={StyleSheet.absoluteFill}>
  <Group transform={[{ scale: SCALE }]}>   {/* 정수배 확대: 월드 전체 */}

    {/* 1) 바닥: 정사각 픽셀 타일맵 (가장 뒤) */}
    {/*    초기엔 절차적 타일(아래 6절), 나중에 타일셋 Image 로 교체 */}

    {/* 2) 헥스 점령 오버레이: 셀별 Path + 테마색 채움 + 깃발 스프라이트 */}
    {gridCells.map((c) => {
      const path = hexPath(c.corners, center, w, h, pxPerMeter); // Skia.Path
      const occ = occupied[c.key];
      const isCurrent = c.key === currentKey;
      return (
        <Path
          key={c.key}
          path={path}
          color={occ ? "rgba(34,197,94,0.35)" : "rgba(0,0,0,0.04)"}
          style="fill"
        />
        /* 테두리는 같은 path 에 style="stroke" Path 하나 더, 깃발은 셀 중심에 Image */
      );
    })}
  </Group>

  {/* 3) 중앙 캐릭터 스프라이트 (월드 Group 밖 — 항상 화면 정중앙 고정) */}
  <Image image={hero} x={w/2 - TILE*SCALE/2} y={h/2 - TILE*SCALE/2}
         width={TILE*SCALE} height={TILE*SCALE} fit="fill"
         sampling={{ filter: FilterMode.Nearest, mipmap: MipmapMode.Nearest }} />
</Canvas>
```

헥스 Path 만드는 법 — 투영한 6 점으로 닫힌 경로:

```js
import { Skia } from "@shopify/react-native-skia";

function hexPath(corners, center, w, h, pxPerMeter) {
  const p = Skia.Path.Make();
  corners.forEach((corner, i) => {
    const { x, y } = projectToScreen(corner.latitude, corner.longitude, center, w, h, pxPerMeter);
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  });
  p.close();
  return p;
}
```

- **테마색**: `items.js` 의 지역 테마 풀과 결을 맞춰 점령색을 정한다. 현재 셀(`currentKey`)은
  테두리를 진하게(예: `#1d4ed8`) 줘서 GameMap 의 강조 규칙과 일관성을 유지한다.
- **깃발**: 점령 셀 중심(6 꼭짓점 평균)에 작은 깃발 스프라이트를 `<Image>` 로 얹는다.

## (5) 카메라 / 스크롤 — 플레이어 = 화면 중앙

핵심: **투영 자체가 플레이어 좌표를 화면 중앙으로 삼기 때문에 카메라 추적은 공짜다.** 걸으면
`coords`(center)가 갱신되고, 모든 헥스/타일이 재투영되면서 월드가 반대로 흘러간다.

- 추가로 필요한 건 두 가지뿐: (a) `SCALE` 정수배 확대(2 절), (b) 정수 px 스냅(`Math.round`).
- 줌은 `pxPerMeter` 로 바꾼다(월드 밀도). `SCALE` 은 픽셀 도트의 굵기(아트 해상도)다. 둘을 헷갈리지
  말 것 — `pxPerMeter` ↑ 는 "더 가까이", `SCALE` ↑ 는 "도트가 더 큼".
- 부드러운 스크롤이 필요하면 center 를 reanimated 로 보간한다(이미 `react-native-reanimated`
  설치됨). 단, 도트 게임은 보통 정수 스냅의 또렷함이 더 어울린다 — 보간은 요청 있을 때만.

## (6) 타일셋 에셋 규격

- **샘플은 버린다**: `/sample` 의 GBA 포켓몬 이미지는 저작물이라 감 잡는 용도일 뿐, 출시물에
  못 쓴다. **임시 절차적 타일** 또는 **무료(CC0) 타일셋**으로 간다.
- **타일 크기**: 한 변 16px(권장) 또는 8px. 정사각, 2 의 거듭제곱이 스프라이트 시트 정렬에 편하다.
- **팔레트**: 16~32 색으로 제한해 도트 톤을 통일한다. 색을 늘릴수록 도트 느낌이 옅어진다.
- **스프라이트 시트**: 캐릭터는 16x16 프레임을 격자로 배열(예: 4 방향 × N 프레임). `useImage` 로
  시트 전체를 한 번 로드하고, 한 프레임만 그릴 땐 `<Group clip={frameRect}>` 안에서 `<Image>` 를
  오프셋해 잘라 보여준다(시트의 해당 칸만 노출). 매 프레임마다 이미지를 새로 만들지 않는다.

```js
import { useImage } from "@shopify/react-native-skia";
const hero = useImage(require("../assets/sprites/hero.png")); // 로드 전엔 null → 가드할 것
```

- **임시 절차적 타일(에셋 0개로 시작)**: 셀별로 `items.js` 와 같은 결정적 시드(셀 키 해시)를 써서
  `<Rect>` 몇 개로 2~3 색 디더 패턴을 깐다. 에셋 파이프라인 없이 바로 화면을 채워 반복 개발이
  빨라진다. 무료 타일셋은 그다음에 붙인다.

## 웹 CanvasKit (지금은 안 함 — 미래 참고용)

웹에서 Skia 를 켜야 할 때만 본다. walkmon 현재 결정은 "웹 = null"이다(위).

- 설치 후 WASM 을 웹에서 접근 가능하게 셋업: `npx expo install @shopify/react-native-skia`
  다음 `yarn setup-skia-web`(또는 `WithSkiaWeb` / `LoadSkiaWeb` 로 CDN 의 canvaskit-wasm 로드).
- Metro/Webpack 에 canvaskit.wasm 복사 + `fs`/`path` 폴리필 설정이 추가로 필요하다. 비용이 있으니
  웹 픽셀맵 요구가 실제로 생길 때 한다.

## 산출물 위치 / 작업 절차

- 렌더 코드: `src/PixelMap.js`(네이티브), `src/PixelMap.web.js`(웹=null).
- 공유 상수/투영 헬퍼가 커지면 `src/pixel/` 하위로 뺀다(예: `src/pixel/project.js`). 단,
  파일을 미리 쪼개지 말고 실제로 재사용이 생길 때 분리한다(최소 변경).
- 에셋: `assets/tiles/`, `assets/sprites/`. 라이선스 출처를 같은 폴더 README 한 줄로 남긴다.

## 에러 핸들링

- `useImage` 는 로드 전 `null` 을 준다. **반드시 null 가드** 후 그린다. 안 하면 첫 프레임이 깨진다.
- 네이티브 모듈 미연결 에러(Skia 가 undefined)면 재빌드가 안 된 것 — expo-build-qa 로 넘긴다.
- 한 번 시도해 안 되면 1회 재시도하고, 그래도 막히면 막힌 지점을 명시해 보고한다.

## 이전 산출물 처리

`_workspace/` 에 이전 렌더 결과가 있으면 먼저 읽고 **개선**한다. 부분 피드백(예: "헥스 색만 바꿔")
이면 그 부분만 고치고 나머지는 건드리지 않는다. 처음부터 다시 만들지 않는다.

## 팀 통신 프로토콜

- pixel-render-engineer 가 이 스킬의 사용자다.
- 설치/재빌드가 필요해지면 **expo-build-qa 에게 SendMessage** 로 "Skia 설치됨, 네이티브 재빌드
  요청"을 보내고, 그쪽은 expo-build-run 스킬로 처리한다.
- 점령 색·테마·셀 데이터 모양이 game-mechanics 영역과 어긋나면 game-core-engineer 에게 확인한다.
