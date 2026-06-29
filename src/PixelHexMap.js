import {
  BlurMask,
  Canvas,
  Fill,
  FilterMode,
  Group,
  Image,
  MipmapMode,
  Path,
  Picture,
  Skia,
  useClock,
  useImage,
} from "@shopify/react-native-skia";
import { useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useDerivedValue } from "react-native-reanimated";

import { cellKeyAt } from "./grid";
import { cellTheme } from "./items";

// 픽셀 헥스 월드(네이티브 전용, react-native-skia).
// 플레이어를 화면 중앙에 고정한 채 주변 H3 헥스를 등거리 평면 근사로 픽셀에 투영한다.
// 레이어 순서: 1)흐릿한 실제 지도 배경 -> 2)점령 영토(시야 밖 포함) ->
// 3)시야 안 프런티어 -> 4)시야 원 -> 5)현재 셀 보더 -> 6)플레이어.
// 걸으면 coords 가 갱신되며 월드가 반대로 흘러 카메라 추적이 공짜로 된다(웹은 .web.js = null).
// 핀치 줌은 월드 레이어를 <Group transform> 으로 GPU 스케일한다(project() 재계산 없음).

// --- 투영 상수 ---
// 위도 1도 ≈ 111.32km (거의 상수). 경도는 위도에 따라 cos 로 줄어든다.
const M_PER_DEG_LAT = 111320;
// 화면 1m 당 픽셀. 0.45 로 줌아웃 -> res10 셀(꼭짓점 폭 ~130m)이 화면에서 ~58px,
// ring3 프런티어 + 시야 원이 화면 안에 여백을 두고 들어온다(시야 원이 카드 뒤로 숨던 문제 해결).
const PX_PER_M = 0.45;

// --- 핀치 줌 ---
// 월드(타일/영토/프런티어/시야원)를 <Group transform> 으로 화면 중앙(플레이어) 기준 스케일한다.
// clamp: 0.5(절반 축소)~3.0(3배 확대). 매 제스처 프레임마다 project() 전량 재계산을 피하고
// transform 만 바뀌게 해 부드럽게(베이스 스케일로 한 번 그리고 GPU 가 확대/축소).
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;

// 레트로 바닥 톤(배경 로드 전/실패 시 graceful fallback).
const BG_COLOR = "#e7e1cf";

// --- 배경 지도(OSM 래스터 타일) ---
// tile.openstreetmap.org/{z}/{x}/{y}.png 는 도달 확인됨(HTTP 200). 기존 정적지도
// 서비스(staticmap.openstreetmap.de)가 죽어 무응답이라 타일 방식으로 교체했다.
// dev 전용 — OSM fair-use/User-Agent 정책상 프로덕션은 정식 타일 제공자
// (Mapbox/Maptiler 등 + 적절한 User-Agent)로 교체해야 한다.
// z15 한 타일 ≈ 1km(이 위도), PX_PER_M=0.45 면 화면에서 ~440px -> 다운스케일 + nearest 로 "러프"한 픽셀 톤.
const TILE_ZOOM = 15;
// 축소(ZOOM_MIN=0.5)하면 가시 월드가 2배로 넓어진다. 고정 4x5 로는 가장자리가 빈다 ->
// 6x8 로 넉넉히 잡아 ZOOM_MIN 에서도 화면을 덮는다. 개수는 여전히 고정(useImage Hooks 규칙).
const TILES_X = 6; // 중심 타일 좌우로 펼칠 타일 수(축소 시 화면폭 커버).
const TILES_Y = 8; // 상하 타일 수(세로가 길어 더 넉넉히).
const BG_IMAGE_OPACITY = 0.4;
// nearest-neighbor 샘플링으로 배경을 "러프"하게 픽셀화한다(픽셀 톤 유지).
const PIXEL_SAMPLING = {
  filter: FilterMode.Nearest,
  mipmap: MipmapMode.Nearest,
};
// 중심 타일(0,0) 기준 고정 오프셋 그리드. 개수 = TILES_X*TILES_Y 로 항상 고정 ->
// useImage 호출 수가 매 렌더 불변(React Hooks 규칙 준수).
const TILE_OFFSETS = [];
for (let j = 0; j < TILES_Y; j++) {
  for (let i = 0; i < TILES_X; i++) {
    TILE_OFFSETS.push({
      dx: i - Math.floor(TILES_X / 2),
      dy: j - Math.floor(TILES_Y / 2),
    });
  }
}

// --- 시야 원 ---
// 시야 원 반지름 = ring3 의 실제 픽셀 반경 = VISION_RING * 셀중심간격 * PX_PER_M.
// App 의 VISION_RING(=3)과 일치, res10 셀 중심간격 ≈ 114m.
// 3 * 114 * 0.45 ≈ 154px -> 화면폭(보통 ~390+) 안에 여백을 두고 또렷한 링이 된다.
const VISION_RING = 3;
const CELL_SPACING_M = 114;
const VISION_RADIUS_PX = Math.round(VISION_RING * CELL_SPACING_M * PX_PER_M);

// 테마(items.js cellTheme) -> 픽셀 팔레트.
// dim = 미점령(아주 옅은 안개, 지도가 비치게), lit = 점령(반투명으로 지도 위 "불이 켜진다"), border = 점령 보더.
const THEME_COLORS = {
  풀숲: {
    dim: "rgba(95,184,122,0.18)",
    lit: "rgba(95,184,122,0.80)",
    border: "rgba(46,110,70,0.75)",
  },
  도심: {
    dim: "rgba(155,143,181,0.18)",
    lit: "rgba(155,143,181,0.80)",
    border: "rgba(80,70,100,0.75)",
  },
  물가: {
    dim: "rgba(78,163,224,0.18)",
    lit: "rgba(78,163,224,0.80)",
    border: "rgba(40,90,140,0.75)",
  },
  언덕: {
    dim: "rgba(199,154,94,0.18)",
    lit: "rgba(199,154,94,0.80)",
    border: "rgba(120,85,45,0.75)",
  },
};

// 현재 셀 헤일로(번지는 빛): agenTree 의 맥동 금색 rgba(255,225,90) 계열. BlurMask 로 부드럽게 번진다.
const CURRENT_GLOW = "rgba(255, 225, 90, 1)";

// --- 도트 타일 아틀라스(grid_packed.png) ---
// 한 장의 아틀라스 + 프레임 좌표(JSON)로 육각 픽셀 타일 34개를 담는다.
// require 는 모듈 1회 평가, 실제 SkImage 로딩은 컴포넌트 안 useImage 가 담당한다.
const ATLAS_SRC = require("../assets/tiles/grid_packed.png");
// 프레임 이름("sprite_{row}_{col}") -> 아틀라스 안 소스 사각형 {x,y,w,h}.
const ATLAS_FRAMES = require("../assets/tiles/grid_coordinate.json").frames;
const FRAMES_BY_NAME = {};
for (const f of ATLAS_FRAMES) FRAMES_BY_NAME[f.name] = f;

// --- 펫(다마고치) 크리처 아틀라스(monster_packed.png) ---
// 도트 헥스 월드 중앙(플레이어 자리)에 성장 단계별 크리처를 그린다.
// 4줄 = 속성 타입: 0=불(빨강), 1=물(파랑), 2=땅(갈색), 3=풀(초록).
// 6열: col0=속성아이콘, col1=알, col2=유년, col3=소년, col4=청년, col5=성년기(왼->오 점점 큼).
const PET_ATLAS_SRC = require("../assets/pet/monster_packed.png");
const PET_FRAMES = require("../assets/pet/monster_coordinate.json").frames;
const PET_FRAMES_BY_NAME = {};
for (const f of PET_FRAMES) PET_FRAMES_BY_NAME[f.name] = f;

// 기본 펫 속성 = 0(불). 물=1·땅=2·풀=3 으로 바꾸려면 이 한 줄만 수정한다.
const PET_TYPE_ROW = 0;
// 게임 성장 단계(stageFromLevel 반환 문자열) -> 아틀라스 열. 알->col1 ... 진화체->col5.
// stage 가 바뀌면 자동으로 다른 프레임이 골라져 진화가 화면에 보인다.
const PET_STAGE_COL = { 알: 1, 아기: 2, 청소년: 3, 성체: 4, 진화체: 5 };
// 성년기(col5, 가장 큰 원본)가 화면에서 ~68px 높이가 되도록 공통 스케일.
// 모든 단계에 같은 배율 -> 단계가 작을수록 원본이 작아 자연히 작게 그려진다(성장감).
const PET_TARGET_MAX_H = 68;
const PET_MAX_FRAME = PET_FRAMES_BY_NAME[`sprite_${PET_TYPE_ROW}_5`];
const PET_SCALE = PET_TARGET_MAX_H / PET_MAX_FRAME.h; // ≈ 0.35

// 테마(items.js cellTheme) -> 스프라이트. base = 기본, variants = 같은 테마의 모양 변형.
// "이 동네엔 이 모양": 셀 키 해시로 variants 중 하나를 결정적으로 골라 같은 칸은 항상 같은 타일.
// 평평한 타일만 쓴다(숲 0_7·해변 3_2·절벽 2_5·눈 4_x 처럼 입체/장식 있는 건 격자에서 위로 삐져나와 깨짐).
const THEME_SPRITES = {
  풀숲: {
    base: "sprite_0_0",
    variants: ["sprite_0_0", "sprite_0_1", "sprite_0_3", "sprite_0_4"],
  },
  도심: {
    base: "sprite_0_5",
    variants: ["sprite_0_5", "sprite_0_6", "sprite_1_1", "sprite_1_2"],
  },
  물가: {
    base: "sprite_2_3",
    variants: ["sprite_2_2", "sprite_2_3", "sprite_2_4"],
  },
  언덕: {
    base: "sprite_1_0",
    variants: ["sprite_1_0", "sprite_1_3", "sprite_1_5", "sprite_0_2"],
  },
};

// 미점령(시야 안) 칸은 검은 막으로 어둡게 덮는다. 점령 칸은 칠하지 않고 타일 원본 그대로 둔다
// (점령 = 원본 색 또렷, 미점령 = 어둠 — 대비 확실, fog of war). 지도까지 비치는 반투명이 아니라 타일 위 어두운 베일.
const UNCLAIMED_WASH = "rgba(0, 0, 0, 0.45)"; // 미점령 어둠

// 셀 키 -> 결정적 해시(items.js 와 동일한 FNV-1a). variants 인덱스 선택에 쓴다.
function hashKey(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 셀 키 -> 그 테마의 프레임(변형 하나). 테마 미매칭 시 풀숲으로 폴백.
function frameForCell(key) {
  const theme = THEME_SPRITES[cellTheme(key)] || THEME_SPRITES.풀숲;
  const name = theme.variants[hashKey(key) % theme.variants.length];
  return FRAMES_BY_NAME[name] || FRAMES_BY_NAME[theme.base];
}

// --- 화면 똑바른 pointy-top 육각 격자 ---
// H3 셀을 화면에 투영하면 위치마다 ~14° 기울고 모양이 들쭉날쭉해 똑바로 선 픽셀 스프라이트와 안 맞물린다.
// 해법: 화면에 북쪽 정렬 똑바른 육각 격자를 깔고, 각 칸 중심을 screenToLatLng 로 H3 셀에 역매핑한다.
// 게임 상태(점령/테마)는 H3 그대로, 렌더만 깔끔한 격자.
// HEX_W ≈ H3 res10 셀의 화면폭(~64px, 이웃 간격과 거의 1:1). HEX_H 는 스프라이트 원본 비율(244/200) 유지.
const HEX_W = 64; // 육각 가로폭 = 가로 이웃 간격(colStep)
// 정육각형(pointy-top) 세로 = 가로 * 2/√3 ≈ 가로*1.1547. 이래야 행 간격(HEX_H*0.75)이 맞물린다.
// (스프라이트 액자 비율 244/200=1.22 는 그림 여백 포함이라 격자 기하로 쓰면 세로 틈이 생긴다.)
const HEX_H = Math.round((HEX_W * 2) / Math.sqrt(3)); // ≈ 74px
// 헤어라인 틈만 덮는 소폭 겹침(과한 겹침은 오히려 어긋나 보임).
const SPRITE_OVERLAP = 1.0;
// 스프라이트로 실제 그리는 폭(겹침 포함)과 그 폭의 정육각 세로.
// 현재 셀 강조선도 이 값으로 그려야 타일과 정확히 겹친다(선이 따로 놀지 않게).
const TILE_DRAW_W = Math.round(HEX_W * SPRITE_OVERLAP);
const TILE_HEX_H = Math.round((TILE_DRAW_W * 2) / Math.sqrt(3));
// 행(상하) 간격 배수. 1.0 = 정육각 완전 맞물림(상하 겹침 많아 타이트). 키우면 위아래로 벌어진다.
// 좌우 간격은 SPRITE_OVERLAP, 상하 간격은 이 값으로 따로 조절한다.
const ROW_SPACING = 1.02;

// 베이크 캔버스에 셀 스프라이트 한 칸을 (cx,cy) 중심으로 그린다.
// alpha=1 = 점령(또렷, 불 켜짐), alpha<1 = 프런티어(옅은 안개).
function drawCellSprite(canvas, atlas, frame, cx, cy, alpha) {
  const dstW = TILE_DRAW_W;
  // 액자 전체를 그린다(헥스 + 아래 입체 lip). 소스를 자르면 그림 육각이 정확히 정육각이 아니라
  // 아래 꼭짓점이 잘려 하단이 평평해진다 -> 자르지 않는다. 상하 간격은 ROW_SPACING 으로 조절.
  const dstH = Math.round((dstW * frame.h) / frame.w);
  const src = Skia.XYWHRect(frame.x, frame.y, frame.w, frame.h);
  // 헥스 내용을 (cx,cy) 중심에 맞춘다(lip 은 아래로 빠짐). 위 모서리 = cy - TILE_HEX_H/2 -> 격자/강조선과 정렬.
  const dst = Skia.XYWHRect(
    Math.round(cx - dstW / 2),
    Math.round(cy - TILE_HEX_H / 2),
    dstW,
    dstH,
  );
  const paint = Skia.Paint();
  paint.setAntiAlias(false);
  if (alpha < 1) paint.setAlphaf(alpha);
  // rn-skia 2.6.x: drawImageRectOptions(image, src, dst, filter, mipmap, paint) 로 nearest 강제.
  // (paint 만 받는 drawImageRect 는 기본 linear 샘플링이라 픽셀이 뭉개진다.)
  canvas.drawImageRectOptions(
    atlas,
    src,
    dst,
    FilterMode.Nearest,
    MipmapMode.Nearest,
    paint,
  );
}

// 위경도 -> 화면 픽셀. center = 플레이어 좌표(= 화면 중앙).
// 픽셀 선명도를 위해 정수 px 로 스냅(Math.round)한다.
function project(lat, lng, center, W, H) {
  const mPerDegLng =
    M_PER_DEG_LAT * Math.cos((center.latitude * Math.PI) / 180);
  const dxMeters = (lng - center.longitude) * mPerDegLng;
  const dyMeters = (lat - center.latitude) * M_PER_DEG_LAT;
  return {
    x: Math.round(W / 2 + dxMeters * PX_PER_M),
    // 화면 y 는 아래로 증가, 위도(북)는 위로 증가 -> 부호 뒤집기
    y: Math.round(H / 2 - dyMeters * PX_PER_M),
  };
}

// 화면 픽셀 -> 위경도. project() 의 정확한 역(player-centered 화면좌표 기준).
// 똑바른 격자 칸 중심(화면좌표)을 H3 셀에 역매핑할 때 쓴다.
function screenToLatLng(x, y, center, W, H) {
  const mPerDegLng =
    M_PER_DEG_LAT * Math.cos((center.latitude * Math.PI) / 180);
  const dxMeters = (x - W / 2) / PX_PER_M;
  // 화면 아래(+y)는 남(위도 감소) -> 부호 뒤집기(project 와 정확히 역).
  const dyMeters = -(y - H / 2) / PX_PER_M;
  return {
    latitude: center.latitude + dyMeters / M_PER_DEG_LAT,
    longitude: center.longitude + dxMeters / mPerDegLng,
  };
}

// 투영한 6 꼭짓점으로 닫힌 육각 Path 를 만든다.
// rn-skia 2.6.x: Skia.Path.Make() 의 moveTo/lineTo/close 는 deprecated -> PathBuilder(불변)로 마이그레이션.
// PathBuilder.Make() 는 체이닝 가능한 가변 빌더를 반환하고 build() 가 불변 SkPath 를 준다.
function makeHexPath(pts) {
  const builder = Skia.PathBuilder.Make();
  pts.forEach((p, i) => {
    if (i === 0) builder.moveTo(p.x, p.y);
    else builder.lineTo(p.x, p.y);
  });
  builder.close();
  return builder.build();
}

// 똑바로 선 pointy-top 육각의 6 꼭짓점으로 Path 생성(중심 cx,cy, 폭 w, 높이 h).
// 위/아래 꼭짓점은 ±h/2, 좌우 변은 ±w/2 에서 ±h/4. H3 cornersOf 가 아니라 격자 칸 좌표로 그린다.
function straightHexPath(cx, cy, w, h) {
  const hw = w / 2;
  const qh = h / 4;
  const hh = h / 2;
  return makeHexPath([
    { x: cx, y: cy - hh }, // 위 꼭짓점
    { x: cx + hw, y: cy - qh }, // 우상
    { x: cx + hw, y: cy + qh }, // 우하
    { x: cx, y: cy + hh }, // 아래 꼭짓점
    { x: cx - hw, y: cy + qh }, // 좌하
    { x: cx - hw, y: cy - qh }, // 좌상
  ]);
}

// 화면 고정 pointy-top 육각 격자(플레이어=화면중앙 기준). 좌표(coords)와 무관한 순수 기하라
// W/H 로만 메모하고, 각 칸의 H3 매핑은 베이크 때 screenToLatLng 로 푼다.
// pointy-top 타일링: 열 간격=HEX_W, 행 간격=HEX_H*3/4(위/아래 꼭짓점이 1/4 겹쳐 맞물림),
// 홀수 행은 HEX_W/2 가로 오프셋. 줌아웃(ZOOM_MIN)으로 넓어진 가시 월드까지 margin 으로 덮는다.
function buildLattice(W, H) {
  const colStep = HEX_W;
  const rowStep = Math.round(HEX_H * 0.75 * ROW_SPACING);
  const marginX = (W * (1 / ZOOM_MIN - 1)) / 2;
  const marginY = (H * (1 / ZOOM_MIN - 1)) / 2;
  const cx0 = W / 2;
  const cy0 = H / 2;
  const rMin = Math.floor((-marginY - HEX_H - cy0) / rowStep);
  const rMax = Math.ceil((H + marginY + HEX_H - cy0) / rowStep);
  const cells = [];
  for (let r = rMin; r <= rMax; r++) {
    const cy = Math.round(cy0 + r * rowStep);
    const offset = r & 1 ? colStep / 2 : 0; // 홀수 행 가로 오프셋
    const cMin = Math.floor((-marginX - HEX_W - cx0 - offset) / colStep);
    const cMax = Math.ceil((W + marginX + HEX_W - cx0 - offset) / colStep);
    for (let c = cMin; c <= cMax; c++) {
      cells.push({ cx: Math.round(cx0 + c * colStep + offset), cy });
    }
  }
  return cells;
}

// --- Web Mercator 타일 수학(OSM 래스터 타일 좌표 <-> 위경도) ---
// 위경도 -> 타일 인덱스(부동소수). floor 하면 정수 타일 좌표가 된다.
function lng2tileX(lng, z) {
  return ((lng + 180) / 360) * 2 ** z;
}
function lat2tileY(lat, z) {
  return (
    ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z
  );
}
// 정수 타일 좌표 -> 그 타일 NW(왼위) 꼭짓점의 위경도(x+1/y+1 이면 SE 꼭짓점).
function tileX2lng(x, z) {
  return (x / 2 ** z) * 360 - 180;
}
function tileY2lat(y, z) {
  return (
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI
  );
}

export default function PixelHexMap({
  coords,
  occupied,
  currentKey,
  stage,
  facingRight,
}) {
  const { width: W, height: H } = useWindowDimensions();

  // --- 핀치 줌 상태 ---
  // gesture-handler Pinch + React state 로 줌을 구동한다.
  // 주의: babel-preset-expo(SDK56)가 worklets 플러그인을 자동 적재해서, Gesture 체인에 직접 박은
  // 콜백은 기본적으로 UI 스레드 worklet 으로 표시된다. 그 안에서 React setter(setZoom)나 ref 변이를
  // 직접 호출하려면 .runOnJS(true) 로 콜백을 JS 스레드에서 돌려야 한다(없으면 첫 핀치에서 크래시).
  // zoom 은 project() 의존성이 아니라 베이크/투영을 다시 돌리지 않는다(아래 useMemo deps 에 zoom 없음).
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1); // 라이브 zoom(onEnd 에서 baseline 으로 커밋)
  const baseZoomRef = useRef(1); // 직전 제스처 종료 시점의 배율(다음 핀치의 기준)
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onUpdate((e) => {
          const next = Math.min(
            ZOOM_MAX,
            Math.max(ZOOM_MIN, baseZoomRef.current * e.scale),
          );
          zoomRef.current = next;
          setZoom(next);
        })
        .onEnd(() => {
          baseZoomRef.current = zoomRef.current;
        }),
    [],
  );

  // --- 드래그 팬(둘러보기) 상태 ---
  // panX/panY = 화면 픽셀 오프셋(지속). 핀치 zoom 과 같은 결로 React state 로 구동한다.
  // basePanRef = 직전 제스처 종료 시점의 오프셋(다음 드래그의 기준). 핀치 baseZoomRef 와 동일 패턴.
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const basePanRef = useRef({ x: 0, y: 0 });
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        // 핀치와 동일 이유: babel-preset-expo worklets 자동화 탓에 콜백이 UI 스레드 worklet 으로
        // 표시된다 -> 그 안에서 setter/ref 변이를 직접 부르려면 JS 스레드 강제(없으면 첫 드래그 크래시).
        .runOnJS(true)
        .onUpdate((e) => {
          // 누적 오프셋 = 기준 + 이번 제스처 누적 이동량.
          setPanX(basePanRef.current.x + e.translationX);
          setPanY(basePanRef.current.y + e.translationY);
        })
        .onEnd((e) => {
          // 종료값을 다음 드래그의 기준으로 커밋.
          basePanRef.current = {
            x: basePanRef.current.x + e.translationX,
            y: basePanRef.current.y + e.translationY,
          };
        }),
    [],
  );

  // 핀치 줌과 드래그 팬을 동시 인식(둘 다 활성). GestureDetector 에는 이 합성 제스처를 넘긴다.
  const composedGesture = useMemo(
    () => Gesture.Simultaneous(pinchGesture, panGesture),
    [pinchGesture, panGesture],
  );

  // 재중심: 내 위치(화면 중앙)로 복귀. 팬 오프셋과 그 기준을 모두 0 으로 리셋한다.
  const recenter = () => {
    basePanRef.current = { x: 0, y: 0 };
    setPanX(0);
    setPanY(0);
  };

  // 중심 타일(플레이어가 속한 z15 타일)의 floor 좌표. 좌표 jitter 에도 타일이 바뀔 때만
  // 새 객체를 반환 -> 타일 URL/이미지가 타일 단위로만 갱신된다(useImage 재요청 최소화).
  const centerTile = useMemo(() => {
    if (!coords) return null;
    return {
      tx: Math.floor(lng2tileX(coords.longitude, TILE_ZOOM)),
      ty: Math.floor(lat2tileY(coords.latitude, TILE_ZOOM)),
    };
  }, [
    coords ? Math.floor(lng2tileX(coords.longitude, TILE_ZOOM)) : null,
    coords ? Math.floor(lat2tileY(coords.latitude, TILE_ZOOM)) : null,
  ]);

  // 고정 오프셋 그리드로 항상 TILE_OFFSETS.length(=TILES_X*TILES_Y) 개의 useImage 를 호출한다.
  // 호출 개수/순서가 매 렌더 불변이라 Hooks 규칙을 지킨다(coords 없으면 url=null -> null 반환).
  // rn-skia 2.6.x: useImage 는 string URL 을 직접 로드, 로드 전/실패 시 null 을 반환한다.
  const tileImages = [];
  for (let n = 0; n < TILE_OFFSETS.length; n++) {
    const off = TILE_OFFSETS[n];
    const url = centerTile
      ? `https://tile.openstreetmap.org/${TILE_ZOOM}/${centerTile.tx + off.dx}/${centerTile.ty + off.dy}.png`
      : null;
    // eslint-disable-next-line react-hooks/rules-of-hooks -- 고정 길이 루프라 호출 순서/개수가 불변.
    tileImages.push(useImage(url));
  }

  // 도트 타일 아틀라스(단일 useImage, 호출 순서 불변 -> Hooks 규칙 OK).
  // 로컬 require 라 거의 즉시 로드되지만, 로드 전엔 null -> 단색 헥스로 폴백한다.
  const atlas = useImage(ATLAS_SRC);

  // 펫 크리처 아틀라스(단일 useImage, 호출 순서 불변 -> Hooks 규칙 OK). 로드 전엔 null -> 펫 미표시.
  const petAtlas = useImage(PET_ATLAS_SRC);

  // 각 타일의 화면 사각형. 그 타일의 NW/SE 위경도를 헥스와 같은 project() 로 변환해 정렬을 맞춘다.
  // coords(jitter)에 따라 월드가 매끄럽게 스크롤하도록 coords 를 의존성에 둔다.
  const tiles = useMemo(() => {
    if (!coords || !centerTile) return [];
    const out = [];
    for (let n = 0; n < TILE_OFFSETS.length; n++) {
      const tx = centerTile.tx + TILE_OFFSETS[n].dx;
      const ty = centerTile.ty + TILE_OFFSETS[n].dy;
      const nw = project(
        tileY2lat(ty, TILE_ZOOM),
        tileX2lng(tx, TILE_ZOOM),
        coords,
        W,
        H,
      );
      const se = project(
        tileY2lat(ty + 1, TILE_ZOOM),
        tileX2lng(tx + 1, TILE_ZOOM),
        coords,
        W,
        H,
      );
      out.push({
        n,
        x: nw.x,
        y: nw.y,
        width: se.x - nw.x,
        height: se.y - nw.y,
      });
    }
    return out;
  }, [coords, centerTile, W, H]);

  // 화면 고정 똑바른 육각 격자(좌표 무관 순수 기하). W/H 로만 메모.
  const lattice = useMemo(() => buildLattice(W, H), [W, H]);

  // 2)+3) 영토 + 시야 안 프런티어를 하나의 똑바른 격자 Picture 로 "베이크"한다.
  // 각 격자 칸 중심(화면좌표) -> screenToLatLng -> cellKeyAt(H3) 로 역매핑해 점령/테마를 정한다.
  // - 점령 = 불투명 스프라이트(화면 어디든 "불 켜짐").
  // - 시야 원 안 미점령 = 옅은 스프라이트(안개, 지도 비침). 시야 밖 미개척 = 생략(지도만 비침).
  // - 현재 셀(currentKey)에 매칭되는 칸 중 중앙에 가장 가까운 칸의 똑바른 육각 보더를 함께 만든다.
  // 재베이크는 coords/occupied/currentKey/atlas 가 바뀔 때만(zoom/pan 은 Group transform 이라 deps 아님).
  const latticePicture = useMemo(() => {
    if (!coords) return { picture: null, currentPath: null };
    const marginX = (W * (1 / ZOOM_MIN - 1)) / 2;
    const marginY = (H * (1 / ZOOM_MIN - 1)) / 2;
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(
      Skia.XYWHRect(-marginX, -marginY, W + 2 * marginX, H + 2 * marginY),
    );
    const ccx = W / 2;
    const ccy = H / 2;
    const visionSq = VISION_RADIUS_PX * VISION_RADIUS_PX;
    let currentPath = null;
    let currentDist = Infinity;

    for (const cell of lattice) {
      const ll = screenToLatLng(cell.cx, cell.cy, coords, W, H);
      const key = cellKeyAt(ll.latitude, ll.longitude);
      const occ = !!occupied[key];
      const dx = cell.cx - ccx;
      const dy = cell.cy - ccy;
      const distSq = dx * dx + dy * dy;
      const inVision = distSq <= visionSq;

      // 현재 셀에 매칭되는 칸(중앙에 가장 가까운 것)의 강조 보더 위치 기억.
      if (key === currentKey && distSq < currentDist) {
        currentDist = distSq;
        // 현재 셀 하일라이트는 칸 외곽(전체 크기)에 맞춘다 -> 셀 가장자리를 따라 은은한 글로우(선 없음).
        currentPath = straightHexPath(
          cell.cx,
          cell.cy,
          TILE_DRAW_W,
          TILE_HEX_H,
        );
      }

      // 그릴지 결정: 점령(화면 어디든) / 시야 안 미개척 / 그 외 생략.
      if (!occ && !inVision) continue;
      const path = straightHexPath(cell.cx, cell.cy, TILE_DRAW_W, TILE_HEX_H);

      // 1) 타일 그림(똑바른 스프라이트, nearest). atlas 로드 전이면 단색 헥스 폴백.
      const frame = atlas ? frameForCell(key) : null;
      if (frame) {
        drawCellSprite(canvas, atlas, frame, cell.cx, cell.cy, 1);
      } else {
        const colors = THEME_COLORS[cellTheme(key)] || THEME_COLORS.풀숲;
        const fill = Skia.Paint();
        fill.setAntiAlias(false);
        fill.setColor(Skia.Color(occ ? colors.lit : colors.dim));
        canvas.drawPath(path, fill);
      }

      // 2) 미점령(시야 안) 칸만 흰 막(썬크림 톤)으로 덮는다. 점령 칸은 안 칠하고 타일 원본 그대로.
      if (!occ) {
        const overlay = Skia.Paint();
        overlay.setAntiAlias(false);
        overlay.setColor(Skia.Color(UNCLAIMED_WASH));
        canvas.drawPath(path, overlay);
      }
    }

    return { picture: recorder.finishRecordingAsPicture(), currentPath };
  }, [lattice, coords, occupied, currentKey, W, H, atlas]);

  // --- 현재 셀 glow 맥동(렌더 스레드, React 리렌더 없음) ---
  // rn-skia useClock() = SharedValue<ms>. reanimated useDerivedValue 본문은 babel worklets 로
  // 자동 worklet 화되어 UI 스레드에서 매 프레임 평가된다(무거운 useMemo 재계산 없음).
  // 기본 맥동: 0~1 을 ~1.2초(0.005 rad/ms) 주기로 숨쉬듯. agenTree 의 0.72+0.28*sin 결을 Skia 로 옮김.
  const clock = useClock();
  // 은은한 글로우 opacity 0.12~0.42 (숨쉬듯 약하게 맥동). 선 없이 이 글로우만으로 현재 칸을 표시.
  const haloOpacity = useDerivedValue(
    () => 0.2 + 0.35 * (0.5 + 0.5 * Math.sin(clock.value * 0.005)),
  );

  // 펫 크리처 스프라이트를 로컬 원점(바닥-중앙 = 0,0)에 베이크한다. stage 가 바뀌면 다른 단계
  // 프레임으로 재베이크 -> 진화가 화면에 보인다. drawImageRectOptions 로 nearest 강제(픽셀 선명).
  // 위치/좌우 반전은 렌더 시 Group transform 으로 입혀 deps 를 작게(petAtlas, stage) 유지한다.
  const petPicture = useMemo(() => {
    if (!petAtlas) return null;
    const col = PET_STAGE_COL[stage] ?? PET_STAGE_COL.알;
    const frame = PET_FRAMES_BY_NAME[`sprite_${PET_TYPE_ROW}_${col}`];
    if (!frame) return null;
    const dstW = Math.round(frame.w * PET_SCALE);
    const dstH = Math.round(frame.h * PET_SCALE);
    // 바닥-중앙을 원점(0,0)에: 좌 = -dstW/2, 위 = -dstH -> 발이 원점, 위로 솟아 칸에 "선" 느낌.
    const left = -Math.round(dstW / 2);
    const top = -dstH;
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(left, top, dstW, dstH));
    const src = Skia.XYWHRect(frame.x, frame.y, frame.w, frame.h);
    const dst = Skia.XYWHRect(left, top, dstW, dstH);
    const paint = Skia.Paint();
    paint.setAntiAlias(false);
    canvas.drawImageRectOptions(
      petAtlas,
      src,
      dst,
      FilterMode.Nearest,
      MipmapMode.Nearest,
      paint,
    );
    return recorder.finishRecordingAsPicture();
  }, [petAtlas, stage]);

  // coords 가 없으면 단색 배경만(App 의 상태 카드가 "위치 확인 중"을 표시). 크래시 가드.
  if (!coords) {
    return (
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color={BG_COLOR} />
      </Canvas>
    );
  }

  // 화면 중앙(= 플레이어 위치). 월드 줌의 고정점이자 펫 크리처의 바닥-중앙 기준점.
  const cx = Math.round(W / 2);
  const cy = Math.round(H / 2);

  // 월드 transform = 줌(화면중앙 기준 scale) + 팬(화면공간 평행이동).
  // 줌: 점을 translate(-cx,-cy) -> scale(zoom) -> translate(cx,cy) (중앙 고정 확대/축소).
  // 팬: 줌이 끝난 화면좌표를 그대로 translate(panX,panY) 만큼 민다.
  // Skia/RN transform 배열은 뒤 항목이 점에 먼저 적용된다 -> 점에 줌을 먼저, 팬을 가장 마지막에
  // 걸려면 팬 translate(panX,panY) 가 배열 맨 앞에 와야 한다.
  const worldTransform = [
    { translateX: panX },
    { translateY: panY },
    { translateX: cx },
    { translateY: cy },
    { scale: zoom },
    { translateX: -cx },
    { translateY: -cy },
  ];

  // 플레이어 마커 화면 위치: scale 기준점이 (cx,cy)라 zoom 은 그 점을 안 움직이고 팬만 더해진다.
  // 마커는 Group 밖(고정 크기)이므로 팬 오프셋을 직접 더해 월드 위 제자리에 붙인다(시야 원과 정합).
  const pcx = cx + panX;
  const pcy = cy + panY;

  return (
    <View style={styles.container}>
      <GestureDetector gesture={composedGesture}>
        <Canvas style={StyleSheet.absoluteFill}>
          {/* 1) 배경 단색 fallback: Group 밖(항상 화면 전체를 덮어 줌아웃 시 빈틈 없음). */}
          <Fill color={BG_COLOR} />

          {/* 월드: 타일/영토/프런티어/시야원을 한 Group 으로 묶어 GPU 스케일(줌). */}
          <Group transform={worldTransform}>
            {/* OSM 타일: 로드된 타일만 그 위에 흐릿하게 덮는다(null 은 skip -> 배경 폴백 유지). */}
            {tiles.map((t) =>
              tileImages[t.n] ? (
                <Image
                  key={t.n}
                  image={tileImages[t.n]}
                  x={t.x}
                  y={t.y}
                  width={t.width}
                  height={t.height}
                  fit="fill"
                  opacity={BG_IMAGE_OPACITY}
                  sampling={PIXEL_SAMPLING}
                />
              ) : null,
            )}

            {/* 2)+3) 영토 + 시야 안 프런티어: 똑바른 육각 격자를 H3 에 역매핑해 베이크한 단일 Picture. */}
            {latticePicture.picture && (
              <Picture picture={latticePicture.picture} />
            )}

            {/* 5) 현재 셀 하일라이트 — 선 없이 은은한 글로우만(BlurMask 로 번짐, 매 프레임 UI 스레드 맥동). */}
            {latticePicture.currentPath && (
              <Path
                path={latticePicture.currentPath}
                color={CURRENT_GLOW}
                style="stroke"
                strokeWidth={6}
                opacity={haloOpacity}
              >
                <BlurMask blur={4} style="normal" />
              </Path>
            )}
          </Group>

          {/* 6) 펫 크리처: 월드 Group 밖 = 줌과 무관(항상 같은 크기). 위치는 팬 오프셋을 더해
            (pcx,pcy = 바닥-중앙) 시야 원 중심과 정합 -> 드래그하면 펫도 지도 위 제자리에 붙는다.
            facingRight=true 면 중심(pcx) 기준 가로 반전: 기본 왼쪽 보기 -> 오른쪽 보기.
            알(stage 알)은 방향이 없어 반전하지 않는다. petPicture=null(로드 전)이면 아무것도 안 그림.
            transform 배열은 뒤 항목이 점에 먼저 적용 -> scaleX(반전) 먼저, 그다음 translate 로 배치. */}
          {petPicture && (
            <Group
              transform={[
                { translateX: pcx },
                { translateY: pcy },
                { scaleX: facingRight && stage !== "알" ? -1 : 1 },
              ]}
            >
              <Picture picture={petPicture} />
            </Group>
          )}
        </Canvas>
      </GestureDetector>

      {/* 재중심 버튼: 둘러보는 중(팬 오프셋이 0 이 아닐 때)에만 표시. 탭하면 내 위치로 복귀.
          Canvas 위에 RN 뷰를 못 그리니 절대배치 Pressable 오버레이로 둔다(카드/로그와 안 겹치게 우측). */}
      {(panX !== 0 || panY !== 0) && (
        <Pressable style={styles.recenterButton} onPress={recenter} hitSlop={8}>
          <Text style={styles.recenterIcon}>◎</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // 픽셀풍 작은 버튼: 어두운 사각 + 노란 보더(플레이어 팔레트와 통일), 각지게.
  recenterButton: {
    position: "absolute",
    right: 16,
    bottom: 208,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(31,41,51,0.85)",
    borderColor: "#f4b740",
    borderWidth: 2,
    borderRadius: 4,
  },
  recenterIcon: {
    color: "#f4b740",
    fontSize: 22,
    fontWeight: "700",
    lineHeight: 24,
  },
});
