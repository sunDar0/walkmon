import {
  BlendMode,
  BlurMask,
  Canvas,
  Circle,
  Fill,
  FilterMode,
  Group,
  MipmapMode,
  PaintStyle,
  Path,
  Picture,
  RoundedRect,
  Skia,
  useClock,
  useImage,
} from "@shopify/react-native-skia";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
// ZOOM_MAX서 64×1.5 = 96px(시원하게 큼). 최초/기본 줌은 이 범위 안에서 initialZoomForRing(W,H) 로 계산한다
// (2링 19칸 fit, iPhone 17 Pro 기준 ≈ 1.07). ZOOM_MAX 고정이 아니라서 최초 상태에서도 핀치 줌인 여유가 있다.
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

// --- 보드 게임 판 육각 격자 패턴 ---
// 실제 지도 타일(Voyager/OSM)을 걷어내고, 판 위 옅은 "육각 윤곽"으로 "보드 게임판" 느낌을 준다.
// 정사각 격자였던 것을 게임 타일과 같은 pointy-top 육각으로 바꿔, buildLattice 와 동일한 기하(colStep/rowStep/
// 홀수행 오프셋/원점)에 straightHexPath stroke 만 그린다 -> 빈 판의 옅은 육각과 드러난 타일 육각이 1:1 정렬된다.
// 패턴은 월드(worldTransform) 안에 베이크되어 걸으면(카메라 이동) 함께 흐르고, 줌/드래그에도 격자·펫과 같은
// 변환을 거친다 -> "판 위를 걷는" 정합. 화면 고정은 단색 BG_COLOR 뿐이다. 저대비 warm brown 윤곽이라 도트를 안 가린다.
const BOARD_LINE_PX = 2; // 육각 윤곽 두께(bake space px). zoom 스케일되어 줌아웃 시 옅게 사라진다.
// 개발용 디버그 오버레이(zoom·cell·mode) 표시 여부. 화면 정돈 위해 기본 off, 줌 조정 필요 시 true.
const SHOW_DEBUG_OVERLAY = false;
const BOARD_LINE_COLOR = "rgba(120, 90, 55, 0.08)"; // 옅은 우드 브라운 윤곽선(저대비)

// --- reveal 낙하 등장 애니메이션 (game-core 계약 p15) ---
// 렌더 대상 = reveal `cells`(revealedCells.has(key) 멤버십). 이번 스텝 신규 = `newly`(newlyRevealed, 낙하 대상).
// 기존 VISION_RING(원형 시야 ~400m) 렌더는 폐기 — reveal 멤버십으로 "그릴지"를 판정한다(점령 여부는 스타일만).
// 신규 칸은 "화면 위 경계 바깥"에서 시작해 ease-out-bounce 로 낙하해 안착한다(화면 안에서 대기/시작하지 않게).
// 시작 높이는 고정값이 아니라 뷰포트를 확실히 벗어나도록 런타임에 (H + 여유)/zoom bake px 로 계산한다
//   (bake translateY × zoom = 화면 lift = H+여유 -> 화면 y ≤ H 인 어떤 칸도 위로 벗어남, zoom 무관 상수).
// clock(useClock) 기반 UI 스레드 구동(React 리렌더 없음). 낙하 종료 후엔 정적 bake 로 흡수(JS 타이머).
const DROP_MARGIN = 80; // px, 화면 위 경계 밖으로 확실히 나가게 하는 여유(화면 px 기준). 낙하/캐릭터 공용.
const DROP_DURATION = 920; // ms, 낙하 1회(가속 낙하 + 세틀 바운스). 시작높이를 화면 높이로 키운 만큼 늘려 속도 완화.
const DROP_STAGGER_SPAN = 200; // ms, 칸키 해시로 흩뿌리는 최대 시작 지연(이동 reveal 칸이 한꺼번에 안 떨어지게)

// --- 앱 최초 기동 인트로 연출 ---
// 최초/리셋 후 첫 reveal(19칸)은 "뚝뚝 순차"로 낙하한 뒤, 그리드가 전부 안착하면 캐릭터(펫)가 마지막에 낙하.
// 순차 지연은 칸키 해시(hashKey) 정렬 rank × STEP 로 만든다(무작위 순서·거리순 아님, 결정적 -> Math.random 회피).
const INTRO_STAGGER_STEP = 110; // ms, 인트로 칸당 순차 간격(뚝뚝 떨어지는 리듬)
// 캐릭터 낙하 시작 높이도 화면 밖 보장: (petBase.y + DROP_MARGIN)/zoom bake px 로 런타임 계산(bodyMotion 참고).
const PET_DROP_DURATION = 900; // ms, 캐릭터 낙하 1회(가속 낙하 + 세틀 바운스). 그리드 낙하와 같은 결로 완만하게.

// easeDropSettle: 0->1 진행도("하늘에서 자연스럽게 떨어져 사뿐히 안착"). translateY = -dropHeight*(1-e) 로 쓰인다.
// 이전 easeOutBounce 는 시작부터 급강하(t=0 미분 큼)라 큰 낙하거리와 겹쳐 "총알처럼 꽂히는" 느낌이었다.
// 대신 [0,tf] 는 ease-in-quad(중력 낙하: 처음 느리게 가속) → [tf,1] 은 착지 후 한 번 살짝 튀고 잦아드는 세틀.
// worklet 로 표시해 useDerivedValue 안에서 호출.
function easeDropSettle(t) {
  "worklet";
  const tf = 0.8; // 바닥 첫 접촉 시점(80% 낙하 / 20% 세틀 바운스)
  if (t < tf) {
    const x = t / tf;
    return x * x; // ease-in quad: 완만히 가속해 낙하(시작 급강하 없음)
  }
  const x = (t - tf) / (1 - tf); // 0..1 세틀 구간
  return 1 - Math.sin(x * Math.PI) * 0.06 * (1 - x); // 착지서 한 번 살짝(≤6%) 튀고 잦아들어 안착
}

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
// 4줄 = 속성 타입: 0=불(빨강), 1=물(파랑), 2=땅(갈색), 3=바람(초록 스프라이트는 임시 placeholder).
// 6열: col0=속성아이콘, col1=알, col2=유년, col3=소년, col4=청년, col5=성년기(왼->오 점점 큼).
const PET_ATLAS_SRC = require("../assets/pet/monster_packed.png");
const PET_FRAMES = require("../assets/pet/monster_coordinate.json").frames;
const PET_FRAMES_BY_NAME = {};
for (const f of PET_FRAMES) PET_FRAMES_BY_NAME[f.name] = f;

// 펫 속성(아틀라스 row)은 App.js 가 넘기는 petType prop(0=불/1=물/2=땅/3=바람)으로 결정한다.
// 프레임 이름은 `sprite_${petType}_${col}` 로 조립(petPicture 참고). 미전달 시 0(불) 폴백.
// 게임 성장 단계(stageFromLevel 반환 문자열) -> 아틀라스 열. 알->col1 ... 성년->col5.
// stage 가 바뀌면 자동으로 다른 프레임이 골라져 진화가 화면에 보인다.
const PET_STAGE_COL = { 알: 1, 유년: 2, 소년: 3, 청년: 4, 성년: 5 };
// 성년기(col5, 가장 큰 원본)가 화면에서 ~68px 높이가 되도록 공통 스케일. 펫은 worldGroup 안이라
// 화면 크기 = PET_TARGET_MAX_H×zoom, 헥스 칸 = HEX_W×zoom -> 펫:칸 ≈ 68:64(≈1칸, 발밑 앵커라 살짝 솟음).
// res11 전환에도 HEX_W(64)를 유지했으므로 이 비율은 그대로 -> 펫이 자동으로 50m 칸에 비례(PET_SCALE 재조정 불필요).
// 더 낮게 깔고 싶으면 이 값만 낮춘다(예: 52 -> 펫 ≈ 0.8칸). 사용자 판단.
// 모든 단계에 같은 배율 -> 단계가 작을수록 원본이 작아 자연히 작게 그려진다(성장감).
// 스케일은 petType(row)마다 col5 원본 높이가 다를 수 있어 petPicture 안에서 row 별로 계산한다.
const PET_TARGET_MAX_H = 68;

// --- 플레이어(트레이너) 스프라이트(player_packed.png) ---
// 현재 위치 타일 중앙(펫이 서던 자리)에 트레이너를 세운다. 단일 프레임(sprite_0_0, 938×1659, 정면).
// 펫 아틀라스는 assets/pet/ 이므로 같은 구조로 assets/player/ 에 복사해 require(sample/ 원본은 그대로).
// 방향 변형이 없어 좌우는 펫과 같은 수평 반전(facingRight). 베이크는 펫과 동일 파이프라인(원본->타일 비례
// 축소, nearest-neighbor). 발밑 앵커(타일 중심에 발이 닿게).
const PLAYER_ATLAS_SRC = require("../assets/player/player_packed.png");
const PLAYER_FRAME = require("../assets/player/player_coordinate.json").frames[0];
// 트레이너 렌더 높이(bake px). 펫 성년기(PET_TARGET_MAX_H=68)보다 약간 크게(트레이너>펫). 발밑 앵커라
// 원본(1659px)을 이 높이로 nearest 축소한다. 화면 크기 = PLAYER_TARGET_H×zoom(worldGroup scale).
const PLAYER_TARGET_H = 84;

// --- 크리처(펫) 배치 오프셋 ---
// 부화 후(유년~성년)는 플레이어와 한 칸에서 일부 포개져 서고, 이동 방향 기준 "뒤따르는 쪽"으로 살짝 치우친다.
//   동쪽 이동(facingRight=true) -> 크리처가 왼쪽(서, 화면 -x) / 서쪽 이동 -> 오른쪽(동, 화면 +x).
const CREATURE_SIDE_DX = 20; // 크리처 옆자리 가로 오프셋(bake px). 작게 둬 플레이어와 일부 겹치게(포개진 배치).
// 2.5D 에서 화면 아래 = 시청자 쪽. 크리처를 몇 px 아래로 내려 "플레이어보다 살짝 앞에 선" 깊이감을 준다.
const CREATURE_FRONT_DY = 6; // 크리처 앞쪽 세로 오프셋(bake px, +면 화면 아래=앞).
// 알 단계(stage 알)는 옆에 세우지 않고 플레이어가 "안고 있는" 형태(옆구리/몸통 높이에 겹침). hop/숨쉬기 없이
// 플레이어에 붙어 함께 움직인다(플레이어 수직 병진 offsetY 공유, 독립 hop·squash 없음).
const HELD_DX = 14; // 알 안기 가로 오프셋(플레이어 정면 쪽, bake px)
const HELD_UP = 26; // 알 안기 세로 오프셋(발밑 -> 옆구리/몸통 높이, bake px)
const HELD_SCALE = 0.55; // 알 안기 축소 배율 — 원본 알이 플레이어 몸통을 덮을 만큼 커서 안았을 때만 줄인다
const HELD_ATTACH_H = 48; // 알이 붙어 있는 플레이어 가슴 높이(bake px). 숨쉬기(squashY)로 이 지점이 오르내리는 만큼 알도 함께 움직인다

// --- 시무룩(건강코드) 연출 ---
// health 배열에 코드가 있으면 크리처를 "시무룩"하게: (a) 옅은 회청색 틴트, (b) 살짝 처진 오프셋.
// 최소 구현 — 에셋 추가 없이 petPicture 베이크 시 색필터(Modulate=곱)로 톤을 눌러 칙칙하게 만들고,
// 부화 크리처 transform 에 몇 px 아래 오프셋만 준다(알은 안긴 상태라 틴트만 적용, 처짐 없음).
// Modulate(r=s*d)는 스프라이트 알파를 보존하므로 투명 영역은 그대로 두고 불투명 도트만 눌린다.
const SAD_TINT_COLOR = "#a7adc0"; // 옅은 회청색(곱하면 채도↓·약간 어둡게 = 풀죽은 톤)
const SAD_DROOP_DY = 3; // px(bake), 부화 크리처를 살짝 아래로 내려 "처진" 느낌

// --- 능동 소통(감정 ②·말풍선 ③·케어 손맛 ④) ---
// emotion 우선순위: sick(health>0) > joy(케어 직후) > neutral.
//  - sick: 시무룩(회청 틴트 + 처짐). joy/neutral: 처짐·틴트 없음. 배고픔 신호는 크리처가 아니라 말풍선(needMeter)이 전담.
//  - joy·손맛은 careEvent(App 이 케어 성공 시 찍는 {action,at}) 로 clock 기반 판정(휘발, 저장 안 함).
const JOY_MS = 1800; // 케어 직후 파티클(하트/반짝) 1회 재생 지속(ms). joy 감정도 이 창 동안.
// 케어 액션군 -> 파티클 종류. feed/snack/pet/play = 하트 팝 + 몸 통통 튐, wash/clean/poop = 반짝(sparkle, 튐 없음).
const CARE_HEART_ACTIONS = new Set(["feed", "snack", "pet", "play"]);
// 미터별 요구 색(App METER_META 와 동일: 포만 주황·행복 분홍·청결 청록). 말풍선 아이콘 색.
const NEED_COLORS = { satiety: "#f59e0b", happiness: "#ec4899", cleanliness: "#06b6d4" };
// 파티클 색(하트=분홍, 반짝=금색). 하트는 행복 톤, 반짝은 청결/반짝임 톤.
const HEART_PARTICLE_COLOR = "#ff5c8a";
const SPARKLE_PARTICLE_COLOR = "#ffd34d";
const CARE_PARTICLE_COUNT = 5; // 팝 파티클 개수(고정 -> Hooks 순서 불변)

// 절차적 심볼 SVG(이모지 tofu 회피 — 시뮬레이터에서 확실히 렌더. 원점 중심, ~16px).
// 말풍선/파티클 공용. Skia.Path.MakeFromSVGString 로 SkPath 로 굽는다(컴포넌트 useMemo, null 가드).
const HEART_SVG =
  "M0 -4 C-2 -9 -8 -8 -8 -3 C-8 1 -3 4 0 7 C3 4 8 1 8 -3 C8 -8 2 -9 0 -4 Z";
const DROPLET_SVG =
  "M0 -8 C4 -2 6 1 6 4 C6 8 3 10 0 10 C-3 10 -6 8 -6 4 C-6 1 -4 -2 0 -8 Z";
const SPARKLE_SVG = "M0 -7 L2 -2 L7 0 L2 2 L0 7 L-2 2 L-7 0 L-2 -2 Z";

// 말풍선 규격(bake px). 크리처 머리 위에 뜨는 흰 라운드 rect + 아래 꼬리 삼각형 + 요구 심볼.
const BUBBLE_W = 46;
const BUBBLE_H = 34;
const BUBBLE_R = 11;
const BUBBLE_BOB_AMP = 4; // px, 부유(bob) 진폭
const BUBBLE_BOB_PERIOD = 1600; // ms, 부유 1주기
const BUBBLE_FADE_MS = 300; // ms, 등장 페이드인
// 크리처 머리 꼭대기 기준 오프셋(bake px). petBase(발밑) 위로 크리처 높이만큼 + 여유.
const HEAD_UP = PET_TARGET_MAX_H + 6;

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

// bodyMotion: 캐릭터(플레이어/크리처) 공용 수직 모션 계산(인트로 낙하 + 이동 hop + idle 숨쉬기).
// 플레이어·부화 크리처가 같은 리듬으로 함께 움직이도록 한 워클릿으로 뽑았다(easeDropSettle 과 동일 패턴).
// 반환: { offsetY(위로 -, 낙하/hop 병진), squashX/Y(hop·숨쉬기 스케일) }. 알(held)은 offsetY 만 쓰고 squash 는 무시.
// petBaseY = 펫 화면 y(낙하 시작 높이 = 화면 밖 보장에 사용), zoom = 월드 스케일(낙하 높이 zoom 무관 정합).
// 주의: 반드시 참조 상수들(HOP_*/SQUASH/BREATHE_*/PET_DROP_DURATION/DROP_MARGIN) 선언 뒤에 정의할 것 —
// 모듈 worklet 클로저는 정의 시점 값을 잡으므로, 상수보다 앞에 두면 캡처가 깨져 squash 가 NaN(투명)이 된다(p23 실측).
function bodyMotion(clockV, dropStartV, hopStartV, petBaseY, zoom) {
  "worklet";
  const dropElapsed = clockV - dropStartV;
  const dropping = dropElapsed >= 0 && dropElapsed < PET_DROP_DURATION;
  let offsetY = 0;
  let squashX = 1;
  let squashY = 1;
  if (dropping) {
    const dt = Math.min(1, dropElapsed / PET_DROP_DURATION);
    const dropHeight = (petBaseY + DROP_MARGIN) / zoom; // 화면 위 경계 밖에서 출발
    offsetY = -dropHeight * (1 - easeDropSettle(dt)); // 위(-, 화면 밖)에서 안착(0)
  } else {
    const elapsed = clockV - hopStartV;
    if (elapsed >= 0 && elapsed < HOP_WINDOW) {
      // 이동 중: 통통 튐. phase 0->1 반복, sin 으로 위로 포물선(정점=1, 바닥=0).
      const phase = (elapsed % HOP_DUR) / HOP_DUR;
      const lift = Math.sin(phase * Math.PI);
      offsetY = -HOP_HEIGHT * lift; // 음수 = 위로
      squashY = 1 - SQUASH * (1 - lift); // 바닥 근처(lift~0)에서 가장 납작
      squashX = 1 / squashY; // 부피보존 느낌(납작할 때 옆으로 약간 퍼짐)
    } else {
      // 대기: 숨쉬기. scaleY 만 약하게 맥동(가로는 고정).
      const breathe = Math.sin((clockV / BREATHE_PERIOD) * 2 * Math.PI);
      squashY = 1 + BREATHE_AMP * breathe;
    }
  }
  return { offsetY, squashX, squashY };
}

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

// --- 초기 표시 줌 (fit-to-ring) ---
// 최초 기동/초기화 직후 reveal 은 정확히 2링(gridDisk k=2) 19칸이다. 이 hex disk 가 화면에 여백을 두고
// 다 들어오도록 초기/기본 줌을 화면 크기(W/H)·격자 기하로 계산한다(매직넘버 회피, 기기 폭이 달라도 성립).
// 이후 핀치 줌은 자유(초기 줌만 조정). 2링 disk 의 bake-space extent(pointy-top, 셀=HEX_W×HEX_H):
//   가로 = 5칸(2·k+1)×HEX_W, 세로 = 4행(2·k)×rowStep + HEX_H.  (rowStep = HEX_H·0.75·ROW_SPACING ≈ 57)
// 화면 표시 크기 = extent×zoom 이므로 zoom = 화면가용/extent. 가로·세로 중 작은 값으로 맞춰 양방향 다 넣는다.
// 예) iPhone 17 Pro(W≈402): zoom ≈ 402×0.85/(5×64) ≈ 1.07 (가로가 제약, ZOOM_MAX 1.5 아래 -> 핀치 줌인 여유).
const RING_FIT_MARGIN = 0.85; // 화면의 85%만 쓰고 15% 여백(2링이 화면 가장자리에 붙지 않게)
function initialZoomForRing(W, H) {
  const rowStep = HEX_H * 0.75 * ROW_SPACING;
  const ringWpx = 5 * HEX_W; // 가로 extent(bake px) = (2·2+1)칸
  const ringHpx = 4 * rowStep + HEX_H; // 세로 extent(bake px) = (2·2)행 + 한 칸 높이
  const fit = Math.min(
    (W * RING_FIT_MARGIN) / ringWpx,
    (H * RING_FIT_MARGIN) / ringHpx,
  );
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fit)); // [ZOOM_MIN, ZOOM_MAX] 클램프
}

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

// --- 격자 2링 -> H3 키(reveal SSOT 를 격자 기하에 맞춤) ---
// 문제: reveal 을 H3 gridDisk 로 잡으면(App.js 기존), H3 육각이 화면 똑바른 격자와 ~14° 기울어 안 맞물려
// 화면 2링 격자 19칸 중 gridDisk-19 에 걸리는 게 ~13칸뿐 -> 화면에 13칸만 그려진다(사용자 지적).
// 해법: reveal 을 "화면 격자 disk 칸들의 cellKeyAt(H3)" 로 정의한다. 렌더는 각 격자 칸을 cellKeyAt 로 키를 얻어
// revealed.has(key) 로 판정하므로, revealed 가 곧 격자 칸들의 키면 그 격자 칸이 자기 키로 100% 매칭 -> 정확히 19칸.
// buildLattice 와 동일한 colStep/rowStep/홀수행 오프셋을 써 렌더 격자와 1:1 정합해야 한다(값이 어긋나면 매칭 깨짐).
// App.js(reveal SSOT)가 diskKeys(H3 gridDisk) 대신 이 헬퍼를 쓰도록 계약 변경 필요(export). 화면(W/H) 무관 —
// 중심 상대 오프셋(dx,dy)만 쓰고 screenToLatLng 의 W/2·H/2 가 상쇄되므로 순수 위경도 기하로 계산한다.
// odd-r pointy-top 큐브 거리로 정확히 (1+6+12)=19칸(rings=2)을 고른다.
function hexDistanceOddR(col, row) {
  // odd-r(홀수 행 오른쪽 밀림 = buildLattice 의 r&1?+colStep/2) -> 큐브 좌표 변환 후 맨해튼/2 = 육각 거리.
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  const y = -x - z;
  return (Math.abs(x) + Math.abs(y) + Math.abs(z)) / 2;
}
export function latticeDiskKeys(centerLat, centerLng, rings = 2) {
  const colStep = HEX_W;
  const rowStep = Math.round(HEX_H * 0.75 * ROW_SPACING); // buildLattice 와 동일해야 렌더 격자와 정합
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180);
  const seen = new Set();
  const keys = [];
  for (let r = -rings; r <= rings; r++) {
    for (let c = -rings - 1; c <= rings + 1; c++) {
      if (hexDistanceOddR(c, r) > rings) continue;
      // 중심 상대 오프셋(bake px) -> 위경도(screenToLatLng 의 dx=x-W/2, dy=y-H/2 와 동일, W/H 상쇄).
      const dx = c * colStep + (r & 1 ? colStep / 2 : 0);
      const dy = r * rowStep;
      const lat = centerLat + -dy / PX_PER_M / M_PER_DEG_LAT;
      const lng = centerLng + dx / PX_PER_M / mPerDegLng;
      const key = cellKeyAt(lat, lng);
      if (seen.has(key)) continue; // 두 격자 칸이 같은 H3 로 접히면 중복 제거(그래도 두 칸 다 그려짐)
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

// revealedCells prop 미전달 방어용 빈 Set(모듈 1개 공유 -> 매 렌더 새 Set 안 만듦).
const EMPTY_REVEAL = new Set();

// 낙하 중인 신규 reveal 칸 1개(= H3 키 하나에 대응하는 lattice 칸들의 미니 Picture)를 그린다.
// 목표 위치의 정적 bake 좌표 그대로 그린 picture 를 <Group translateY> 로 위(-dropHeight)에서 아래로 떨군다.
// dropHeight(bake px) = (H + DROP_MARGIN)/zoom -> 화면 위 밖에서 시작(대기 중에도 화면 안에 안 보임).
// clock(UI 스레드 SharedValue) 기반이라 React 리렌더 없이 매 프레임 평가된다(펫 hop 과 동일 결).
// startMs = 배치 시작 clock 값, delay = 칸키 해시 stagger. 월드 Group(카메라+줌/팬) 안에 놓여 정합은 자동.
function FallingCell({ picture, clock, startMs, delay, dropHeight }) {
  const transform = useDerivedValue(() => {
    const t = Math.min(
      1,
      Math.max(0, (clock.value - startMs - delay) / DROP_DURATION),
    );
    const e = easeDropSettle(t); // 0(시작, 위) -> 1(안착, 정위치)
    return [{ translateY: -dropHeight * (1 - e) }];
  }, [startMs, delay, dropHeight]);
  return (
    <Group transform={transform}>
      <Picture picture={picture} />
    </Group>
  );
}

// 케어 손맛 파티클 1개(④). 크리처 머리(anchor) 위에서 부채꼴로 흩어지며 떠올랐다 사라진다.
// clock 기반 UI 스레드(React 리렌더 없음). startMs = careEvent 를 받은 clock 값(SharedValue).
// index 로 각도·거리·지연을 결정(무작위 아님) -> Hooks 순서 불변(고정 개수). 월드 Group 안이라 줌/카메라 정합.
function CareParticle({ clock, startMs, index, count, path, color, anchorX, anchorY }) {
  // 위쪽(-90°) 중심 부채꼴로 퍼짐. 가장자리 입자일수록 옆으로.
  const angle = -Math.PI / 2 + (index / (count - 1) - 0.5) * (Math.PI * 0.75);
  const dist = 24 + (index % 3) * 7;
  const dx = Math.cos(angle) * dist;
  const delay = index * 55;
  const transform = useDerivedValue(() => {
    const t = Math.min(1, Math.max(0, (clock.value - startMs.value - delay) / JOY_MS));
    const rise = 16 + t * 22; // 떠오름(위로)
    const s = 0.55 + 0.45 * Math.sin(Math.min(1, t) * Math.PI); // 팝(커졌다 작아짐)
    return [
      { translateX: anchorX + dx * t },
      { translateY: anchorY - rise },
      { scale: s },
    ];
  }, [anchorX, anchorY]);
  const opacity = useDerivedValue(() => {
    const t = (clock.value - startMs.value - delay) / JOY_MS;
    if (t < 0 || t > 1) return 0;
    return Math.sin(t * Math.PI); // 페이드 인->아웃
  });
  if (!path) return null;
  return (
    <Group transform={transform}>
      <Path path={path} color={color} opacity={opacity} />
    </Group>
  );
}

// 머리 위 말풍선(③). 미터 요구(needMeter) 를 절차적 도형으로 표시 — satiety=주황 원, happiness=분홍 하트,
// cleanliness=청록 물방울. 흰 라운드 rect + 아래 꼬리 삼각 + 요구 심볼. 부드러운 부유(bob) + 등장 페이드인.
// startMs = 말풍선 등장 clock 값(SharedValue). 월드 Group 안이라 줌/카메라를 따라 크리처 머리에 붙는다.
function SpeechBubble({ clock, startMs, needMeter, heartPath, dropletPath, anchorX, anchorY }) {
  // 꼬리 삼각형(아래 중앙 -> 머리 쪽). 컴포넌트 로컬(0,0 = 말풍선 좌상단) 좌표.
  const tailPath = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    b.moveTo(BUBBLE_W / 2 - 5, BUBBLE_H - 1);
    b.lineTo(BUBBLE_W / 2 + 5, BUBBLE_H - 1);
    b.lineTo(BUBBLE_W / 2, BUBBLE_H + 8);
    b.close();
    return b.build();
  }, []);
  const transform = useDerivedValue(() => {
    const bob =
      Math.sin((clock.value / BUBBLE_BOB_PERIOD) * 2 * Math.PI) * BUBBLE_BOB_AMP;
    return [
      { translateX: anchorX - BUBBLE_W / 2 },
      { translateY: anchorY - BUBBLE_H + bob },
    ];
  }, [anchorX, anchorY]);
  const opacity = useDerivedValue(() => {
    const t = (clock.value - startMs.value) / BUBBLE_FADE_MS;
    return Math.min(1, Math.max(0, t)) * 0.97;
  });
  const color = NEED_COLORS[needMeter] || "#9ca3af";
  const icon = { translateX: BUBBLE_W / 2, translateY: BUBBLE_H / 2 };
  return (
    <Group transform={transform}>
      <RoundedRect
        x={0}
        y={0}
        width={BUBBLE_W}
        height={BUBBLE_H}
        r={BUBBLE_R}
        color="#ffffff"
        opacity={opacity}
      />
      <Path path={tailPath} color="#ffffff" opacity={opacity} />
      {needMeter === "satiety" && (
        <Circle cx={BUBBLE_W / 2} cy={BUBBLE_H / 2} r={8} color={color} opacity={opacity} />
      )}
      {needMeter === "happiness" && heartPath && (
        <Group transform={[icon]}>
          <Path path={heartPath} color={color} opacity={opacity} />
        </Group>
      )}
      {needMeter === "cleanliness" && dropletPath && (
        <Group transform={[icon, { scale: 0.85 }]}>
          <Path path={dropletPath} color={color} opacity={opacity} />
        </Group>
      )}
    </Group>
  );
}

export default function PixelHexMap({
  coords,
  occupied,
  currentKey,
  stage,
  facingRight,
  petType = 0,
  revealedCells,
  newlyRevealed,
  health,
  needMeter,
  careEvent,
}) {
  const { width: W, height: H } = useWindowDimensions();

  // 시무룩 연출 게이트: 활성 건강코드가 하나라도 있으면 크리처를 풀죽게 그린다(틴트+처짐).
  // 배고픔·심심·꼬질(미터<40) 신호는 크리처 처짐이 아니라 머리 위 말풍선(SpeechBubble, needMeter)에 일임한다
  // — game.js targetStacks 가 미터<40 을 즉시 sick 로 바꿔 처짐용 hungry 게이트가 정상 플레이에서 도달 불가였다.
  const sad = (health?.length ?? 0) > 0;

  // --- 핀치 줌 상태 ---
  // gesture-handler Pinch + React state 로 줌을 구동한다.
  // 주의: babel-preset-expo(SDK56)가 worklets 플러그인을 자동 적재해서, Gesture 체인에 직접 박은
  // 콜백은 기본적으로 UI 스레드 worklet 으로 표시된다. 그 안에서 React setter(setZoom)나 ref 변이를
  // 직접 호출하려면 .runOnJS(true) 로 콜백을 JS 스레드에서 돌려야 한다(없으면 첫 핀치에서 크래시).
  // zoom 은 project() 의존성이 아니라 베이크/투영을 다시 돌리지 않는다(아래 useMemo deps 에 zoom 없음).
  // 최초/기본 줌 = 2링(19칸) fit(initialZoomForRing). ZOOM_MAX 고정이 아니라 화면에 맞춰 계산 -> 핀치 줌인 여유.
  const initialZoom = initialZoomForRing(W, H);
  const [zoom, setZoom] = useState(initialZoom);
  const zoomRef = useRef(initialZoom); // 라이브 zoom(onEnd 에서 baseline 으로 커밋)
  const baseZoomRef = useRef(initialZoom); // 직전 제스처 종료 시점의 배율(다음 핀치의 기준)
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

  // --- reveal 낙하 배치 상태 ---
  // fallingBatches: 아직 낙하 중인 배치들 [{ id, keys: string[], startMs }]. newlyRevealed 스텝마다 하나 추가,
  // DROP 완료 후 제거되면 그 칸들이 정적 bake 로 흡수된다(재낙하 방지). batchIdRef = 배치 식별 카운터.
  const [fallingBatches, setFallingBatches] = useState([]);
  const batchIdRef = useRef(0);

  // --- 인트로 캐릭터 낙하 상태 ---
  // petDropStartMs: 캐릭터 낙하 시작 clock 값(그리드 전부 안착 후 트리거). 초기 큰 음수 = 낙하 안 함.
  // introPetPending: 인트로 그리드 낙하 "진행 중"에만 펫을 숨긴다(그리드 안착 뒤 낙하로 등장). 초기 false =
  //   기본은 펫 표시. 인트로 낙하가 실제 시작될 때만 true 로 올리고(아래 effect), 그리드 안착 시각 기반
  //   setTimeout 이 반드시 false 로 되돌린다(p17 cleanup 제거로 자기완결). 인트로가 안 뜨면 계속 false 라
  //   펫이 영구 차단되지 않는다(초기 true 였을 때 인트로 미발동 시 펫이 영영 안 그려지던 버그 수정).
  const petDropStartMs = useSharedValue(-1e9);
  const [introPetPending, setIntroPetPending] = useState(false);
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

  // "내 위치 찾기": 자유 둘러보기 -> 플레이어 추적 모드 복귀. 팬 리셋 + 줌 1.0 + 모드 전환.
  // 카메라를 플레이어로 되돌리는 withTiming 은 아래 follow effect 가 mode 변경을 받아 처리한다.
  // 줌은 요청대로 1.00 으로 스냅(상태·refs 를 함께 맞춰 다음 핀치 기준도 1.0).
  const recenter = () => {
    basePanRef.current = { x: 0, y: 0 };
    panX.value = 0;
    panY.value = 0;
    setZoom(1);
    zoomRef.current = 1;
    baseZoomRef.current = 1;
    setMode("player");
  };

  // 도트 타일 아틀라스(단일 useImage, 호출 순서 불변 -> Hooks 규칙 OK).
  // 로컬 require 라 거의 즉시 로드되지만, 로드 전엔 null -> 단색 헥스로 폴백한다.
  const atlas = useImage(ATLAS_SRC);

  // 펫 크리처 아틀라스(단일 useImage, 호출 순서 불변 -> Hooks 규칙 OK). 로드 전엔 null -> 펫 미표시.
  const petAtlas = useImage(PET_ATLAS_SRC);

  // 플레이어(트레이너) 아틀라스(단일 useImage, 호출 순서 불변 -> Hooks 규칙 OK). 로드 전엔 null -> 미표시.
  const playerAtlas = useImage(PLAYER_ATLAS_SRC);

  // 화면 고정 똑바른 육각 격자(좌표 무관 순수 기하). W/H 로만 메모(줌은 worldGroup 이 처리).
  const lattice = useMemo(() => buildLattice(W, H), [W, H]);

  // 보드 판 육각 격자 패턴을 단일 Picture 로 베이크한다(좌표 무관 순수 기하 -> lattice 로만 메모).
  // 게임 타일과 동일한 lattice(buildLattice) 위치·straightHexPath(TILE_DRAW_W/TILE_HEX_H) 를 써 1:1 정렬한다
  // -> 빈 판의 옅은 육각 윤곽과 드러난 타일 육각이 정확히 겹친다. 채우기 없이 stroke 만(옅은 우드 윤곽).
  // clip 기준은 lattice 와 동일(buildLattice 가 최대 줌아웃 커버 margin 을 이미 반영) -> 줌아웃 시 검은 void 없음.
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
    // 육각 윤곽 stroke paint(fill 아님). antiAlias off = 픽셀 톤, 두께 BOARD_LINE_PX(bake px, zoom 스케일).
    const line = Skia.Paint();
    line.setAntiAlias(false);
    line.setColor(Skia.Color(BOARD_LINE_COLOR));
    line.setStyle(PaintStyle.Stroke);
    line.setStrokeWidth(BOARD_LINE_PX);
    // 타일과 같은 격자 위치마다 육각 윤곽 하나(같은 straightHexPath 기하 -> 타일 드러나면 정확히 겹침).
    for (const cell of lattice) {
      canvas.drawPath(
        straightHexPath(cell.cx, cell.cy, TILE_DRAW_W, TILE_HEX_H),
        line,
      );
    }
    return recorder.finishRecordingAsPicture();
  }, [W, H, lattice]);

  // 낙하 중인 칸키 집합(정적 bake 에서 제외 -> 낙하 레이어가 대신 그림, 이중 그리기 방지).
  const fallingKeySet = useMemo(() => {
    const s = new Set();
    for (const b of fallingBatches) for (const k of b.keys) s.add(k);
    return s;
  }, [fallingBatches]);

  // 2)+3) reveal 된 칸을 하나의 똑바른 격자 Picture 로 "베이크"한다.
  // 각 격자 칸 중심(화면좌표) -> screenToLatLng -> cellKeyAt(H3) 로 역매핑해 reveal 멤버십/점령/테마를 정한다.
  // - 렌더 대상 = revealedCells.has(key)(계약 p15). 미개척은 생략(보드판만 보임 = fog of war).
  // - occupied 여부는 스타일만: 점령=또렷(타일 원본) / 미점령=옅음(어둠 wash). reveal 밖 occupied 는 안 그림.
  // - 낙하 중(fallingKeySet)인 칸은 정적에서 빼고 아래 fallingCells 애니 레이어가 그린다.
  // - 현재 셀(currentKey)에 매칭되는 칸 중 중앙에 가장 가까운 칸의 똑바른 육각 보더를 함께 만든다.
  // 뷰포트 컬링: revealedCells 전체가 아니라 lattice(=화면+최대줌아웃 margin 안의 칸)만 순회한다 ->
  //   현재 뷰포트 밖 reveal 칸은 자연히 제외(성능). bakeAnchor 이동(REBAKE_DIST)마다 근처 칸으로 갱신.
  // 재베이크는 bakeAnchor/revealedCells/occupied/currentKey/atlas/fallingKeySet 이 바뀔 때만.
  const latticePicture = useMemo(() => {
    if (!bakeAnchor)
      return { picture: null, currentPath: null, fallingCells: [] };
    const revealed = revealedCells || EMPTY_REVEAL;
    // 베이크 공간 클립 = buildLattice 와 동일 기준(최대 줌아웃 커버 = W/ZOOM_MIN, REBAKE_DIST 드리프트 여유).
    const marginX = (W * (1 / ZOOM_MIN - 1)) / 2 + REBAKE_DIST;
    const marginY = (H * (1 / ZOOM_MIN - 1)) / 2 + REBAKE_DIST;
    const bakeRect = Skia.XYWHRect(
      -marginX,
      -marginY,
      W + 2 * marginX,
      H + 2 * marginY,
    );

    const ccx = W / 2;
    const ccy = H / 2;
    let currentPath = null;
    let currentDist = Infinity;

    // 그릴 칸을 H3 키별로 모은다(한 H3 키 <-> 여러 lattice 칸 가능). 뷰포트 컬링 = lattice 순회 자체.
    const keyToCells = new Map();
    for (const cell of lattice) {
      const ll = screenToLatLng(cell.cx, cell.cy, bakeAnchor, W, H);
      const key = cellKeyAt(ll.latitude, ll.longitude);

      // 현재 셀 강조 보더(중앙에 가장 가까운 칸). reveal 여부와 무관하게 위치만 기억한다.
      if (key === currentKey) {
        const dx = cell.cx - ccx;
        const dy = cell.cy - ccy;
        const distSq = dx * dx + dy * dy;
        if (distSq < currentDist) {
          currentDist = distSq;
          currentPath = straightHexPath(cell.cx, cell.cy, TILE_DRAW_W, TILE_HEX_H);
        }
      }

      // reveal 멤버십: 드러난 칸만 모은다.
      if (!revealed.has(key)) continue;
      let arr = keyToCells.get(key);
      if (!arr) {
        arr = [];
        keyToCells.set(key, arr);
      }
      arr.push(cell);
    }

    // 한 칸(cx,cy)을 칠한다: 점령=또렷(타일 원본) / 미점령=옅음(어둠 wash). 정적·낙하 공용.
    const paintCell = (canvas, cx, cy, key, occ) => {
      const path = straightHexPath(cx, cy, TILE_DRAW_W, TILE_HEX_H);
      const frame = atlas ? frameForCell(key) : null;
      if (frame) {
        drawCellSprite(canvas, atlas, frame, cx, cy, 1);
      } else {
        const colors = THEME_COLORS[cellTheme(key)] || THEME_COLORS.풀숲;
        const fill = Skia.Paint();
        fill.setAntiAlias(false);
        fill.setColor(Skia.Color(occ ? colors.lit : colors.dim));
        canvas.drawPath(path, fill);
      }
      if (!occ) {
        const overlay = Skia.Paint();
        overlay.setAntiAlias(false);
        overlay.setColor(Skia.Color(UNCLAIMED_WASH));
        canvas.drawPath(path, overlay);
      }
    };

    // 정적 레이어: 낙하 중이 아닌 드러난 칸.
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(bakeRect);
    for (const [key, cells] of keyToCells) {
      if (fallingKeySet.has(key)) continue; // 낙하 중 -> 아래 애니 레이어가 그림
      const occ = !!occupied[key];
      for (const cell of cells) paintCell(canvas, cell.cx, cell.cy, key, occ);
    }
    const picture = recorder.finishRecordingAsPicture();

    // 낙하 레이어: 배치별 startMs + 칸키별 지연을 실어 개별 애니 Group 으로 그린다.
    // 목표(안착 위치)의 정적 좌표 그대로 미니 Picture 에 그리고, FallingCell 이 translateY 로 떨군다.
    // - 인트로 배치: 칸키 해시(hashKey)로 정렬한 rank × STEP -> 무작위 순서·거리순 아님·결정적(Math.random 회피)로 "뚝뚝 순차".
    // - 이동 reveal 배치: 기존대로 hashKey % span 로 흩뿌림(개별 낙하).
    const fallingCells = [];
    for (const batch of fallingBatches) {
      let introRank = null;
      if (batch.intro) {
        const sorted = [...batch.keys].sort((a, b) => hashKey(a) - hashKey(b));
        introRank = new Map();
        sorted.forEach((k, i) => introRank.set(k, i));
      }
      for (const key of batch.keys) {
        const cells = keyToCells.get(key);
        // 목표가 뷰포트(베이크 영역) 밖이면 컬링(안착 후 흡수 시 정적으로 나타남).
        if (!cells) continue;
        const occ = !!occupied[key];
        const rec = Skia.PictureRecorder();
        const c = rec.beginRecording(bakeRect);
        for (const cell of cells) paintCell(c, cell.cx, cell.cy, key, occ);
        const delay = batch.intro
          ? introRank.get(key) * INTRO_STAGGER_STEP
          : hashKey(key) % DROP_STAGGER_SPAN;
        fallingCells.push({
          batchId: batch.id, // 배치 id + 셀 키로 React key 유일화(여러 배치가 같은 셀 키를 담아도 충돌 없음)
          key,
          picture: rec.finishRecordingAsPicture(),
          startMs: batch.startMs,
          delay,
        });
      }
    }

    return { picture, currentPath, fallingCells };
  }, [
    lattice,
    bakeAnchor,
    revealedCells,
    occupied,
    currentKey,
    W,
    H,
    atlas,
    fallingKeySet,
    fallingBatches,
  ]);

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

  // --- 케어 손맛(④) + 말풍선(③) 절차적 심볼 ---
  // 원점 중심 SkPath 를 1회만 굽는다(Skia.Path.MakeFromSVGString, null 가드). 말풍선/파티클 공용.
  const heartPath = useMemo(() => Skia.Path.MakeFromSVGString(HEART_SVG), []);
  const dropletPath = useMemo(() => Skia.Path.MakeFromSVGString(DROPLET_SVG), []);
  const sparklePath = useMemo(() => Skia.Path.MakeFromSVGString(SPARKLE_SVG), []);

  // 케어 연출 시작 clock(SharedValue) + 파티클 종류(state). careEvent 가 오면 clock 을 찍어 파티클을 재생하고,
  // 하트군(feed/snack/pet/play)은 몸 통통 튐(hopStart 리셋)도 함께 준다. wash 계열은 반짝만(튐 없음).
  const careStartMs = useSharedValue(-1e9);
  const [careKind, setCareKind] = useState(null); // 'heart' | 'sparkle' | null(케어 전)
  useEffect(() => {
    if (!careEvent) return;
    careStartMs.value = clock.value;
    const heart = CARE_HEART_ACTIONS.has(careEvent.action);
    setCareKind(heart ? "heart" : "sparkle");
    if (heart) hopStart.value = clock.value; // 하트군만 즉각 점프/냠냠(통통 튐)
  }, [careEvent, clock, careStartMs, hopStart]);

  // 말풍선 등장 시각(SharedValue). needMeter 가 새로 생기면(또는 다른 미터로 바뀌면) 페이드인 기준시각 갱신.
  const bubbleStartMs = useSharedValue(-1e9);
  const prevNeedRef = useRef(null);
  useEffect(() => {
    if (needMeter && needMeter !== prevNeedRef.current) {
      bubbleStartMs.value = clock.value;
    }
    prevNeedRef.current = needMeter;
  }, [needMeter, clock, bubbleStartMs]);

  // --- reveal 낙하 배치 트리거 (+ 인트로 연출) ---
  // newlyRevealed(이번 스텝 신규 칸키)가 오면 낙하 배치를 하나 추가한다(시작 시각 = 현재 clock).
  // 배치 완료(지연+낙하) 후 배치를 제거 -> 그 칸들이 다음 재베이크에서 정적 bake 로 흡수(재낙하 방지).
  // 신규 없는 스텝은 newlyRevealed=[] -> 배치 안 만든다(낙하 재발동 방지). hopStart 와 동일하게 clock.value 를 JS 에서 읽는다.
  //
  // 인트로 판정: 이번 신규가 reveal 전체와 같으면(size===length) = 이전에 아무것도 없던 최초/리셋 직후.
  // reveal 은 미영속이라 앱 최초 기동·초기화(reset) 후 항상 이 조건이 걸려 인트로가 일관 재생된다.
  // 인트로 배치는 (a) 뚝뚝 순차 낙하(latticePicture 의 delay 계산), (b) 그리드 전부 안착 후 캐릭터 낙하.
  //
  // useLayoutEffect(useEffect 아님): 커밋 후 "페인트 전" 동기 실행이라, setFallingBatches 로 fallingKeySet 이
  // 프레임 페인트 전에 갱신돼 새 칸이 정적 bake 에서 즉시 제외된다. useEffect(페인트 후)면 reveal 커밋에서 정적
  // 안착 프레임이 1번 페인트된 뒤 배치가 생겨 "바닥에 순간 보였다 사라지고 낙하"하는 깜빡임이 났다(City Run 이동).
  // 제외 기준은 여전히 "살아있는 배치(fallingKeySet)" 뿐이라, 흡수 타이머로 배치가 빠지면 정적으로 다시 그려진다
  // -> newlyRevealed 가 정지 중 유지돼도 착지 후 칸이 사라지지 않는다(continuity 보존).
  useLayoutEffect(() => {
    if (!newlyRevealed || newlyRevealed.length === 0) return;
    const id = ++batchIdRef.current;
    const isIntro =
      !!revealedCells && revealedCells.size === newlyRevealed.length;
    const batch = { id, keys: newlyRevealed, startMs: clock.value, intro: isIntro };
    setFallingBatches((prev) => [...prev, batch]);

    const n = newlyRevealed.length;
    // 그리드 전부 안착 시각(ms). 인트로 = rank 순차(마지막 칸 지연 = (n-1)×STEP), 이동 = 해시 span.
    const gridSettleMs = isIntro
      ? (n - 1) * INTRO_STAGGER_STEP + DROP_DURATION
      : DROP_STAGGER_SPAN + DROP_DURATION;

    // 자기완결 타이머 — cleanup 으로 취소하지 않는다. 이 effect 는 newlyRevealed 로 매 fix 재실행되는데,
    // 다음 fix 에서 App 이 newly 를 [] 로 비우면(계약대로) 재실행 cleanup 이 아직 발화 전인 타이머를 취소해버려
    // 배치 흡수/캐릭터 등장이 영구 차단됐다(p17 회귀). 취소를 없애 각 타이머가 스스로 완료하게 한다.
    // (PixelHexMap 은 앱 루트 화면이라 언마운트=앱 종료 수준 -> 언마운트 누수 우려 없음.)
    setTimeout(() => {
      setFallingBatches((prev) => prev.filter((b) => b.id !== id));
    }, gridSettleMs + 80);

    if (isIntro) {
      // 최초/리셋 초기 표시: 2링(19칸)이 화면에 다 들어오게 줌을 fit 으로 되돌린다. reset 은 remount 가
      // 아니라(App 이 reveal 만 재시드) useState 초기값이 다시 안 걸리므로 여기서 재적용한다.
      // 이후 사용자가 핀치로 바꾸는 건 그대로(일반 이동 reveal 은 isIntro=false 라 줌 안 건드림).
      const fitZoom = initialZoomForRing(W, H);
      setZoom(fitZoom);
      zoomRef.current = fitZoom;
      baseZoomRef.current = fitZoom;
      setIntroPetPending(true); // 그리드 낙하 동안 캐릭터 숨김
      setTimeout(() => {
        // 그리드 안착 -> 캐릭터 낙하 시작(순서 보장). clock.value 를 JS 에서 읽어 낙하 기준시각으로.
        petDropStartMs.value = clock.value;
        setIntroPetPending(false);
      }, gridSettleMs);
    }
  }, [newlyRevealed, clock, revealedCells, petDropStartMs, W, H]);

  // --- 플레이어(트레이너) transform ---
  // 타일 중앙(petBase)에 발밑 앵커로 선다. 방향 변형이 없어 좌우는 수평 반전(facingRight)만.
  // 인트로 낙하·이동 hop·idle 숨쉬기는 크리처와 같은 bodyMotion 을 공유해 함께 움직인다.
  // 낙하(petDropStartMs)·hop(hopStart)·숨쉬기를 한 리듬으로 -> 트레이너·크리처가 나란히 걷는 느낌.
  const playerTransform = useDerivedValue(() => {
    const m = bodyMotion(
      clock.value,
      petDropStartMs.value,
      hopStart.value,
      petBase.y,
      zoom,
    );
    const baseScaleX = facingRight ? -1 : 1; // 기본 왼쪽 -> facingRight 면 가로 반전
    return [
      { translateX: petBase.x },
      { translateY: petBase.y + m.offsetY },
      { scaleX: baseScaleX * m.squashX },
      { scaleY: m.squashY },
    ];
  }, [petBase, facingRight, zoom]);

  // --- 크리처(펫) transform (알=안김 / 부화 후=옆자리 뒤따름) ---
  // useDerivedValue 본문은 babel worklets 로 UI 스레드에서 매 프레임 평가된다(React 리렌더 없음).
  // 위치/반전(petBase/facingRight/stage/zoom)은 JS 값이라 클로저 캡처 + deps 로 갱신한다.
  // 크리처는 월드 Group(카메라+줌/팬) 안에 그려져 그리드와 동일 변환을 거친다 -> 위치 정합은 Group 이
  // 담당하고, 여기선 베이크 좌표 + 배치 오프셋(옆자리/안김) + hop/숨쉬기/좌우반전만.
  const creatureTransform = useDerivedValue(() => {
    const isEgg = stage === "알";
    const m = bodyMotion(
      clock.value,
      petDropStartMs.value,
      hopStart.value,
      petBase.y,
      zoom,
    );
    if (isEgg) {
      // 알: 플레이어가 안은 형태. 옆구리/몸통 높이에 겹치는 고정 오프셋. 방향 없어 반전 안 함,
      // 독립 hop/squash 없음 — 플레이어 수직 병진(offsetY)만 공유해 붙어 함께 움직인다.
      const heldDx = facingRight ? HELD_DX : -HELD_DX; // 정면 쪽으로 살짝
      // 플레이어는 발 고정 squashY 로 숨쉬기/hop 스케일이 걸린다 -> 가슴 높이(HELD_ATTACH_H) 지점은
      // squashY 에 비례해 오르내린다. 안긴 알도 그 지점에 붙어 함께 상하 이동(정지 위화감 제거).
      const heldBob = HELD_ATTACH_H * (m.squashY - 1); // squashY>1(들숨) = 가슴 위로 -> 알도 위로
      return [
        { translateX: petBase.x + heldDx },
        { translateY: petBase.y + m.offsetY - HELD_UP - heldBob },
        { scale: HELD_SCALE }, // 발밑 원점 기준 축소(안았을 때만 작게) -> 위 translate 로 옆구리에 앉힘
      ];
    }
    // 부화 후: 플레이어 옆에 나란히, 이동 방향 기준 뒤따르는 쪽. hop/숨쉬기/좌우반전 유지.
    // facingRight=true(동쪽 이동) -> 왼쪽(서, -x) / false(서쪽) -> 오른쪽(동, +x). 둘 다 같은 방향 봄.
    const baseScaleX = facingRight ? -1 : 1;
    const lateralDx = facingRight ? -CREATURE_SIDE_DX : CREATURE_SIDE_DX;
    const droop = sad ? SAD_DROOP_DY : 0; // sick 처짐(부화 크리처만). 틴트도 sick 만(petPicture).
    return [
      { translateX: petBase.x + lateralDx },
      { translateY: petBase.y + m.offsetY + CREATURE_FRONT_DY + droop }, // +DY = 화면 아래(앞)로 살짝
      { scaleX: baseScaleX * m.squashX },
      { scaleY: m.squashY },
    ];
  }, [petBase, facingRight, stage, zoom, sad]);

  // 펫 크리처 스프라이트를 로컬 원점(바닥-중앙 = 0,0)에 베이크한다. stage 가 바뀌면 다른 단계
  // 프레임으로 재베이크 -> 진화가 화면에 보인다. drawImageRectOptions 로 nearest 강제(픽셀 선명).
  // 위치/좌우 반전은 렌더 시 Group transform 으로 입혀 deps 를 작게(petAtlas, stage) 유지한다.
  const petPicture = useMemo(() => {
    if (!petAtlas) return null;
    const row = petType ?? 0; // 계약: petType prop(0~3) = 아틀라스 row. 미전달/undefined 시 0(불).
    const col = PET_STAGE_COL[stage] ?? PET_STAGE_COL.알;
    const frame = PET_FRAMES_BY_NAME[`sprite_${row}_${col}`];
    if (!frame) return null;
    // 스케일 = 같은 row 의 성년기(col5) 높이 기준(row 마다 원본 높이가 다를 수 있어 row 별 계산).
    const maxFrame = PET_FRAMES_BY_NAME[`sprite_${row}_5`] || frame;
    const petScale = PET_TARGET_MAX_H / maxFrame.h;
    const dstW = Math.round(frame.w * petScale);
    const dstH = Math.round(frame.h * petScale);
    // 바닥-중앙을 원점(0,0)에: 좌 = -dstW/2, 위 = -dstH -> 발이 원점, 위로 솟아 칸에 "선" 느낌.
    const left = -Math.round(dstW / 2);
    const top = -dstH;
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(left, top, dstW, dstH));
    const src = Skia.XYWHRect(frame.x, frame.y, frame.w, frame.h);
    const dst = Skia.XYWHRect(left, top, dstW, dstH);
    const paint = Skia.Paint();
    paint.setAntiAlias(false);
    // 시무룩: 색필터(Modulate=픽셀×틴트)로 톤을 눌러 채도↓·약간 어둡게. 스프라이트 알파 보존.
    if (sad) {
      paint.setColorFilter(
        Skia.ColorFilter.MakeBlend(Skia.Color(SAD_TINT_COLOR), BlendMode.Modulate),
      );
    }
    canvas.drawImageRectOptions(
      petAtlas,
      src,
      dst,
      FilterMode.Nearest,
      MipmapMode.Nearest,
      paint,
    );
    return recorder.finishRecordingAsPicture();
  }, [petAtlas, stage, petType, sad]);

  // 플레이어(트레이너) 스프라이트를 로컬 원점(바닥-중앙 = 0,0)에 베이크한다. 단일 프레임이라 stage 무관 —
  // atlas 로드 시 한 번만 계산. 펫과 동일 파이프라인(발밑 앵커, nearest 강제). 높이 = PLAYER_TARGET_H.
  const playerPicture = useMemo(() => {
    if (!playerAtlas) return null;
    const frame = PLAYER_FRAME;
    const playerScale = PLAYER_TARGET_H / frame.h; // 원본 높이 -> 목표 높이 비례 축소
    const dstW = Math.round(frame.w * playerScale);
    const dstH = Math.round(frame.h * playerScale);
    // 바닥-중앙을 원점(0,0)에: 좌 = -dstW/2, 위 = -dstH -> 발이 원점(타일 중심에 닿음).
    const left = -Math.round(dstW / 2);
    const top = -dstH;
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(left, top, dstW, dstH));
    const src = Skia.XYWHRect(frame.x, frame.y, frame.w, frame.h);
    const dst = Skia.XYWHRect(left, top, dstW, dstH);
    const paint = Skia.Paint();
    paint.setAntiAlias(false);
    canvas.drawImageRectOptions(
      playerAtlas,
      src,
      dst,
      FilterMode.Nearest,
      MipmapMode.Nearest,
      paint,
    );
    return recorder.finishRecordingAsPicture();
  }, [playerAtlas]);

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

  // 낙하 시작 높이(bake px): 화면(H)을 zoom 으로 나눠 어떤 뷰포트 칸이든 화면 위 밖에서 출발하게 한다.
  // FallingCell 안에서 bake translateY × zoom = 화면 lift = H+DROP_MARGIN 이 되어 zoom 무관하게 화면 밖 보장.
  const dropHeightBake = (H + DROP_MARGIN) / zoom;

  // 크리처 머리 위 앵커(bake px): 말풍선(③)/케어 파티클(④)의 배치 기준. 부화 크리처 옆자리 오프셋을 반영해
  // 크리처 머리 바로 위에 뜬다. 월드 Group 안에 그려 줌/카메라를 따라 크리처에 붙는다.
  const creatureLateralDx = facingRight ? -CREATURE_SIDE_DX : CREATURE_SIDE_DX;
  const headAnchorX = petBase.x + creatureLateralDx;
  const headAnchorY = petBase.y - HEAD_UP;
  // 말풍선은 미터 요구가 있고 알 단계(안김)가 아닐 때만(계약: 부화 후만).
  const showBubble = !!needMeter && stage !== "알";

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

            {/* 2)+3) reveal 된 칸(낙하 완료분): 똑바른 육각 격자를 H3 에 역매핑해 베이크한 단일 정적 Picture. */}
            {latticePicture.picture && (
              <Picture picture={latticePicture.picture} />
            )}

            {/* 3b) 낙하 등장: 이번 스텝 신규 reveal 칸만 하늘에서 떨어져 안착(clock 기반 UI 스레드, 안착 후 정적 흡수). */}
            {latticePicture.fallingCells.map((fc) => (
              <FallingCell
                key={`${fc.batchId}:${fc.key}`}
                picture={fc.picture}
                clock={clock}
                startMs={fc.startMs}
                delay={fc.delay}
                dropHeight={dropHeightBake}
              />
            ))}

            {/* 5) 현재 셀 하일라이트 — 선 없이 은은한 글로우만(BlurMask 로 번짐, 매 프레임 UI 스레드 맥동).
                introPetPending=true(인트로 그리드 낙하 중)면 글로우 억제 -> 그리드 안착 후 펫과 함께 등장.
                (인트로 중 현재 칸이 아직 하늘에서 낙하 중인데 글로우만 정위치에 먼저 번쩍이던 버그 수정.
                 비인트로 이동은 introPetPending 이 항상 false 라 기존대로 즉시 표시 — 회귀 없음.) */}
            {latticePicture.currentPath && !introPetPending && (
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

            {/* 6) 플레이어(트레이너) + 크리처(펫): 월드 Group 안 = 그리드와 동일 변환(카메라+줌/팬)을 거쳐
              항상 격자와 정합. 위치는 베이크 좌표(petBase), 배치/hop/숨쉬기/좌우반전은 로컬, 크기는 Group
              scale(zoom)이 처리. picture=null(로드 전)이면 안 그림. introPetPending=true(인트로 그리드 낙하
              중)면 플레이어+크리처를 함께 숨김 -> 그리드 안착 뒤 bodyMotion 낙하로 함께 등장(단일 게이트).
              z-order: 크리처(알=안김 / 부화 후=옆 겹침)를 항상 플레이어 앞(나중에 그림)에 둬 살짝 앞에 선 느낌. */}
            {playerPicture && bakeAnchor && !introPetPending && (
              <Group transform={playerTransform}>
                <Picture picture={playerPicture} />
              </Group>
            )}
            {petPicture && bakeAnchor && !introPetPending && (
              <Group transform={creatureTransform}>
                <Picture picture={petPicture} />
              </Group>
            )}

            {/* ③ 머리 위 말풍선(미터 요구): 배고픔·심심·꼬질을 절차적 심볼로. 상단바 건강배지(병)와 다른 신호.
                needMeter 있고 알 단계 아닐 때만. 값이 회복돼 needMeter 가 null 이 되면 사라진다. */}
            {showBubble && bakeAnchor && !introPetPending && (
              <SpeechBubble
                clock={clock}
                startMs={bubbleStartMs}
                needMeter={needMeter}
                heartPath={heartPath}
                dropletPath={dropletPath}
                anchorX={headAnchorX}
                anchorY={headAnchorY}
              />
            )}

            {/* ④ 케어 손맛 파티클: careEvent 후 JOY_MS 동안 하트(feed/snack/pet/play)/반짝(wash/clean/poop) 팝.
                clock 기반이라 창 밖에선 opacity 0(항상 마운트, 재생 시에만 보임). 하트군은 몸 통통 튐도 함께. */}
            {careKind &&
              bakeAnchor &&
              !introPetPending &&
              Array.from({ length: CARE_PARTICLE_COUNT }).map((_, i) => (
                <CareParticle
                  key={i}
                  clock={clock}
                  startMs={careStartMs}
                  index={i}
                  count={CARE_PARTICLE_COUNT}
                  path={careKind === "heart" ? heartPath : sparklePath}
                  color={
                    careKind === "heart"
                      ? HEART_PARTICLE_COLOR
                      : SPARKLE_PARTICLE_COLOR
                  }
                  anchorX={headAnchorX}
                  anchorY={headAnchorY}
                />
              ))}
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

      {/* 디버그 오버레이(개발용): 줌 수치 조정 편의. zoom/헥스 칸폭/모드.
          pointerEvents none 으로 제스처를 통과시킨다. SHOW_DEBUG_OVERLAY 로 on/off. */}
      {SHOW_DEBUG_OVERLAY && (
        <View style={styles.debug} pointerEvents="none">
          <Text style={styles.debugText}>
            zoom {zoom.toFixed(3)} · cell {Math.round(HEX_W * zoom)}px
          </Text>
          <Text style={styles.debugText}>
            board · {mode}
          </Text>
        </View>
      )}
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
