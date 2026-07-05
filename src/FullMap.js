// 전체 지도 뷰(발자취 개요) — 네이티브 Skia 렌더.
// 만화풍 남한 실루엣(KOREA_OUTLINE) 위에, 점령한 원본 res11 키(occupiedKeys)를 현재 줌에 맞는 해상도로
// 자체 롤업한 코스 셀 중심을 h3 cellToLatLng 로 구해 "실루엣과 동일한 투영"으로 발자취 마커를 찍는다.
// 레이어: 배경판(고정) → 남한 실루엣 → 발자취 마커. 실루엣·마커가 같은 project() 를 써 발자취가
// 남한 안 올바른 위치에 앉는다(투영 정합 필수). 핀치 줌 + 드래그 팬으로 발자취를 들여다볼 수 있다.
// 줌 임계(resForZoom)를 넘으면 롤업 해상도가 바뀌어 마커가 더 곱게/거칠게 재계산된다(줌인=고움/줌아웃=거침).
// 웹은 FullMap.web.js(Skia 미사용) 짝이 대신 선택된다.
// props:
//  - occupiedKeys: string[]  점령한 원본 res11 셀 키 배열(롤업 전). 롤업·좌표는 FullMap 이 품.
import { Canvas, Fill, Group, PaintStyle, Picture, Skia } from "@shopify/react-native-skia";
import { cellToLatLng } from "h3-js";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS, useDerivedValue, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { resForZoom, rollupKeys } from "./grid";

import { KOREA_OUTLINE } from "./koreaOutline";

// 배경판(종이/바다) 톤(플레이 뷰 BG_COLOR 재사용 — 두 뷰 판 질감 통일). 화면 전체를 덮고 줌/팬에 안 흔들린다.
const BG_COLOR = "#e7e1cf";

// --- 남한 실루엣(만화풍) 색 ---
const LAND_FILL = "#c3d4a2"; // 부드러운 땅색(연녹) — 종이 배경과 대비, 발자취 앰버가 위에서 또렷
const LAND_STROKE = "#6f8a4f"; // 살짝 진한 외곽선(만화풍 테두리)
const LAND_STROKE_W = 2;

// --- 발자취 마커 픽셀 톤 ---
// 코스 셀(res6 ~3.5km)은 전국 스케일에서 몇 px 라 크기는 최소 가시 크기로 고정(계약 1번 주석과 동일 판단).
// 연녹 실루엣 위에서 또렷하도록 따뜻한 주홍 채움 + 진한 적갈 외곽선(대비 up) + 옅은 그림자(도트 입체감).
const MARKER_R = 10; // 육각 마커 반지름(px, 줌 1x 기준. worldGroup zoom 이 확대). 7→10 살짝 키움.
const MARKER_FILL = "rgba(240, 98, 46, 1)"; // 따뜻한 주홍(밟은 땅) — 연녹 배경과 강한 대비
const MARKER_BORDER = "rgba(92, 32, 16, 0.95)"; // 진한 적갈 외곽선(테두리 대비)
const MARKER_BORDER_W = 2;
const MARKER_SHADOW = "rgba(45, 28, 15, 0.22)"; // 옅은 그림자(살짝 떠 보이는 도트감)
const MARKER_SHADOW_DY = 2; // 그림자 아래 오프셋(px)

// --- 핀치 줌 범위 ---
const ZOOM_MIN = 1; // 기본(남한 전체 fit)
const ZOOM_MAX = 6; // 발자취로 줌인

// --- 투영 fit 범위 = KOREA_OUTLINE bounds ---
// KOREA_OUTLINE 은 링 배열(다중 폴리곤): [본토 링, 제주 링]. 모든 링의 전체 점에서 경위도 min/max 를
// 모듈 로드 시 1회 계산해 본토+제주가 다 화면에 들어오게 fit 한다(제주 위도 33.2 포함 → 남쪽으로 넓어짐).
// 마커도 이 동일 bounds·동일 project 를 써 정합(발자취가 실루엣 안 올바른 위치).
const OUTLINE_LNGS = KOREA_OUTLINE.flatMap((ring) => ring.map((p) => p[0]));
const OUTLINE_LATS = KOREA_OUTLINE.flatMap((ring) => ring.map((p) => p[1]));
const LNG_MIN = Math.min(...OUTLINE_LNGS);
const LNG_MAX = Math.max(...OUTLINE_LNGS);
const LAT_MIN = Math.min(...OUTLINE_LATS);
const LAT_MAX = Math.max(...OUTLINE_LATS);
const MID_LAT = (LAT_MIN + LAT_MAX) / 2;
const COS_MID = Math.cos((MID_LAT * Math.PI) / 180); // 경도 압축 보정(중위도 상수) — 가로 늘어짐 방지
const FIT_MARGIN = 0.86; // 화면의 86%만 쓰고 14% 여백(실루엣이 가장자리에 붙지 않게)

// 남한 bounds 를 화면(W×H)에 여백 두고 fit 하는 equirectangular 투영 함수를 만든다.
// 실루엣·마커가 반드시 같은 함수를 써야 발자취가 남한 안 올바른 위치에 찍힌다(투영 정합).
// 정밀 측지(EPSG:5179) 불필요 — 선형 매핑 + 중위도 cos 보정 1회로 MVP 충분.
function makeProjection(W, H) {
  const spanX = (LNG_MAX - LNG_MIN) * COS_MID; // 경도 보정 폭(도)
  const spanY = LAT_MAX - LAT_MIN; // 위도 폭(도)
  const scale = Math.min((W * FIT_MARGIN) / spanX, (H * FIT_MARGIN) / spanY);
  const drawW = spanX * scale;
  const drawH = spanY * scale;
  const originX = (W - drawW) / 2;
  const originY = (H - drawH) / 2;
  return (lat, lng) => ({
    x: originX + (lng - LNG_MIN) * COS_MID * scale,
    // 위도는 위(북)가 화면 위로 가게 반전.
    y: originY + (LAT_MAX - lat) * scale,
  });
}

// 중심(cx,cy) 기준 똑바로 선 pointy-top 육각 6꼭짓점 Path(반지름 r). 픽셀 톤이라 antiAlias off.
function hexPath(cx, cy, r) {
  const hw = (r * Math.sqrt(3)) / 2; // 가로 절반(정육각 pointy-top)
  const builder = Skia.PathBuilder.Make();
  builder.moveTo(cx, cy - r); // 위 꼭짓점
  builder.lineTo(cx + hw, cy - r / 2); // 우상
  builder.lineTo(cx + hw, cy + r / 2); // 우하
  builder.lineTo(cx, cy + r); // 아래 꼭짓점
  builder.lineTo(cx - hw, cy + r / 2); // 좌하
  builder.lineTo(cx - hw, cy - r / 2); // 좌상
  builder.close();
  return builder.build();
}

export default function FullMap({ occupiedKeys = [] }) {
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets(); // 상태바/노치 아래로 배지를 앉히기 위한 안전영역 여백

  // --- 줌 따라 롤업 해상도 전환 (계약 p21) ---
  // 줌은 UI 스레드 SharedValue(매 프레임), 롤업(rollupKeys)은 JS 라 매 프레임 롤업은 금지.
  // 줌→해상도 "버킷"만 React state 로 두고, 핀치 onEnd 에서 zoom 을 읽어 resForZoom 으로 버킷을 계산해
  // 버킷이 바뀔 때만 setState → litCoarseCells 재계산은 임계를 넘을 때만 일어난다. 초기값은 초기 줌(1x) 기준.
  const [currentRes, setCurrentRes] = useState(() => resForZoom(1));
  // 핀치 종료 시 JS 스레드에서 호출(worklet 안 resForZoom/setState 직접 호출 불가 → runOnJS 로 넘김).
  // 버킷 동일하면 setState 생략(불필요 재렌더/재롤업 방지). useCallback([]) 로 stable 참조.
  const handleZoomEnd = useCallback((z) => {
    const next = resForZoom(z);
    setCurrentRes((prev) => (prev === next ? prev : next));
  }, []);

  // occupiedKeys(원본 res11) → 현재 해상도로 롤업한 코스 셀 집합. occupiedKeys/currentRes 바뀔 때만 재계산.
  const litCoarseCells = useMemo(
    () => rollupKeys(occupiedKeys, currentRes),
    [occupiedKeys, currentRes],
  );

  // 남한 실루엣을 단일 Picture 로 베이크한다(W/H 로만 메모 — 발자취와 무관한 정적 배경).
  // KOREA_OUTLINE 링 배열([본토, 제주])을 순회해 각 링을 닫힌 서브패스로 그린다(하나의 Path 에 담아
  // fill+stroke 한 번에 → 본토·제주 둘 다 채워지고 테두리 그려짐). 만화풍이라 antiAlias on(매끈한 해안선).
  // 마커와 동일 project 를 써 좌표계가 일치한다.
  const silhouette = useMemo(() => {
    const project = makeProjection(W, H);
    const builder = Skia.PathBuilder.Make();
    KOREA_OUTLINE.forEach((ring) => {
      ring.forEach(([lng, lat], i) => {
        const { x, y } = project(lat, lng);
        if (i === 0) builder.moveTo(x, y);
        else builder.lineTo(x, y);
      });
      builder.close(); // 링마다 닫아 별개 폴리곤으로(본토와 제주가 선으로 안 이어지게)
    });
    const path = builder.build();

    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, W, H));
    const fill = Skia.Paint();
    fill.setAntiAlias(true);
    fill.setColor(Skia.Color(LAND_FILL));
    canvas.drawPath(path, fill);
    const stroke = Skia.Paint();
    stroke.setAntiAlias(true);
    stroke.setColor(Skia.Color(LAND_STROKE));
    stroke.setStyle(PaintStyle.Stroke);
    stroke.setStrokeWidth(LAND_STROKE_W);
    canvas.drawPath(path, stroke);
    return recorder.finishRecordingAsPicture();
  }, [W, H]);

  // 발자취 마커들을 단일 Picture 로 베이크한다(litCoarseCells/W/H 로만 메모).
  // 각 코스 키 → cellToLatLng(중심) → 실루엣과 동일한 project → 육각 마커(채움 + 보더).
  const markers = useMemo(() => {
    if (!litCoarseCells || litCoarseCells.length === 0) return null;
    const project = makeProjection(W, H);
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, W, H));

    const fill = Skia.Paint();
    fill.setAntiAlias(false);
    fill.setColor(Skia.Color(MARKER_FILL));
    const border = Skia.Paint();
    border.setAntiAlias(false);
    border.setColor(Skia.Color(MARKER_BORDER));
    border.setStyle(PaintStyle.Stroke);
    border.setStrokeWidth(MARKER_BORDER_W);
    const shadow = Skia.Paint();
    shadow.setAntiAlias(false);
    shadow.setColor(Skia.Color(MARKER_SHADOW));

    // 투영 좌표를 1회 계산해 그림자·본체 두 패스에 공용(중복 cellToLatLng 회피).
    const pts = [];
    for (const key of litCoarseCells) {
      const [lat, lng] = cellToLatLng(key); // h3-js: 셀 중심 [lat, lng]
      const { x, y } = project(lat, lng);
      pts.push({ x: Math.round(x), y: Math.round(y) });
    }
    // 1패스: 그림자를 전 마커에 먼저 → 인접 마커가 겹쳐도 그림자가 항상 뒤로(자연스러운 겹침).
    for (const p of pts) {
      canvas.drawPath(hexPath(p.x, p.y + MARKER_SHADOW_DY, MARKER_R), shadow);
    }
    // 2패스: 채움 + 외곽선(그림자 위에).
    for (const p of pts) {
      const path = hexPath(p.x, p.y, MARKER_R);
      canvas.drawPath(path, fill);
      canvas.drawPath(path, border);
    }
    return recorder.finishRecordingAsPicture();
  }, [litCoarseCells, W, H]);

  // --- 팬/줌 (UI 스레드 SharedValue — React 리렌더·재베이크 없음) ---
  // 실루엣/마커 Picture 는 그대로 두고 <Group transform> 만 GPU 스케일/이동한다(부드럽게).
  // FullMap 은 React 상태를 안 건드리므로 PixelHexMap 과 달리 .runOnJS 불필요(worklet 안 SharedValue 만 변이).
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  // 표준 focal-point 핀치 줌: 손가락 사이 초점(e.focalX/Y) 아래의 월드 점이 확대/축소 중에도 고정되게
  // tx/ty 를 보정한다. worldTransform 이 screen = scale·world + (tx,ty) 라, 시작 시점 초점 아래 월드 점
  // w0 = (f - savedT)/savedScale 가 새 스케일 s 에서도 f 에 머무르려면 t = f − (f − savedT)·(s/savedScale).
  // onStart 에서 saved 를 현재값으로 스냅 → 제스처 내내 안정적 기준. onEnd 에서 saved 갱신 + 롤업 버킷 갱신.
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onStart(() => {
          savedScale.value = scale.value;
          savedTx.value = tx.value;
          savedTy.value = ty.value;
        })
        .onUpdate((e) => {
          const s = Math.min(
            ZOOM_MAX,
            Math.max(ZOOM_MIN, savedScale.value * e.scale),
          );
          const r = s / savedScale.value; // 스케일 비(초점 보정 계수)
          scale.value = s;
          tx.value = e.focalX - (e.focalX - savedTx.value) * r;
          ty.value = e.focalY - (e.focalY - savedTy.value) * r;
        })
        .onEnd(() => {
          savedScale.value = scale.value;
          savedTx.value = tx.value;
          savedTy.value = ty.value;
          // 줌 확정 시점에만 롤업 해상도 버킷을 갱신(매 프레임 아님). onUpdate 는 UI 스레드 유지.
          runOnJS(handleZoomEnd)(scale.value);
        }),
    [handleZoomEnd],
  );

  // 팬은 1손가락 전용(maxPointers(1)) — 2손가락 핀치와 tx/ty 를 두고 안 싸우게 분리(핀치가 초점 보정으로
  // 2손가락 이동/줌을 전담). onStart 에서 saved 스냅 → 누적 기준 일관.
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .onStart(() => {
          savedTx.value = tx.value;
          savedTy.value = ty.value;
        })
        .onUpdate((e) => {
          tx.value = savedTx.value + e.translationX;
          ty.value = savedTy.value + e.translationY;
        })
        .onEnd(() => {
          savedTx.value = tx.value;
          savedTy.value = ty.value;
        }),
    [],
  );

  const composedGesture = useMemo(
    () => Gesture.Simultaneous(pinchGesture, panGesture),
    [pinchGesture, panGesture],
  );

  // screen = scale·world + (tx,ty). 원점 기준 스케일 후 이동 — 초점 보정은 이미 tx/ty(핀치 onUpdate)에 반영됐다.
  // scale=1,tx=ty=0 이면 항등 → 베이크된 실루엣/마커가 투영 좌표 그대로(초기 상태 정합).
  const worldTransform = useDerivedValue(
    () => [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
    [],
  );

  return (
    <View style={styles.container}>
      <GestureDetector gesture={composedGesture}>
        <Canvas style={StyleSheet.absoluteFill}>
          {/* 배경판(종이/바다): 줌/팬 밖에 둬 항상 화면 전체를 덮는다(빈틈 없음). */}
          <Fill color={BG_COLOR} />
          {/* 월드: 실루엣 + 마커를 한 Group 으로 묶어 함께 스케일/이동(같은 좌표계 유지). */}
          <Group transform={worldTransform}>
            <Picture picture={silhouette} />
            {markers && <Picture picture={markers} />}
          </Group>
        </Canvas>
      </GestureDetector>
      {/* 발자취 개수 안내(임시 디버그 UI — 정식 전체지도 UI 로 교체 전제). 줌/팬에 안 흔들리는 화면 고정 오버레이.
          top 은 안전영역(상태바/노치) 아래로 인셋 + 여백을 줘 겹치지 않게 한다. */}
      <View
        style={[styles.badge, { top: insets.top + 8 }]}
        pointerEvents="none"
      >
        <Text style={styles.badgeText}>발자취 {litCoarseCells.length}곳</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  badge: {
    position: "absolute",
    left: 12,
    backgroundColor: "rgba(31,41,51,0.88)",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(244,183,64,0.5)", // 플레이 뷰 버튼과 통일한 옅은 골드 테두리
  },
  badgeText: { color: "#f4b740", fontSize: 13, fontWeight: "600" },
});
