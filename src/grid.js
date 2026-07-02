import { latLngToCell, cellToBoundary, gridDisk } from 'h3-js';

// H3 육각 셀 해상도. 11 ≈ 한 칸 폭 약 50m(보행에 촘촘, 방향 전환·고정 줌 뷰용).
// 10으로 낮추면 한 칸 폭 약 130m, 9면 자동차 이동용으로 더 커집니다.
export const H3_RESOLUTION = 11;

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
