// react-native-skia 는 웹에서 CanvasKit(WASM) 로딩 + 번들러 추가 설정이 필요하다.
// walkmon 웹은 어차피 상태 카드 + 획득 로그만 보여주면 되므로(기존 GameMap.web.js 규약),
// 웹에서는 픽셀 헥스 월드를 그리지 않고 null 을 반환한다.
export default function PixelHexMap() {
  return null;
}

// latticeDiskKeys: App.js(reveal SSOT)가 웹/네이티브 공통으로 import 하는 순수 기하 헬퍼라, 웹 stub 도
// 동일 export 를 제공해야 named import 가 웹에서 깨지지 않는다(Skia 무관 = 순수 계산). 네이티브
// PixelHexMap.js 의 동일 함수/상수와 값이 반드시 일치해야 한다(격자 정합의 단일 규격 — 바꾸면 양쪽 함께).
import { cellKeyAt } from "./grid";
const M_PER_DEG_LAT = 111320;
const PX_PER_M = 1.28;
const HEX_W = 64;
const HEX_H = Math.round((HEX_W * 2) / Math.sqrt(3));
const ROW_SPACING = 1.02;
function hexDistanceOddR(col, row) {
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  const y = -x - z;
  return (Math.abs(x) + Math.abs(y) + Math.abs(z)) / 2;
}
export function latticeDiskKeys(centerLat, centerLng, rings = 2) {
  const colStep = HEX_W;
  const rowStep = Math.round(HEX_H * 0.75 * ROW_SPACING);
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180);
  const seen = new Set();
  const keys = [];
  for (let r = -rings; r <= rings; r++) {
    for (let c = -rings - 1; c <= rings + 1; c++) {
      if (hexDistanceOddR(c, r) > rings) continue;
      const dx = c * colStep + (r & 1 ? colStep / 2 : 0);
      const dy = r * rowStep;
      const lat = centerLat + -dy / PX_PER_M / M_PER_DEG_LAT;
      const lng = centerLng + dx / PX_PER_M / mPerDegLng;
      const key = cellKeyAt(lat, lng);
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}
