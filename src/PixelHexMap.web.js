// react-native-skia 는 웹에서 CanvasKit(WASM) 로딩 + 번들러 추가 설정이 필요하다.
// walkmon 웹은 어차피 상태 카드 + 획득 로그만 보여주면 되므로(기존 GameMap.web.js 규약),
// 웹에서는 픽셀 헥스 월드를 그리지 않고 null 을 반환한다.
export default function PixelHexMap() {
  return null;
}
