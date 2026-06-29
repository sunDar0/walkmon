// react-native-maps는 웹을 지원하지 않습니다(import만 해도 웹 번들이 깨짐).
// 그래서 웹에서는 지도를 그리지 않고, App.js의 상태 카드와 획득 로그만 보여줍니다.
// 위치/격자/아이템 로직은 웹에서도 그대로 돌아가므로 상태 확인 용도로 충분합니다.
export default function GameMap() {
  return null;
}
