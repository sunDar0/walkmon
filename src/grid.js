import { latLngToCell, cellToBoundary, gridDisk, cellToParent, getResolution } from 'h3-js';

// H3 육각 셀 해상도. 11 ≈ 한 칸 폭 약 50m(보행에 촘촘, 방향 전환·고정 줌 뷰용).
// 10으로 낮추면 한 칸 폭 약 130m, 9면 자동차 이동용으로 더 커집니다.
export const H3_RESOLUTION = 11;

// 전체 지도 뷰(발자취 개요)에서 점령 셀을 뭉치는 코스 해상도. 6 ≈ 한 칸 폭 약 3~4km
// (전국을 한 화면에 담을 때 res11 원본 셀은 너무 잘아 안 보이므로 부모 셀로 롤업한다).
export const FULLMAP_RES = 6;

// 좌표 → 육각 셀 키(H3 인덱스). 이 키 자체가 "지역" 식별자입니다.
export function cellKeyAt(lat, lng, res = H3_RESOLUTION) {
  return latLngToCell(lat, lng, res);
}

// 중심 좌표가 속한 셀 주변을 육각 셀들로 타일링해 반환합니다.
// 각 셀의 여섯 꼭짓점(corners)을 함께 주므로 지도에 폴리곤으로 바로 그릴 수 있습니다.
// ring=6이면 중심 포함 약 127칸(육각 6링)을 반환합니다.
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

// 셀 키 하나의 여섯 꼭짓점을 반환한다.
// 점령한 영토를 시야 윈도우 밖에서도 영구적으로 그릴 때 사용한다.
export function cornersOf(key) {
  return cellToBoundary(key).map(([lat, lng]) => ({
    latitude: lat,
    longitude: lng,
  }));
}

// 점령한 res11 셀 키들을 코스 부모 셀(targetRes)로 롤업해 중복 제거한 배열을 반환한다.
// 전체 지도 뷰에서 "밝은 코스 셀"(발자취가 닿은 넓은 구역) 집합을 만드는 단일 출처.
// h3-js cellToParent 는 targetRes 가 원본 res 보다 작아야(더 거칠어야) 한다. targetRes 가
// 원본과 같거나 더 세밀하면 부모가 성립하지 않으므로 그 키는 원본 그대로 통과시킨다(방어).
export function rollupKeys(keys, targetRes = FULLMAP_RES) {
  const out = new Set();
  for (const key of keys) {
    const parent = getResolution(key) > targetRes ? cellToParent(key, targetRes) : key;
    out.add(parent);
  }
  return Array.from(out);
}

// 전체 지도 뷰의 줌 배율(1x~6x)을 롤업 H3 해상도로 매핑하는 결정적 임계 함수.
// 줌아웃(작은 배율)=전국 스케일이라 거친 셀(res6), 줌인(큰 배율)=인접 스케일이라 고운 셀(res10).
// 임계선(기획 대략선: 전국 L6 / 광역 L8 / 인접 L10) — 3~4km / ~500m / ~65m 한 칸.
// 반환 res 는 항상 현재 셀 res(11) 이하라 rollupKeys 의 getResolution>targetRes 가드 안에서 안전.
export function resForZoom(zoom) {
  if (zoom < 2) return 6;   // 줌 1x~2x 미만: 전국을 한 화면에 (코스)
  if (zoom < 4) return 8;   // 줌 2x~4x 미만: 광역 (중간)
  return 10;                // 줌 4x 이상: 인접 지역 (고움)
}

// 셀 키 기준 반경 ring 이내의 셀 키 배열(중심 포함). ring=2 면 1+6+12=19칸.
// reveal(드러난 그리드) 집합 확장의 단일 출처. 좌표가 아니라 셀 키를 받는다
// (App.js 가 cellKeyAt 으로 이미 구한 현재 셀 키를 그대로 넘긴다).
export function diskKeys(originKey, ring = 2) {
  return gridDisk(originKey, ring);
}
