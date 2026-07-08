import {
  Canvas,
  Fill,
  Group,
  Path,
  Picture,
  Skia,
  useClock,
  useImage,
} from "@shopify/react-native-skia";
import { useEffect, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useDerivedValue, useSharedValue } from "react-native-reanimated";

import {
  PET_ATLAS_SRC,
  PET_TARGET_MAX_H,
  bakePetPicture,
} from "./PixelHexMap";
import { CARE_ACTIONS } from "./game";

// 케어 방(돌봄 방) — 케어 화면 상단 패널에 뜨는 작은 Skia Canvas.
// 절차적 최소 단위로 2.5D "정육면체 내부"(바닥 + 뒷벽 + 좌/우 측벽, 에셋 0)를 그리고,
// 그 바닥 평면 위를 크리처가 walk/pause 리듬으로 걷다 멈추며 생활한다(자연스러운 생물감).
// 크리처 렌더는 PixelHexMap 의 bakePetPicture 파이프라인(아틀라스/nearest/틴트)을 그대로 재사용한다(중복 최소화).
// 웹은 CareRoom.web.js = null (Skia 미탑재). 시트 열림 동안만 마운트되어 clock 도 그때만 돈다.

const ROOM_H = 150; // 방 캔버스 높이(px). 가로는 패널 안쪽 폭(화면폭 - 좌우 패딩)에 맞춘다.
const SHEET_H_PAD = 32; // App.js 상단 패널 paddingHorizontal(16)×2 — 캔버스 로컬 좌표=패널 안쪽 폭과 일치.

// 방 벽/바닥 팔레트(따뜻한 우드 톤). "바닥 밝게·벽 어둡게"로 조명감 -> 정육면체 내부 입체.
const FLOOR_COLOR = "#e6d5ac"; // 바닥(가장 밝음, 위에서 빛 받는 면)
const WALL_BACK_COLOR = "#c3b083"; // 뒷벽(중간)
const WALL_LEFT_COLOR = "#a89469"; // 좌측벽(그늘 — 가장 어둠)
const WALL_RIGHT_COLOR = "#b3a074"; // 우측벽(살짝 밝음 — 방향성 조명)
const AMBIENT_COLOR = "#cbb98d"; // 캔버스 바탕(대부분 벽/바닥에 덮임)
const EDGE_COLOR = "rgba(90, 70, 40, 0.35)"; // 면 경계선(정육면체 윤곽 가독)

// --- walk/pause 산책 리듬 ---
// 끊임없이 움직이면 생물 같지 않다. 한 주기를 "이동(walk) 구간 + 정지(pause·두리번) 구간"으로 나눠
// 걷다가 목표점에 닿으면 잠시 멈춰 숨쉬고 두리번거리다 다시 걷는다. Math.random 없이 주기번호 해시로
// 결정적으로 구현한다(같은 시각이면 같은 동작 — worklet 정합). 매 주기가 똑같은 박자로 반복되면 패턴이
// 뻔하므로 주기마다 이동 시간·정지 시간·목표 거리를 해시로 다르게 변주한다(단조로움 제거).
const WALK_MIN = 1100; // ms, 이동 구간 최소(종종걸음).
const WALK_MAX = 2600; // ms, 이동 구간 최대(긴 산책).
const PAUSE_MIN = 900; // ms, 정지 구간 최소(짧은 멈춤).
const PAUSE_MAX = 3200; // ms, 정지 구간 최대(긴 휴식).
const STEP_MIN_R = 0.25; // 목표점 최소 반경 — 가까운 이동(짧은 걸음)도 나오게 거리 변주(속도감 변화).
const DEPTH_SCALE = 0.5; // 깊이(v=앞뒤) 진폭 축소 계수 — 위아래로 과하게 안 튀게(요청 B-2).
const U_RANGE = 0.85; // 좌우(u) 이동폭 계수(벽 안쪽으로 여유).
// 걸음 hop(통통 튐) + 숨쉬기. hop 은 걷는 동안만, 정지 중엔 숨쉬기 + idle.
const HOP_PERIOD = 720; // ms, hop 1회(느긋한 걸음).
const HOP_HEIGHT = 7; // px(baked), 튐 높이(원근 scale 곱해짐)
const HOP_SQUASH = 0.1; // 튐/착지 순간 납작·홀쭉 강도
const BREATHE_PERIOD = 2600; // ms, 정지/알 숨쉬기 1주기
const BREATHE_AMP = 0.02;
const IDLE_HOP = 3; // px(baked), 정지 중 제자리 폴짝 높이(작게).
const IDLE_SWAY = 3; // px(baked), 정지 중 좌우 흔들(두리번) 폭(작게).

// 결정적 해시(GLSL식 fract(sin·큰수)) — 주기번호를 seed 로 [0,1) 난수화. worklet.
function fract(x) {
  "worklet";
  return x - Math.floor(x);
}
function hn(n, seed) {
  "worklet";
  return fract(Math.sin(n * seed) * 43758.5453);
}
// 주기 n 의 이동 시간·정지 시간·목표점(중심 대비 (u,v)). 순수 함수(=경계에서 양쪽 주기가 동일 값 -> 위치 연속).
function walkDur(n) {
  "worklet";
  return WALK_MIN + hn(n, 12.9898) * (WALK_MAX - WALK_MIN);
}
function pauseDur(n) {
  "worklet";
  return PAUSE_MIN + hn(n, 78.233) * (PAUSE_MAX - PAUSE_MIN);
}
function targetU(n) {
  "worklet";
  const r = STEP_MIN_R + hn(n, 269.5) * (1 - STEP_MIN_R); // 목표 반경 변주 -> 걸음 거리 변주
  return (hn(n, 127.1) * 2 - 1) * r;
}
function targetV(n) {
  "worklet";
  const r = STEP_MIN_R + hn(n, 269.5) * (1 - STEP_MIN_R);
  return (hn(n, 311.7) * 2 - 1) * r;
}

// --- 케어 반응(방 안 손맛) ---
// App 이 케어 성공 시 찍는 careEvent({action,at}) 를 받아 방 크리처가 반응한다: 산책을 잠깐 프리즈하고
// 액션군별 모션(냠냠 squash / 점프 hop / 반짝 바운스)을 재생한 뒤 다시 산책으로 이어붙인다. 반응↔산책 이음새는
// worklet(clock) 한 시계 안에서 원자적으로 처리한다: 산책 유효시간 wt = t - wanderOffset - extra 로,
// extra 가 반응 중 자라다 REACT_MS 에서 포화 -> 반응 종료 프레임에 wt 가 프리즈 지점과 정확히 연속(setTimeout 경합 없음).
const REACT_MS = 1500; // ms, 케어 반응(프리즈+모션) 지속. 파티클 버스트가 반응 초반에 톡 터지도록.

// --- 케어 버스트 파티클(방 전용, 미터별 방향·형태 분화) ---
// 심볼 1개 팝 대신 작은 입자 다수가 크리처 머리 위에서 톡 터진다. 앵커(anchorX/anchorY)는 크리처 pose 에서
// 매 프레임 파생 -> 반응 중 점프/냠냠 모션을 따라 입자 "원점"이 크리처를 따라간다(붙는다). 단, 입자의 확산
// 방향·크기는 화면 기준 상수라 크리처가 뒤집히거나(scaleX 음수) 원근으로 작아져도 영향받지 않는다(독립).
// 액션의 주 미터(satiety/happiness/cleanliness)로 방향성·형태·색을 3분화한다. 결정적(index·clock 해시,
// Math.random 없음 -> worklet 정합). 메인 헥스맵의 CareParticle 은 건드리지 않는다(방만 이 버스트).
const BURST_COUNT = 14; // 입자 수(고정 -> Hooks 순서 불변).
const ANCHOR_HEAD_FRAC = 0.6; // 앵커 높이 = 발y - 스프라이트최대높이×이 값. 만배율 머리 위치(화면 고정, scale 비상속).

// 미터 -> 모션 타입 정수(worklet 분기 키). 크리처 리액션 모드와도 1:1(냠냠/점프/반짝).
const MOTION = { satiety: 0, happiness: 1, cleanliness: 2 };

// happiness — 하트: 중력 없이 위로 둥실 + 좌우 살랑(부력).
const HAP_LIFE = 1300; // ms, 느긋하게 오래 떠오름.
const HAP_RISE = 44; // px, 수명 동안 위로 떠오르는 높이.
const HAP_SWAY = 7; // px, 좌우 살랑 진폭(부력).
const HAP_OUT = 9; // px, 초기 좌우 퍼짐(작게).
// cleanliness — 반짝: 위·사방으로 팍 튀어 분수처럼 빠르게 확산 후 페이드.
const CLN_LIFE = 720; // ms, 짧고 빠르게.
const CLN_SPEED = 46; // px, 확산 반경(빠르게 멀리).
const CLN_GRAV = 18; // px, 약한 낙하(분수 아치 — 비처럼 쏟아지지 않게 작게).
// satiety — 음식 알갱이: 팝 아웃 후 크리처로 다시 모임(먹는 뉘앙스) + 통통 튐.
const SAT_LIFE = 950; // ms.
const SAT_OUT = 24; // px, 팝 반경(나갔다 크리처로 되돌아옴).
const SAT_BOB = 9; // px, 통통 튐 높이.

// 도트 게임 톤 입자 심볼(원점 중심 소형). 미터별로 형태를 달리한다.
const BURST_HEART_SVG =
  "M0 2.5 C-1.2 0.8 -3 -0.2 -3 -1.6 C-3 -2.6 -2.1 -3 -1.2 -2.6 C-0.6 -2.4 -0.1 -1.9 0 -1.4 C0.1 -1.9 0.6 -2.4 1.2 -2.6 C2.1 -3 3 -2.6 3 -1.6 C3 -0.2 1.2 0.8 0 2.5 Z"; // 작은 하트(happiness).
const BURST_SPARK_SVG = "M0 -3 L1 -1 L3 0 L1 1 L0 3 L-1 1 L-3 0 L-1 -1 Z"; // 작은 반짝(cleanliness).
const BURST_GRAIN_SVG =
  "M-2 -0.8 L-0.8 -1.5 L0.8 -1.5 L2 -0.8 L2 0.8 L0.8 1.5 L-0.8 1.5 L-2 0.8 Z"; // 음식 알갱이(satiety).
const BURST_DOT_SVG = "M-1.5 -1.5 L1.5 -1.5 L1.5 1.5 L-1.5 1.5 Z"; // 작은 낟알 점(satiety 텍스처 변주).

// 미터별 팔레트. index%3 으로 셋 중 선택해 톤 깊이.
const HAPPY_PALETTE = ["#ff5c8a", "#ff8fb3", "#ffc2d6"]; // 분홍(하트).
const CLEAN_PALETTE = ["#8ff0e2", "#c9f7f0", "#ffffff"]; // 청록·흰(반짝).
const FOOD_PALETTE = ["#ffd34d", "#ffa94d", "#ffe08a"]; // 노랑·주황(음식).

// 액션의 주 미터 판정. game.js CARE_ACTIONS[action].meters 중 회복 델타가 가장 큰 키를 고른다(하드코딩 대신
// 소비 -> 밸런스에서 미터 델타가 바뀌면 파티클 분류도 자동 추종). 결정적(키 순회, Math.random 없음).
function primaryMeter(action) {
  const meters = CARE_ACTIONS[action] && CARE_ACTIONS[action].meters;
  if (!meters) return "happiness";
  let best = "happiness";
  let bestV = -Infinity;
  for (const k in meters) {
    if (meters[k] > bestV) {
      bestV = meters[k];
      best = k;
    }
  }
  return best;
}

// 버스트 입자 1개. clock 기반 UI 스레드(React 리렌더 없음). startMs=careEvent clock 값(SharedValue).
// motion(정수)로 미터별 시간전개 공식을 고른다. 확산 방향·크기·중력은 화면 상수(크리처 scale/facing 비상속).
// anchorX/anchorY(크리처 pose 파생)만 매 프레임 크리처를 따라간다 -> 원점은 붙되 확산은 독립.
function CareBurstParticle({ clock, startMs, index, count, motion, anchorX, anchorY, path, color }) {
  // 결정적 파라미터(index 해시, 화면 기준 상수). worklet 은 이 값들과 anchor 만 읽는다.
  const j = (hn(index + 1, 34.7) - 0.5) * 0.8; // 각도 지터.
  const hx = ((index + 0.5) / count - 0.5) * 2; // happiness 좌우 시드 [-1,1].
  const cAng = -Math.PI / 2 + ((index + 0.5) / count - 0.5) * Math.PI * 1.05 + j * 0.5; // cleanliness 위쪽 반구 부채꼴.
  const cux = Math.cos(cAng);
  const cuy = Math.sin(cAng);
  const sAng = ((index + 0.5) / count) * Math.PI * 2 + j; // satiety 전방위.
  const sux = Math.cos(sAng);
  const suy = Math.sin(sAng);
  const phase = hn(index + 1, 91.3) * Math.PI * 2; // 살랑 위상.
  const scale0 = 0.75 + hn(index + 1, 45.164) * 0.5; // 입자 기본 크기(화면 상수).
  const delay = (index % 4) * 20; // 입자 시차(동시 아닌 연쇄 터짐).

  const transform = useDerivedValue(() => {
    const lifeMs =
      motion === MOTION.happiness ? HAP_LIFE : motion === MOTION.cleanliness ? CLN_LIFE : SAT_LIFE;
    const life = (clock.value - startMs.value - delay) / lifeMs;
    if (life < 0 || life > 1) return [{ translateX: -9999 }, { translateY: -9999 }, { scale: 0 }];
    const ax = anchorX.value;
    const ay = anchorY.value;
    let px, py, s;
    if (motion === MOTION.happiness) {
      // 부력: 감속하며 위로 떠오르고 좌우로 살랑. 중력 없음.
      const rise = -HAP_RISE * (1 - (1 - life) * (1 - life));
      const sway = HAP_SWAY * Math.sin(life * Math.PI * 3 + phase);
      px = ax + hx * HAP_OUT + sway;
      py = ay + rise;
      s = scale0 * (1 - life * 0.2);
    } else if (motion === MOTION.cleanliness) {
      // 분수: easeOut 로 위·사방 빠르게 확산, 약한 낙하 아치(비처럼 쏟아지지 않음).
      const spread = 1 - (1 - life) * (1 - life);
      const gy = CLN_GRAV * life * life;
      px = ax + cux * CLN_SPEED * spread;
      py = ay + cuy * CLN_SPEED * spread + gy;
      s = scale0 * (1 - life * 0.5);
    } else {
      // 음식: sin(πt) 로 팝 아웃 후 크리처로 되모임 + 통통 튐. 아래로 쏟아지지 않음.
      const out = Math.sin(life * Math.PI);
      const bob = -SAT_BOB * Math.abs(Math.sin(life * Math.PI * 3)) * (1 - life);
      px = ax + sux * SAT_OUT * out;
      py = ay + suy * SAT_OUT * out + bob;
      s = scale0 * (1 - life * 0.3);
    }
    return [{ translateX: px }, { translateY: py }, { scale: s }];
  }, [motion]);
  const opacity = useDerivedValue(() => {
    const lifeMs =
      motion === MOTION.happiness ? HAP_LIFE : motion === MOTION.cleanliness ? CLN_LIFE : SAT_LIFE;
    const life = (clock.value - startMs.value - delay) / lifeMs;
    if (life < 0 || life > 1) return 0;
    return Math.min(1, life * 6) * (1 - life); // 빠른 페이드인 -> 서서히 페이드아웃.
  }, [motion]);
  if (!path) return null;
  return (
    <Group transform={transform}>
      <Path path={path} color={color} opacity={opacity} />
    </Group>
  );
}

// 방 바닥 평면 + 벽 기하를 캔버스 폭(RW)으로 계산한다. 바닥은 원근 사다리꼴(뒤 좁고 앞 넓음),
// 크리처 발 좌표 매핑 값(중심/깊이별 y·반폭·scale)도 같이 낸다.
function roomGeometry(RW) {
  const backY = ROOM_H * 0.46; // 바닥 뒷변(= 뒷벽 아랫변) y
  const blx = RW * 0.16; // 뒷벽/바닥 뒷변 좌 x
  const brx = RW * 0.84; // 뒷벽/바닥 뒷변 우 x
  const cx = RW / 2;
  return {
    RW,
    backY,
    blx,
    brx,
    cx,
    // 크리처 발 배치용: 깊이 t(0=뒤,1=앞)로 보간할 양끝값.
    footBackY: backY + 8, // 뒤쪽 설 때 발 y(뒷벽 살짝 앞)
    footFrontY: ROOM_H - 12, // 앞쪽 설 때 발 y(바닥 앞변 근처)
    halfBack: ((brx - blx) / 2) * 0.82, // 뒤쪽 좌우 이동 반폭(바닥 뒷변 안쪽)
    halfFront: (RW / 2) * 0.72, // 앞쪽 좌우 이동 반폭(바닥 앞변 안쪽)
    scaleBack: 0.78, // 뒤쪽 크리처 배율(멀어 작게)
    scaleFront: 1.0, // 앞쪽 크리처 배율(가까워 크게)
  };
}

// 산책 위치(hop/squash 제외한 순수 배치)를 시각 t 에서 계산한다. worklet 이자 JS 에서도 호출한다
// (케어 반응 프리즈 포즈를 JS 파티클 앵커로 캡처). 주기 길이가 가변이라 누적합으로 t 가 속한 주기를 찾는다
// (t 는 마운트 이후 경과 ms 라 작음 -> 루프 유한·값쌈). 목표점 P(k)=순수 함수(k)라 주기 경계에서
// 양쪽이 동일 값 -> 위치·원근이 연속(점프 없음). 반환에 pauseMode/pausePhase(idle 용)도 싣는다.
// 반환: { x, footY, scale, faceX, walking, w, pauseMode, pausePhase }.
function wanderPlacement(t, geo) {
  "worklet";
  // t 가 속한 주기 n 과 그 안의 로컬 경과(localT)를 가변 주기 누적합으로 찾는다.
  let n = 0;
  let acc = 0;
  while (n < 100000) {
    const d = walkDur(n) + pauseDur(n);
    if (acc + d > t) break;
    acc += d;
    n++;
  }
  const wDur = walkDur(n);
  const pDur = pauseDur(n);
  const localT = t - acc;
  const walking = localT < wDur;
  // 결정적 목표점 P(n)->P(n+1). 반경 변주로 걸음 거리도 매번 다르게.
  const u0 = targetU(n);
  const v0 = targetV(n);
  const u1 = targetU(n + 1);
  const v1 = targetV(n + 1);
  const w = walking ? (wDur > 0 ? localT / wDur : 1) : 1;
  const ease = w * w * (3 - 2 * w);
  const u = u0 + (u1 - u0) * ease;
  const v = v0 + (v1 - v0) * ease;
  const depth = (v * DEPTH_SCALE + 1) / 2; // 0=뒤,1=앞
  const footY = geo.footBackY + (geo.footFrontY - geo.footBackY) * depth;
  const half = geo.halfBack + (geo.halfFront - geo.halfBack) * depth;
  const scale = geo.scaleBack + (geo.scaleFront - geo.scaleBack) * depth;
  const x = geo.cx + u * half * U_RANGE;
  const movingRight = u1 - u0 >= 0;
  let faceX;
  let pauseMode = 0;
  let pausePhase = 0;
  if (walking) {
    faceX = movingRight ? -1 : 1;
  } else {
    pausePhase = pDur > 0 ? (localT - wDur) / pDur : 1; // 정지 진행도 [0,1]
    const look = pausePhase > 0.5 ? !movingRight : movingRight;
    faceX = look ? -1 : 1;
    // 정지 중 idle 을 주기 해시로 결정 선택: 0=가만(≈50%), 1=제자리 폴짝(≈28%), 2=좌우 흔들(≈22%).
    const hv = hn(n, 45.77);
    pauseMode = hv < 0.5 ? 0 : hv < 0.78 ? 1 : 2;
  }
  return { x, footY, scale, faceX, walking, w, pauseMode, pausePhase };
}

// PathBuilder 로 닫힌 다각형 SkPath 생성(rn-skia 2.6.x: moveTo/lineTo 는 PathBuilder 로).
function polyPath(pts) {
  const b = Skia.PathBuilder.Make();
  pts.forEach((p, i) => (i === 0 ? b.moveTo(p.x, p.y) : b.lineTo(p.x, p.y)));
  b.close();
  return b.build();
}

export default function CareRoom({ stage, petType = 0, sad = false, careEvent }) {
  const { width: W } = useWindowDimensions();
  const RW = Math.max(0, Math.round(W - SHEET_H_PAD));
  const clock = useClock();
  const petAtlas = useImage(PET_ATLAS_SRC);
  const geo = useMemo(() => roomGeometry(RW), [RW]);

  // 크리처 스프라이트(발밑 앵커) — 메인 맵과 동일 파이프라인. stage/petType/sad 바뀌면 재베이크.
  const petPicture = useMemo(
    () => bakePetPicture(petAtlas, stage, petType, sad),
    [petAtlas, stage, petType, sad],
  );

  // 방 4면(뒷벽·바닥·좌벽·우벽) Path. 폭(RW)만 바뀌면 재계산. 바닥이 정육면체 내부 바닥.
  const room = useMemo(() => {
    const { backY, blx, brx } = geo;
    const backWall = polyPath([
      { x: blx, y: 0 },
      { x: brx, y: 0 },
      { x: brx, y: backY },
      { x: blx, y: backY },
    ]);
    const floor = polyPath([
      { x: blx, y: backY },
      { x: brx, y: backY },
      { x: RW, y: ROOM_H },
      { x: 0, y: ROOM_H },
    ]);
    const leftWall = polyPath([
      { x: 0, y: 0 },
      { x: blx, y: 0 },
      { x: blx, y: backY },
      { x: 0, y: ROOM_H },
    ]);
    const rightWall = polyPath([
      { x: brx, y: 0 },
      { x: RW, y: 0 },
      { x: RW, y: ROOM_H },
      { x: brx, y: backY },
    ]);
    return { backWall, floor, leftWall, rightWall };
  }, [geo, RW]);

  const isEgg = stage === "알";

  // --- 케어 반응 상태(방 안 손맛) ---
  // careStartMs: 현재 케어 반응 시작 clock(SharedValue). 초기 -1e9 = 아직 반응 없음(sentinel).
  // wanderOffset: "완료된 반응들의 누적 멈춤시간". 현재 진행 중 반응분은 worklet 의 extra 로 실시간 파생하므로
  //   여기엔 담지 않고, 다음 careEvent 수신 시 직전 반응의 멈춤분을 흡수(연타 시간축 정확 누적).
  // reactMode: 0=냠냠(satiety), 1=점프(happiness), 2=반짝(cleanliness) — 주 미터로 결정. careMeter: 파티클 분화 미터.
  const careStartMs = useSharedValue(-1e9);
  const wanderOffset = useSharedValue(0);
  const reactMode = useSharedValue(0);
  const [careMeter, setCareMeter] = useState(null);

  // 버스트 입자 심볼(원점 중심 SkPath, 1회 굽기). 미터별 형태: 하트·반짝·음식 알갱이·낟알점.
  const heartPath = useMemo(() => Skia.Path.MakeFromSVGString(BURST_HEART_SVG), []);
  const sparkPath = useMemo(() => Skia.Path.MakeFromSVGString(BURST_SPARK_SVG), []);
  const grainPath = useMemo(() => Skia.Path.MakeFromSVGString(BURST_GRAIN_SVG), []);
  const dotPath = useMemo(() => Skia.Path.MakeFromSVGString(BURST_DOT_SVG), []);

  // careEvent 수신 -> 반응 시작. 이전 반응의 멈춤시간을 이 시점에 wanderOffset 으로 흡수한 뒤 새 반응을 연다.
  // 흡수분 = clamp(t - 직전careStartMs, 0, REACT_MS): 직전 반응이 이미 끝났으면 REACT_MS, 반응 중 재케어(연타)면
  // 경과분만 누적된다. 이렇게 하면 새 반응의 프리즈 wt(= t - wanderOffset)가 직전 프리즈 지점과 정확히 연속.
  useEffect(() => {
    if (!careEvent) return;
    const t = clock.value; // clock.value 는 JS 에서 읽기 가능.
    const prev = careStartMs.value;
    const prevFreeze = prev < 0 ? 0 : Math.min(Math.max(t - prev, 0), REACT_MS);
    wanderOffset.value += prevFreeze;
    careStartMs.value = t;
    // 주 미터를 game.js CARE_ACTIONS.meters 에서 판정(최대 델타 키). 크리처 리액션 모드는 미터와 1:1
    // (satiety=냠냠 / happiness=점프 / cleanliness=반짝) — 기존 모션 유지.
    const meter = primaryMeter(careEvent.action);
    reactMode.value = MOTION[meter];
    setCareMeter(meter);
    // 앵커는 여기서 캡처하지 않는다 — creaturePose 파생 SharedValue(anchorX/anchorY)가 매 프레임 크리처를 따라간다.
  }, [careEvent, clock, careStartMs, wanderOffset, reactMode]);

  // 크리처 pose(최종 translate/scale + 원근 scale)를 매 프레임(UI 스레드) 계산. 알은 정적(앞-중앙, 숨쉬기만).
  // 케어 반응 중(REACT_MS)엔 산책을 프리즈하고 모드별 리액션 모션을 얹는다.
  // 반환 { tx, ty, sx, sy, scale }: transform 배열과 파티클 앵커를 이 하나에서 파생 -> 앵커가 반응 모션(offY)까지
  // 크리처와 동일하게 따라간다(파티클이 크리처 중심에 정확히 붙는 핵심).
  const creaturePose = useDerivedValue(() => {
    const t = clock.value;
    const started = careStartMs.value;
    const reactElapsed = t - started;
    const reacting = started >= 0 && reactElapsed >= 0 && reactElapsed < REACT_MS;

    // 산책 유효 시간(wt): 실시간에서 "완료된 반응 누적 멈춤(wanderOffset)"과 "현재 반응 진행 멈춤(extra)"을 뺀다.
    // extra 는 반응 중 reactElapsed 로 자라다 REACT_MS 에서 포화 -> 반응 중 wt 는 상수(프리즈)이고,
    // 반응 종료 프레임(reactElapsed=REACT_MS)에 wt 가 프리즈 지점과 정확히 연속(한 시계, setTimeout 경합 제거).
    const extra = started < 0 ? 0 : Math.min(Math.max(reactElapsed, 0), REACT_MS);
    const wt = t - wanderOffset.value - extra;

    // 케어 반응: 산책 프리즈(wt 가 이 구간 내내 상수) + 모드별 모션(냠냠/점프/반짝).
    if (reacting) {
      const rt = reactElapsed / REACT_MS;
      let x, footY, scale, face;
      if (isEgg) {
        x = geo.cx;
        footY = geo.footFrontY;
        scale = geo.scaleFront;
        face = 1;
      } else {
        const p = wanderPlacement(wt, geo);
        x = p.x;
        footY = p.footY;
        scale = p.scale;
        face = p.faceX;
      }
      let offY = 0;
      let sqx = 1;
      let sqy = 1;
      const mode = reactMode.value;
      if (mode === 1) {
        // pet/play: 점프 강화(두 번 통통 튐)
        const lift = Math.abs(Math.sin(rt * Math.PI * 2));
        offY = -HOP_HEIGHT * 1.7 * lift * scale;
        sqy = 1 - HOP_SQUASH * (1 - lift);
        sqx = 1 / sqy;
      } else if (mode === 0) {
        // feed/snack: 냠냠(빠른 세로 squash 반복)
        const pulse = Math.abs(Math.sin(rt * Math.PI * 4));
        sqy = 1 - 0.16 * pulse;
        sqx = 1 / sqy;
      } else {
        // wash/clean/poop: 반짝(잔잔한 바운스만, squash 없음)
        offY = -3 * scale * (0.5 + 0.5 * Math.sin(rt * Math.PI * 3));
      }
      return {
        tx: x,
        ty: footY + offY,
        sx: face * scale * sqx,
        sy: scale * sqy,
        scale,
      };
    }

    // 평상시: 산책. wt(위에서 파생) = 실시간 - 완료 반응 누적(extra=0). 반응 종료 프레임부터 프리즈 지점에서 끊김 없이 진행.
    if (isEgg) {
      const breathe = 1 + BREATHE_AMP * Math.sin((wt / BREATHE_PERIOD) * 2 * Math.PI);
      return {
        tx: geo.cx,
        ty: geo.footFrontY,
        sx: geo.scaleFront,
        sy: geo.scaleFront * breathe,
        scale: geo.scaleFront,
      };
    }
    const p = wanderPlacement(wt, geo);
    if (p.walking) {
      // hop: 걷는 동안만 통통. hopFade 로 걸음 시작·도착 순간 발을 바닥에 붙여 정지로 매끄럽게 잇는다.
      const hopFade = Math.sin(p.w * Math.PI);
      const phase = (wt % HOP_PERIOD) / HOP_PERIOD;
      const lift = Math.sin(phase * Math.PI) * hopFade;
      const offsetY = -HOP_HEIGHT * lift * p.scale;
      const squash = HOP_SQUASH * (1 - lift) * hopFade;
      return {
        tx: p.x,
        ty: p.footY + offsetY,
        sx: p.faceX * p.scale * (1 + squash),
        sy: p.scale * (1 - squash),
        scale: p.scale,
      };
    }
    // 정지: 위치 고정 + 숨쉬기(scaleY 맥동) + 주기 해시로 고른 idle. 두리번(좌우향)은 faceX 가 담당.
    const breathe = 1 + BREATHE_AMP * Math.sin((wt / BREATHE_PERIOD) * 2 * Math.PI);
    let idleX = 0;
    let idleY = 0;
    if (p.pauseMode === 1) {
      // 제자리 폴짝: 초반에 두어 번 통통, 끝으로 갈수록 잦아듦(경계에서 0 -> 다음 이동과 연속).
      const bob = Math.max(0, Math.sin(p.pausePhase * Math.PI * 3));
      idleY = -IDLE_HOP * p.scale * bob * (1 - p.pausePhase);
    } else if (p.pauseMode === 2) {
      // 좌우 흔들(두리번): 잔잔한 sway, 끝으로 갈수록 잦아듦.
      idleX = IDLE_SWAY * Math.sin(p.pausePhase * Math.PI * 4) * (1 - p.pausePhase);
    }
    return {
      tx: p.x + idleX,
      ty: p.footY + idleY,
      sx: p.faceX * p.scale,
      sy: p.scale * breathe,
      scale: p.scale,
    };
  }, [geo, isEgg]);

  // pose -> transform 배열(크리처 렌더). 값은 이전 구현과 동일(회귀 없음).
  const creatureTransform = useDerivedValue(() => {
    const p = creaturePose.value;
    return [
      { translateX: p.tx },
      { translateY: p.ty },
      { scaleX: p.sx },
      { scaleY: p.sy },
    ];
  }, []);

  // 파티클 앵커: 크리처 중심~머리 위(몸높이 기준). pose 와 같은 소스라 반응 offY(점프/바운스)까지 따라간다.
  const anchorX = useDerivedValue(() => creaturePose.value.tx, []);
  // 머리 오프셋은 화면 고정 px(원근 scale·facing 비상속) -> 크리처가 원근으로 작아지거나 뒤집혀도 파티클
  // 확산은 불변. 앵커는 위치(tx/ty)만 크리처를 따라간다.
  const anchorY = useDerivedValue(
    () => creaturePose.value.ty - PET_TARGET_MAX_H * ANCHOR_HEAD_FRAC,
    [],
  );

  if (RW <= 0) return null;

  return (
    <Canvas style={{ width: "100%", height: ROOM_H }}>
      <Fill color={AMBIENT_COLOR} />
      {/* 정육면체 내부 4면: 뒷벽 -> 좌/우 측벽(그늘) -> 바닥(밝음). 그린 순서 = 뒤에서 앞. */}
      <Path path={room.backWall} color={WALL_BACK_COLOR} />
      <Path path={room.leftWall} color={WALL_LEFT_COLOR} />
      <Path path={room.rightWall} color={WALL_RIGHT_COLOR} />
      <Path path={room.floor} color={FLOOR_COLOR} />
      {/* 면 경계선(정육면체 윤곽) */}
      <Path path={room.backWall} color={EDGE_COLOR} style="stroke" strokeWidth={1} />
      <Path path={room.floor} color={EDGE_COLOR} style="stroke" strokeWidth={1} />
      {petPicture && (
        <Group transform={creatureTransform}>
          <Picture picture={petPicture} />
        </Group>
      )}
      {/* 케어 손맛 버스트(방 안): careEvent 후 작은 입자들이 크리처 머리 위에서 톡 터진다. 앵커는 크리처 pose
          파생(원점만 크리처를 따라감), 확산 방향·크기는 화면 독립. 미터별 분화 — happiness=하트가 위로 둥실,
          cleanliness=반짝이 분수처럼 팍, satiety=음식 알갱이가 통통 튀며 크리처로 되모임. */}
      {careMeter &&
        Array.from({ length: BURST_COUNT }).map((_, i) => {
          // 미터별 형태·색. satiety 는 알갱이/낟알점을 index 짝/홀로 섞어 음식 텍스처 변주.
          const path =
            careMeter === "happiness"
              ? heartPath
              : careMeter === "cleanliness"
                ? sparkPath
                : i % 2 === 0
                  ? grainPath
                  : dotPath;
          const palette =
            careMeter === "happiness"
              ? HAPPY_PALETTE
              : careMeter === "cleanliness"
                ? CLEAN_PALETTE
                : FOOD_PALETTE;
          return (
            <CareBurstParticle
              key={i}
              clock={clock}
              startMs={careStartMs}
              index={i}
              count={BURST_COUNT}
              motion={MOTION[careMeter]}
              anchorX={anchorX}
              anchorY={anchorY}
              path={path}
              color={palette[i % 3]}
            />
          );
        })}
    </Canvas>
  );
}
