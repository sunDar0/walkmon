// 전체 지도 뷰(발자취 개요) 웹 스텁 — 플레이스홀더.
// 웹 분리 규약(App 이 확장자 없이 ./src/FullMap import → 번들러가 이 .web 짝을 선택)을 유지하기 위한 최소 구현.
// 실제 웹 렌더 여부·형태는 pixel-render-engineer 가 결정해 교체한다. props 는 네이티브와 동일(occupiedKeys).
import { StyleSheet, View, Text } from 'react-native';

export default function FullMap({ occupiedKeys = [] }) {
  return (
    <View style={styles.container}>
      <Text style={styles.placeholder}>발자취 개요 · 점령 {occupiedKeys.length}칸</Text>
      <Text style={styles.hint}>지도 렌더는 앱(네이티브)에서만 표시됩니다.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#e7e1cf', alignItems: 'center', justifyContent: 'center' },
  placeholder: { color: '#5b4a2f', fontSize: 15, fontWeight: '600' },
  hint: { color: '#8a7a5a', fontSize: 12, marginTop: 6 },
});
