import {
  BlurMask,
  Canvas,
  Fill,
  FilterMode,
  Group,
  MipmapMode,
  Path,
  Picture,
  Skia,
  useClock,
  useImage,
} from "@shopify/react-native-skia";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useDerivedValue, useSharedValue } from "react-native-reanimated";

import { cellKeyAt } from "./grid";
import { cellTheme } from "./items";

// 픽셀 헥스 월드(네이티브 전용, react-native-skia).
// 플레이어를 화면 중앙에 고정한 채 주변 H3 헥스를 등거리 평면 근사로 픽셀에 투영한다.
// 레이어 순서: 1)보드 판(화면고정 단색 + 월드 격자 패턴) -> 2)점령 영토(시야 밖 포함) ->
// 3)시야 안 프런티어 -> 4)시야 원 -> 5)현재 셀 보더 -> 6)플레이어.
// 걸으면 coords 가 갱신되며 월드가 반대로 흘러 카메라 추적이 공짜로 된다(웹은 .web.js = null).
// 핀치 줌은 월드 레이어를 <Group transform> 으로 GPU 스케일한다(project() 재계산 없음).

// --- 투영 상수 ---
// 위도 1도 ≈ 111.32km (거의 상수). 경도는 위도에 따라 cos 로 줄어든다.
const M_PER_DEG_LAT = 111320;
// 화면 1m 당 픽셀. 화면 격자 한 칸의 실제 대응 크기 = HEX_W/PX_PER_M 이므로, res11(H3, 한 칸 ~50m)에
// 맞추려면 64/1.28 = 50m 가 되게 1.28 로 둔다(res10 시절 0.45 -> 화면 칸 142m 였던 것을 교체).
// PX_PER_M 은 project()/screenToLatLng/camOffset/배경타일에 일관되게 쓰여, 바꿔도 화면 레이아웃은
// 줌 범위(ZOOM_MIN/MAX)만 재계산하면 유지된다(칸 화면 px = HEX_W×zoom 로 split 무관·불변).
const PX_PER_M = 1.28;

// --- 핀치 줌 (LOD 없음 — 캐릭터 중심 고정 줌) ---
// 월드(타일/영토/시야원/펫)를 <Group transform> 으로 화면 중앙(플레이어) 기준 스케일한다. 매 제스처
// 프레임마다 project() 전량 재계산을 피하고 transform 만 바꿔 부드럽게(한 번 그리고 GPU 가 확대/축소).
// 줌 범위는 "화면이 덮는 실제 폭"으로 정한다: 화면 실제폭(m) = W / PX_PER_M / zoom.
//   - 최대 줌아웃(ZOOM_MIN) = 화면 ~1.5km -> zoom = W/PX_PER_M/1500. 표준폰(W=393, PX=1.28)서 ≈ 0.205 -> 0.2.
//   - 최대 줌인(ZOOM_MAX)   = 화면 ~205m  -> zoom = W/PX_PER_M/205.  같은 기준서 ≈ 1.5(유지).
// 표준폰 기준 상수로 고정한다(기기 폭에 따라 실제 커버 km 가 ±10% 안팎으로 흔들리나 무시 가능).
// 50m 헥스 화면폭 = HEX_W×zoom(= 50m×W/실제폭, split 무관): ZOOM_MIN서 64×0.2 ≈ 13px(작지만 도트 구분됨),
// ZOOM_MAX서 64×1.5 = 96px(시원하게 큼). 기본 줌(초기 0.5)은 화면 ~600m·헥스 32px 중간 뷰.
// 13px 이 작다 싶으면 최대 줌아웃을 1km 로 좁힌다(ZOOM_MIN=0.307 -> 헥스 ~20px). 사용자 판단.
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 1.5;

// --- 카메라(월드 추적) ---
// 포켓몬고식: 격자/타일/점령색이 월드에 박혀 카메라를 따라 흐르고, 캐릭터도 같은 월드 Group 안에서
// 함께 변환된다. 카메라(cam)는 내 좌표를 즉시 따라가고(텀 없음), 캐릭터는 화면 중앙에 정합한다.
// 베이크 앵커 재설정 임계 거리(px). 내 좌표가 앵커에서 이만큼 멀어졌을 때만 격자를 다시 굽는다.
// 매 좌표마다 재베이크하면 출렁였다(state bakeAnchor 와 SharedValue cam 의 타이밍 점프 + 545칸 재굽기).
// 앵커 고정 동안은 cam 만 흐르고 camOffset 이 부드럽게 변해 격자가 매끄럽게 슬라이드한다.
const REBAKE_DIST = 200;

// 보드 게임 판 바탕 톤(우드/베이지/펠트 계열). 화면 고정 단색 Fill 로 항상 화면 전체를 덮어
// 줌아웃/카메라 이동에도 빈틈(검은 void)이 없다. 옅은 격자 패턴이 이 위에 얹혀 "보드판" 질감을 준다.
const BG_COLOR = "#e7e1cf";

// --- 보드 게임 판 격자 패턴 ---
// 실제 지도 타일(Voyager/OSM)을 걷어내고, 판 위 옅은 격자선으로 "보드 게임판" 느낌을 준다.
// 패턴은 월드(worldTransform) 안에 베이크되어 걸으면(카메라 이동) 함께 흐르고, 줌/드래그에도
// 격자·펫과 같은 변환을 거친다 -> "판 위를 걷는" 정합. 화면 고정은 단색 BG_COLOR 뿐이다.
// 저대비 warm brown 선이라 헥스 도트를 방해하지 않는다(은은하게, 과하지 않게).
const BOARD_TILE_PX = 64; // 판 격자 한 칸(bake space px). 화면 칸 = BOARD_TILE_PX×zoom.
const BOARD_LINE_PX = 2; // 격자선 두께(bake space px). zoom 스케일되어 줌아웃 시 옅게 사라진다.
const BOARD_LINE_COLOR = "rgba(120, 90, 55, 0.08)"; // 옅은 우드 브라운 격자선(저대비)

// --- 시야 원 ---
// 미점령 프런티어를 펫 주변 몇 링까지 미리 보여줄지 정하는 렌더 전용 반경(점령 칸은 반경과 무관하게 항상 그림).
// 반지름 = VISION_RING * 셀간격 * PX_PER_M. 화면 격자 설계 칸(=50m, res11)에 맞춰 셀 간격 50m 로 둔다.
// 8 * 50 * 1.28 = 512px(bake 공간) -> 8 칸(~400m) 반경. worldGroup zoom 으로 화면에선 함께 스케일.
const VISION_RING = 8;
const CELL_SPACING_M = 50;
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

// 타일 타입 = 아틀라스 row. col 은 같은 타입의 모양 변형(같은 칸은 항상 같은 변형).
// 새 6종 타일셋 기준(assets/tiles/grid_coordinate.json 의 sprite_{row}_{col}).
const TILE_TYPE_BY_ROW = [
  "grassland", // 0 초원
  "sand", // 1 흙·사막 (col 0~2 흙, 3~4 모래)
  "water", // 2 물
  "coast", // 3 해안선 (col 0~1 초원용, 2~6 사막용)
  "stone", // 4 돌바닥
  "snow", // 5 눈
];

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
// 게임 성장 단계(stageFromLevel 반환 문자열) -> 아틀라스 열. 알->col1 ... 성년->col5.
// stage 가 바뀌면 자동으로 다른 프레임이 골라져 진화가 화면에 보인다.
const PET_STAGE_COL = { 알: 1, 유년: 2, 소년: 3, 청년: 4, 성년: 5 };
// 성년기(col5, 가장 큰 원본)가 화면에서 ~68px 높이가 되도록 공통 스케일. 펫은 worldGroup 안이라
// 화면 크기 = PET_TARGET_MAX_H×zoom, 헥스 칸 = HEX_W×zoom -> 펫:칸 ≈ 68:64(≈1칸, 발밑 앵커라 살짝 솟음).
// res11 전환에도 HEX_W(64)를 유지했으므로 이 비율은 그대로 -> 펫이 자동으로 50m 칸에 비례(PET_SCALE 재조정 불필요).
// 더 낮게 깔고 싶으면 이 값만 낮춘다(예: 52 -> 펫 ≈ 0.8칸). 사용자 판단.
// 모든 단계에 같은 배율 -> 단계가 작을수록 원본이 작아 자연히 작게 그려진다(성장감).
const PET_TARGET_MAX_H = 68;
const PET_MAX_FRAME = PET_FRAMES_BY_NAME[`sprite_${PET_TYPE_ROW}_5`];
const PET_SCALE = PET_TARGET_MAX_H / PET_MAX_FRAME.h; // ≈ 0.35

// --- 펫 미세 모션(이동 hop + idle 숨쉬기) ---
// 프레임 시트 없이 정적 스프라이트 한 장을 transform 만으로 살아 움직이게 한다.
// clock(useClock, ms) 경과시간으로 "걸음 직후 통통 튐(hop)" 과 "가만히 있을 때 숨쉬기(idle)" 를
// 하나의 상태머신으로 가른다. coords 가 갱신되면(걸음) hopStart 를 현재 clock 으로 리셋 ->
// HOP_WINDOW 동안 hop, 그 뒤 idle. 발밑(로컬 원점) 앵커라 scaleY 는 발 고정·세로 늘림이 자연스럽다.
const HOP_WINDOW = 2000; // ms, 좌표 갱신 후 hop 이 지속되는 시간
const HOP_DUR = 350; // ms, hop 1회(올라갔다 내려옴) 주기
const HOP_HEIGHT = Math.round(PET_TARGET_MAX_H * 0.25); // px, 펫 최대 높이의 ~25%(≈17)
const SQUASH = 0.12; // 도약/착지 순간 납작해지는 강도(과하지 않게)
const BREATHE_AMP = 0.025; // idle scaleY 진폭(숨쉬기)
const BREATHE_PERIOD = 2600; // ms, 숨쉬기 1주기

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

// 셀 키 -> 타일 프레임. 테마(셀->타일 규칙) 미정이라 타일셋 전체에서 해시로 결정적 선택
// (같은 칸은 항상 같은 타일). 테마를 정하면(2번) 여기서 타입별 매핑으로 교체한다.
function frameForCell(key) {
  return ATLAS_FRAMES[hashKey(key) % ATLAS_FRAMES.length];
}

// --- 화면 똑바른 pointy-top 육각 격자 ---
// H3 셀을 화면에 투영하면 위치마다 ~14° 기울고 모양이 들쭉날쭉해 똑바로 선 픽셀 스프라이트와 안 맞물린다.
// 해법: 화면에 북쪽 정렬 똑바른 육각 격자를 깔고, 각 칸 중심을 screenToLatLng 로 H3 셀에 역매핑한다.
// 게임 상태(점령/테마)는 H3 그대로, 렌더만 깔끔한 격자.
// HEX_W: 격자 칸 화면 px(=colStep). 실제 대응 크기 = HEX_W/PX_PER_M = 64/1.28 = 50m -> H3 res11 한 칸.
// 값(64)은 res10 때와 동일 유지 -> 헥스 기하(HEX_H/TILE_DRAW_W/TILE_HEX_H)·스프라이트 bake 해상도(원본 198px->64px) 불변.
// 50m 대응은 PX_PER_M(1.28)이 만든다. HEX_H 는 정육각 세로(HEX_W*2/√3), 스프라이트 액자 비율과 별개.
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
// 홀수 행은 colStep/2 가로 오프셋. 칸 폭은 LOD 없이 HEX_W 로 고정 — 화면 칸 크기는 worldGroup 의
// zoom 이 결정한다(줌인 크게 / 줌아웃 작게).
function buildLattice(W, H) {
  const colStep = HEX_W;
  const rowStep = Math.round(HEX_H * 0.75 * ROW_SPACING);
  // margin 은 최대 줌아웃(ZOOM_MIN)에서도 화면을 덮어야 한다. 줌아웃하면 격자가 worldGroup 에서
  // 축소돼(scale=zoom<1) bake 공간에서 W/zoom 만큼 펼쳐져야 화면을 채운다.
  // 커버: (W+2·margin)·ZOOM_MIN ≥ W → margin ≥ W·(1/ZOOM_MIN−1)/2. REBAKE_DIST 는 카메라 드리프트 여유
  // (project() 기준 = bake 공간 px, 줌 무관이라 그대로 더한다).
  const marginX = (W * (1 / ZOOM_MIN - 1)) / 2 + REBAKE_DIST;
  const marginY = (H * (1 / ZOOM_MIN - 1)) / 2 + REBAKE_DIST;
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
  const [zoom, setZoom] = useState(0.5); // 초기 ~600m·헥스 32px 중간 뷰(시야원 300m 여유 있게 보임)
  const zoomRef = useRef(0.5); // 라이브 zoom(onEnd 에서 baseline 으로 커밋)
  const baseZoomRef = useRef(0.5); // 직전 제스처 종료 시점의 배율(다음 핀치의 기준)
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
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const basePanRef = useRef({ x: 0, y: 0 });

  // --- 카메라 / 뷰 모드 상태 ---
  // mode: 'player'(카메라가 플레이어를 텀 두고 추적, 줌 피벗=캐릭터) | 'free'(드래그 둘러보기,
  // 카메라 고정, 줌 피벗=화면중앙). 드래그 시작 -> free, "내 위치" 버튼 -> player.
  const [mode, setMode] = useState("player");
  // 카메라 위경도(camSmooth, UI 스레드 SharedValue). coords 를 withTiming 으로 부드럽게 지연 추적
  // (player) / 고정(free). camReady = 첫 좌표 스냅 전 worklet 가드(0/1).
  const camLat = useSharedValue(0);
  const camLng = useSharedValue(0);
  const camReady = useSharedValue(0);
  // 베이크 앵커 = 베이크 시점의 카메라 위경도 스냅({latitude,longitude}). 격자/타일을 "카메라의 칸이
  // 화면중앙"으로 베이크해, 카메라보다 앞선 플레이어가 격자 위를 이동하게 한다(1단계는 coords 앵커라
  // 플레이어가 항상 중앙칸 -> 격자 위 이동이 0이었다). null = 첫 좌표 전.
  const [bakeAnchor, setBakeAnchor] = useState(null);
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        // 핀치와 동일 이유: babel-preset-expo worklets 자동화 탓에 콜백이 UI 스레드 worklet 으로
        // 표시된다 -> 그 안에서 setter/ref 변이를 직접 부르려면 JS 스레드 강제(없으면 첫 드래그 크래시).
        .runOnJS(true)
        .onStart(() => {
          // 손으로 맵을 끄는 순간 플레이어 추적 해제 -> 자유 둘러보기(줌 피벗도 화면중앙으로).
          setMode("free");
        })
        .onUpdate((e) => {
          // 누적 오프셋 = 기준 + 이번 제스처 누적 이동량. SharedValue 직접 변이(React 리렌더 없음)
          // -> 펫(worklet)·월드(DerivedValue)가 같은 UI 스레드 값을 읽어 드래그 중 떨림이 없다.
          panX.value = basePanRef.current.x + e.translationX;
          panY.value = basePanRef.current.y + e.translationY;
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

  // "내 위치 찾기": 자유 둘러보기 -> 플레이어 추적 모드 복귀. 팬 리셋 + 모드 전환.
  // 카메라를 플레이어로 되돌리는 withTiming 은 아래 follow effect 가 mode 변경을 받아 처리한다.
  const recenter = () => {
    basePanRef.current = { x: 0, y: 0 };
    panX.value = 0;
    panY.value = 0;
    setMode("player");
  };

  // 도트 타일 아틀라스(단일 useImage, 호출 순서 불변 -> Hooks 규칙 OK).
  // 로컬 require 라 거의 즉시 로드되지만, 로드 전엔 null -> 단색 헥스로 폴백한다.
  const atlas = useImage(ATLAS_SRC);

  // 펫 크리처 아틀라스(단일 useImage, 호출 순서 불변 -> Hooks 규칙 OK). 로드 전엔 null -> 펫 미표시.
  const petAtlas = useImage(PET_ATLAS_SRC);

  // 화면 고정 똑바른 육각 격자(좌표 무관 순수 기하). W/H 로만 메모(줌은 worldGroup 이 처리).
  const lattice = useMemo(() => buildLattice(W, H), [W, H]);

  // 보드 판 격자 패턴을 단일 Picture 로 베이크한다(좌표 무관 순수 기하 -> W/H 로만 메모).
  // 격자(latticePicture)와 동일한 clip 기준(최대 줌아웃 커버 = W/ZOOM_MIN + REBAKE_DIST)으로 그려
  // 줌/팬/카메라 전 범위를 덮는다. 얇은 fill rect 를 격자선으로 쓴다(nearest, antiAlias off = 픽셀 톤).
  const boardPattern = useMemo(() => {
    const marginX = (W * (1 / ZOOM_MIN - 1)) / 2 + REBAKE_DIST;
    const marginY = (H * (1 / ZOOM_MIN - 1)) / 2 + REBAKE_DIST;
    const left = -marginX;
    const top = -marginY;
    const right = W + marginX;
    const bottom = H + marginY;
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(
      Skia.XYWHRect(left, top, right - left, bottom - top),
    );
    const line = Skia.Paint();
    line.setAntiAlias(false);
    line.setColor(Skia.Color(BOARD_LINE_COLOR));
    // 세로선: bake space 원점 정렬 -> 카메라가 흘러도 격자 위상이 안정적이다.
    // rn-skia: Skia.Path.Rect(rect) 정적 팩토리 + canvas.drawPath(fill) 로 얇은 선 rect 를 그린다.
    const x0 = Math.ceil(left / BOARD_TILE_PX) * BOARD_TILE_PX;
    for (let x = x0; x <= right; x += BOARD_TILE_PX) {
      canvas.drawPath(
        Skia.Path.Rect(Skia.XYWHRect(x, top, BOARD_LINE_PX, bottom - top)),
        line,
      );
    }
    // 가로선.
    const y0 = Math.ceil(top / BOARD_TILE_PX) * BOARD_TILE_PX;
    for (let y = y0; y <= bottom; y += BOARD_TILE_PX) {
      canvas.drawPath(
        Skia.Path.Rect(Skia.XYWHRect(left, y, right - left, BOARD_LINE_PX)),
        line,
      );
    }
    return recorder.finishRecordingAsPicture();
  }, [W, H]);

  // 2)+3) 영토 + 시야 안 프런티어를 하나의 똑바른 격자 Picture 로 "베이크"한다(res10 단일).
  // 각 격자 칸 중심(화면좌표) -> screenToLatLng -> cellKeyAt(H3) 로 역매핑해 점령/테마를 정한다.
  // - 점령 = 불투명 스프라이트(화면 어디든 "불 켜짐").
  // - 시야 원 안 미점령 = 어둠 wash 로 덮음. 시야 밖 미개척 = 생략(지도만 비침).
  // - 현재 셀(currentKey)에 매칭되는 칸 중 중앙에 가장 가까운 칸의 똑바른 육각 보더를 함께 만든다.
  // 재베이크는 bakeAnchor/occupied/currentKey/atlas 가 바뀔 때만(zoom/pan/camera 는 Group transform 이라 deps 아님).
  // 앵커가 카메라(coords 아님)라 화면중앙 칸=카메라칸 -> 플레이어 칸은 off-center.
  const latticePicture = useMemo(() => {
    if (!bakeAnchor) return { picture: null, currentPath: null };
    // 베이크 공간 클립 = buildLattice 와 동일 기준(최대 줌아웃 커버 = W/ZOOM_MIN, REBAKE_DIST 드리프트 여유).
    const marginX = (W * (1 / ZOOM_MIN - 1)) / 2 + REBAKE_DIST;
    const marginY = (H * (1 / ZOOM_MIN - 1)) / 2 + REBAKE_DIST;
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(
      Skia.XYWHRect(-marginX, -marginY, W + 2 * marginX, H + 2 * marginY),
    );

    // res10: 점령=타일, 시야 안 미점령=어둠 wash, 현재 셀 글로우.
    const ccx = W / 2;
    const ccy = H / 2;
    const visionSq = VISION_RADIUS_PX * VISION_RADIUS_PX;
    let currentPath = null;
    let currentDist = Infinity;

    for (const cell of lattice) {
      const ll = screenToLatLng(cell.cx, cell.cy, bakeAnchor, W, H);
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
  }, [lattice, bakeAnchor, occupied, currentKey, W, H, atlas]);

  // --- 현재 셀 glow 맥동(렌더 스레드, React 리렌더 없음) ---
  // rn-skia useClock() = SharedValue<ms>. reanimated useDerivedValue 본문은 babel worklets 로
  // 자동 worklet 화되어 UI 스레드에서 매 프레임 평가된다(무거운 useMemo 재계산 없음).
  // 기본 맥동: 0~1 을 ~1.2초(0.005 rad/ms) 주기로 숨쉬듯. agenTree 의 0.72+0.28*sin 결을 Skia 로 옮김.
  const clock = useClock();
  // 은은한 글로우 opacity 0.12~0.42 (숨쉬듯 약하게 맥동). 선 없이 이 글로우만으로 현재 칸을 표시.
  const haloOpacity = useDerivedValue(
    () => 0.2 + 0.35 * (0.5 + 0.5 * Math.sin(clock.value * 0.005)),
  );

  // --- 카메라 추적(follow) ---
  // player 모드: 새 좌표/모드복귀마다 카메라를 그쪽으로 withTiming(부드럽게). 동시에 베이크 앵커를
  // "직전 카메라 위치"로 스냅 -> 카메라가 그 앵커에서 새 좌표로 흐르며 격자가 그만큼 슬라이드한다
  // (앵커가 카메라값이라 화면중앙=카메라칸, 플레이어는 앞선 칸 위 -> 격자 위 이동이 보인다).
  // 앵커는 매번 직전 카메라값(연속)이라 재베이크에도 점프 없음(1단계 앵커 상쇄 원리 동일).
  // free 모드: 카메라/앵커 고정(추적 안 함). occupied/currentKey 변화만 격자 색 재베이크.
  useEffect(() => {
    if (!coords) return;
    if (camReady.value === 0) {
      // 첫 좌표: 카메라=나 스냅 + 베이크 앵커도 나(오프셋 0, 갑작스런 흐름 없이 시작).
      camLat.value = coords.latitude;
      camLng.value = coords.longitude;
      camReady.value = 1;
      setBakeAnchor({ latitude: coords.latitude, longitude: coords.longitude });
      return;
    }
    if (mode === "player" && bakeAnchor) {
      // 카메라 = 내 좌표(텀 없이 즉시 일치). 캐릭터는 항상 화면 중앙, 격자/배경이 내 이동을 따라 흐른다.
      // (텀 추적은 출렁임/줌아웃 튕김을 만들어 제거.)
      camLat.value = coords.latitude;
      camLng.value = coords.longitude;
      // 베이크 앵커(state)는 자주 안 바꾼다 -> 내 좌표가 앵커에서 화면상 REBAKE_DIST 이상 멀어졌을
      // 때만 재베이크. 앵커 고정 동안은 cam 만 흐르고 camOffset 이 부드럽게 변해 격자가 매끄럽게
      // 슬라이드한다(재베이크 시점도 앵커 상쇄로 화면위치 연속 -> 점프 없음).
      const p = project(coords.latitude, coords.longitude, bakeAnchor, W, H);
      const dist = Math.hypot(p.x - W / 2, p.y - H / 2);
      if (dist > REBAKE_DIST) {
        setBakeAnchor({ latitude: coords.latitude, longitude: coords.longitude });
      }
    }
  }, [coords, mode, camLat, camLng, camReady, bakeAnchor, W, H]);

  // 월드 카메라 오프셋(px) = (베이크 앵커 − 카메라 좌표) 투영. 월드는 bakeAnchor 기준으로 베이크되므로
  // 이 오프셋만큼 밀면 "카메라(camSmooth) 기준 정렬"로 바뀐다(앵커가 수식에서 상쇄 -> 고정 월드점은
  // project(P, camSmooth) 위치에 연속으로 머묾). 카메라가 흐르면 격자/타일이 통째로 슬라이드.
  const camOffset = useDerivedValue(() => {
    if (!bakeAnchor || camReady.value === 0) return { x: 0, y: 0 };
    const kLng =
      M_PER_DEG_LAT * Math.cos((bakeAnchor.latitude * Math.PI) / 180) * PX_PER_M;
    const kLat = M_PER_DEG_LAT * PX_PER_M;
    return {
      x: (bakeAnchor.longitude - camLng.value) * kLng,
      y: -(bakeAnchor.latitude - camLat.value) * kLat, // 화면 y 는 아래로 증가 -> 부호 뒤집기
    };
  }, [bakeAnchor]);

  // 월드 레이어(줌/팬 Group) 바깥을 한 겹 더 감싸는 카메라 평행이동(스크린 공간, 줌 영향 없음).
  // 줌/팬 안쪽을 통째로 밀어 격자·타일·점령색이 카메라를 따라 흐른다(매 프레임 lerp).
  const cameraTransform = useDerivedValue(() => {
    const off = camOffset.value;
    return [{ translateX: off.x }, { translateY: off.y }];
  });

  // 펫 오프셋(px) = (내 좌표 − 카메라 좌표) 투영. 펫은 격자(카메라 앵커)와 달리 "내 실제 위치"를
  // 카메라 기준으로 그린다 -> 카메라가 뒤처지면 펫이 화면중앙에서 진행방향으로 앞서고(격자 위 이동),
  // 카메라가 따라잡으면 중앙쯤 복귀. world camOffset 과 분리(앵커가 coords 라 격자와 다른 양으로 움직임).
  // 펫 베이크 좌표(그리드와 같은 좌표계 = project(*, bakeAnchor)). 펫을 월드 Group(카메라+줌/팬) 안에
  // 그려 그리드와 동일 변환을 거치게 한다 -> 드래그/줌/모드 무관하게 항상 격자와 정합(붙어다님).
  // 카메라 추적(cam)·줌·팬은 그 Group 들이 처리하므로 여기선 baked 좌표만 둔다.
  const petBase = useMemo(() => {
    if (!coords || !bakeAnchor)
      return { x: Math.round(W / 2), y: Math.round(H / 2) };
    return project(coords.latitude, coords.longitude, bakeAnchor, W, H);
  }, [coords, bakeAnchor, W, H]);

  // --- 펫 hop 트리거(좌표 갱신 = 걸음) ---
  // coords 가 바뀔 때마다 hopStart 를 "지금"(현재 clock)으로 리셋 -> 아래 상태머신이 hop 으로 전환.
  // App.js 를 건드리지 않고 PixelHexMap 내부에서 끝낸다(coords 는 이미 prop 으로 들어온다).
  // -HOP_WINDOW 로 초기화 -> 첫 effect 전까지는 idle(첫 프레임에 의도치 않은 hop 방지).
  const hopStart = useSharedValue(-HOP_WINDOW);
  useEffect(() => {
    // clock 은 reanimated SharedValue -> .value 는 JS 스레드에서 읽기 가능(최근 프레임 값).
    hopStart.value = clock.value;
  }, [coords, clock, hopStart]);

  // --- 펫 transform(이동 hop + idle 숨쉬기) ---
  // useDerivedValue 본문은 babel worklets 로 UI 스레드에서 매 프레임 평가된다(React 리렌더 없음).
  // 위치/반전(W/H/panX/panY/facingRight/stage)은 JS 값이라 클로저 캡처 + deps 로 갱신한다.
  // 반환 배열 = 펫 Group transform(뒤 항목이 점에 먼저 적용 -> scaleY/scaleX 가 발밑 원점에 먼저).
  const petTransform = useDerivedValue(() => {
    // 펫은 월드 Group(카메라+줌/팬) 안에 그려져 그리드와 동일 변환을 거친다 -> 위치 정합은 Group 이
    // 담당하고, 여기선 베이크 좌표 + hop/숨쉬기/좌우반전만. 크기(PET_SCALE)는 고정이고 화면 크기는
    // worldGroup 의 scale:zoom 이 정한다(줌인 크게 / 줌아웃 작게 — 격자와 함께 스케일).
    // 기본 왼쪽 보기 -> facingRight 면 가로 반전(±1). 알(stage 알)은 방향 없어 반전 안 함.
    const baseScaleX = facingRight && stage !== "알" ? -1 : 1;

    const elapsed = clock.value - hopStart.value;
    let hopY = 0;
    let squashY = 1;
    let squashX = 1;
    if (elapsed >= 0 && elapsed < HOP_WINDOW) {
      // 이동 중: 통통 튐. phase 0->1 반복, sin 으로 위로 포물선(정점=1, 바닥=0).
      const phase = (elapsed % HOP_DUR) / HOP_DUR;
      const lift = Math.sin(phase * Math.PI);
      hopY = -HOP_HEIGHT * lift; // 음수 = 위로
      squashY = 1 - SQUASH * (1 - lift); // 바닥 근처(lift~0)에서 가장 납작
      squashX = 1 / squashY; // 부피보존 느낌(납작할 때 옆으로 약간 퍼짐)
    } else {
      // 대기: 숨쉬기. scaleY 만 약하게 맥동(가로는 고정).
      const breathe = Math.sin((clock.value / BREATHE_PERIOD) * 2 * Math.PI);
      squashY = 1 + BREATHE_AMP * breathe;
    }

    return [
      { translateX: petBase.x },
      { translateY: petBase.y + hopY },
      { scaleX: baseScaleX * squashX },
      { scaleY: squashY },
    ];
  }, [petBase, facingRight, stage]);

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

  // --- 월드 transform(줌 피벗 + 팬) ---
  // 팬(panX/panY)은 SharedValue -> worldTransform 을 DerivedValue 로 만들어 펫과 같은 UI 스레드 값을
  // 읽게 한다(드래그 중 펫-월드 타이밍 불일치 떨림 제거). pivot/zoom 은 JS 값이라 deps 로 갱신.
  // early return 위에 둬 Hooks 규칙 준수(coords null 이면 pivot 기본=화면중앙).
  const cx0 = Math.round(W / 2);
  const cy0 = Math.round(H / 2);
  let worldPivotX = cx0;
  let worldPivotY = cy0;
  if (mode === "player" && bakeAnchor && coords) {
    // player 줌 피벗 = 캐릭터 위치. petBase(= project(coords, bakeAnchor))와 동일하므로 재사용.
    worldPivotX = petBase.x;
    worldPivotY = petBase.y;
  }
  const worldTransform = useDerivedValue(
    () => [
      { translateX: panX.value },
      { translateY: panY.value },
      { translateX: worldPivotX },
      { translateY: worldPivotY },
      { scale: zoom },
      { translateX: -worldPivotX },
      { translateY: -worldPivotY },
    ],
    [worldPivotX, worldPivotY, zoom],
  );

  // coords 가 없으면 단색 배경만(App 의 상태 카드가 "위치 확인 중"을 표시). 크래시 가드.
  if (!coords) {
    return (
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color={BG_COLOR} />
      </Canvas>
    );
  }

  return (
    <View style={styles.container}>
      <GestureDetector gesture={composedGesture}>
        <Canvas style={StyleSheet.absoluteFill}>
          {/* 1) 배경 단색 fallback: Group 밖(항상 화면 전체를 덮어 줌아웃 시 빈틈 없음). */}
          <Fill color={BG_COLOR} />

          {/* 카메라: 월드 전체를 카메라 오프셋만큼 스크린 평행이동(줌/팬 바깥, 매 프레임 lerp).
              걸으면 이 Group 이 흘러 격자·타일·점령색이 카메라를 따라간다. */}
          <Group transform={cameraTransform}>
          {/* 월드: 타일/영토/프런티어를 한 Group 으로 묶어 GPU 스케일(줌)+팬. */}
          <Group transform={worldTransform}>
            {/* 1) 보드 판 격자 패턴: 월드 안에 베이크 -> 걸음(카메라)·줌·드래그에 격자·펫과 함께 흐른다.
                미개척(시야 밖) 칸은 이 판 위 격자만 보인다(fog of war = 아직 안 밟은 보드판). */}
            <Picture picture={boardPattern} />

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

            {/* 6) 펫 크리처: 월드 Group 안 = 그리드와 동일 변환(카메라+줌/팬)을 거쳐 항상 격자와 정합.
              위치는 베이크 좌표(petBase), hop/숨쉬기/좌우반전은 로컬, 크기는 Group scale(zoom)이 처리.
              petPicture=null(로드 전)이면 아무것도 안 그림. */}
            {petPicture && bakeAnchor && (
              <Group transform={petTransform}>
                <Picture picture={petPicture} />
              </Group>
            )}
          </Group>
          </Group>
        </Canvas>
      </GestureDetector>

      {/* "내 위치 찾기" 버튼: 자유 둘러보기(mode==='free') 중에만 표시. 탭하면 플레이어 추적 복귀.
          Canvas 위에 RN 뷰를 못 그리니 절대배치 Pressable 오버레이로 둔다(카드/로그와 안 겹치게 우측). */}
      {mode === "free" && (
        <Pressable style={styles.recenterButton} onPress={recenter} hitSlop={8}>
          <Text style={styles.recenterIcon}>◎</Text>
        </Pressable>
      )}

      {/* 디버그 오버레이(개발용): 줌 수치 조정 편의. zoom/헥스 칸폭/배경z/모드.
          pointerEvents none 으로 제스처를 통과시킨다. 조정 끝나면 이 블록만 지우면 된다. */}
      <View style={styles.debug} pointerEvents="none">
        <Text style={styles.debugText}>
          zoom {zoom.toFixed(3)} · cell {Math.round(HEX_W * zoom)}px
        </Text>
        <Text style={styles.debugText}>
          board · {mode}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // 디버그 오버레이(개발용, LOD 수치 조정): 좌하단 반투명 박스 + 형광 텍스트.
  debug: {
    position: "absolute",
    left: 12,
    bottom: 40,
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  debugText: {
    color: "#7CFC00",
    fontSize: 12,
    fontWeight: "600",
  },
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
