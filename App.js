import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, ScrollView, AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';

import PixelHexMap from './src/PixelHexMap';

import { useLocation } from './src/useLocation';
import { cellKeyAt, cellsAround } from './src/grid';
import { cellTheme } from './src/items';
import { levelFromXp, stageFromLevel } from './src/game';
import { STORAGE_KEY, INITIAL_STATE, applyVisit } from './src/occupy';
import { registerBackgroundLocation } from './src/backgroundLocation';

// 시야 반경(H3 ring). 내 위치 중심 약 3칸까지 미개척 그리드를 보여준다.
const VISION_RING = 3;

export default function App() {
  const [coords, setCoords] = useState(null);
  const [currentKey, setCurrentKey] = useState(null);
  // 게임 상태 단일 진실원. occupied/xp/items 를 한 객체로 묶어 포그라운드·백그라운드가 같은 shape 을 쓴다.
  const [gameState, setGameState] = useState(INITIAL_STATE);
  const [gridCells, setGridCells] = useState([]);
  // 펫이 바라보는 방향. false = 왼쪽 보기(스프라이트 기본), true = 오른쪽(동쪽 이동 시 반전).
  const [facingRight, setFacingRight] = useState(false);

  const loaded = useRef(false);
  const lastGridKey = useRef(null);
  const lastCoordsRef = useRef(null); // 직전 좌표(이동 방향 판정용)

  // 저장소에서 게임 상태를 읽어온다. 구버전/누락 필드는 INITIAL_STATE 로 메워 하위호환.
  const loadGameState = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        setGameState({ ...INITIAL_STATE, ...s });
      }
    } catch {}
  }, []);

  // 마운트 시 1회 로드
  useEffect(() => {
    (async () => {
      await loadGameState();
      loaded.current = true;
    })();
  }, [loadGameState]);

  // 상태 영속화 (첫 로드 전엔 건너뜀)
  useEffect(() => {
    if (!loaded.current) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(gameState)).catch(() => {});
  }, [gameState]);

  // 포그라운드 복귀 시 백그라운드 태스크가 저장소에 쌓아둔 누적분을 다시 로드해 화면에 반영.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') loadGameState();
    });
    return () => sub.remove();
  }, [loadGameState]);

  // 마운트 시 백그라운드 위치 추적 시작(권한 요청 + 태스크 등록).
  // 실패하거나 거절돼도 포그라운드(useLocation)는 정상 동작해야 하므로 결과는 무시한다.
  useEffect(() => {
    registerBackgroundLocation().catch(() => {});
  }, []);

  // 좌표 갱신 → 셀 판정 → 점령/보상 처리(occupy.js 의 순수 함수에 위임)
  const handleCoords = useCallback((c) => {
    setCoords(c);
    const key = cellKeyAt(c.latitude, c.longitude);
    setCurrentKey(key);

    // 이동 방향으로 펫 좌우 바라보기 갱신. 경도 증가=동쪽(오른쪽), 감소=서쪽(왼쪽).
    // GPS jitter 로 깜빡이지 않게 작은 임계값(1e-5 deg) 이상 이동했을 때만 facing 을 바꾼다.
    const prev = lastCoordsRef.current;
    if (prev) {
      const dLng = c.longitude - prev.longitude;
      if (Math.abs(dLng) > 1e-5) setFacingRight(dLng > 0);
    }
    lastCoordsRef.current = c;

    // 셀이 바뀔 때만 그리드 다시 계산(불필요한 재계산 방지)
    if (key !== lastGridKey.current) {
      lastGridKey.current = key;
      setGridCells(cellsAround(c.latitude, c.longitude, undefined, VISION_RING));
    }

    // 함수형 업데이트로 stale 방지. 보상이 없으면 applyVisit 가 같은 참조를 돌려줘 리렌더가 생략된다.
    setGameState((prev) => applyVisit(prev, c, Date.now()).state);
  }, []);

  const status = useLocation(handleCoords);

  const level = levelFromXp(gameState.xp);
  const stage = stageFromLevel(level);

  return (
    // GestureHandlerRootView 가 앱 루트에 있어야 PixelHexMap 내부의 GestureDetector(핀치 줌)가 동작한다.
    <GestureHandlerRootView style={styles.container}>
      <PixelHexMap
        coords={coords}
        gridCells={gridCells}
        occupied={gameState.occupied}
        currentKey={currentKey}
        stage={stage}
        facingRight={facingRight}
      />

      <View style={styles.card}>
        <Text style={styles.title}>나의 다마고치</Text>
        <Text style={styles.stage}>
          {stage} · Lv.{level}
        </Text>
        <Text style={styles.sub}>
          XP {gameState.xp} · 점령 {Object.keys(gameState.occupied).length}칸
        </Text>
        <Text style={styles.sub}>
          현재 지역: {currentKey ? cellTheme(currentKey) : '위치 확인 중...'}
        </Text>
        {status !== 'tracking' && (
          <Text style={styles.warn}>위치 상태: {status}</Text>
        )}
      </View>

      <View style={styles.log}>
        <Text style={styles.logTitle}>최근 획득</Text>
        <ScrollView>
          {gameState.items.length === 0 && <Text style={styles.dim}>아직 없음</Text>}
          {gameState.items.map((it, i) => (
            <Text key={i} style={styles.logItem}>
              {it.item}
            </Text>
          ))}
        </ScrollView>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  card: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  title: { fontSize: 13, color: '#6b7280', marginBottom: 2 },
  stage: { fontSize: 22, fontWeight: '700', color: '#111827' },
  sub: { fontSize: 13, color: '#374151', marginTop: 2 },
  warn: { fontSize: 12, color: '#b91c1c', marginTop: 6 },
  log: {
    position: 'absolute',
    bottom: 32,
    left: 16,
    right: 16,
    maxHeight: 160,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 16,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  logTitle: { fontSize: 13, color: '#6b7280', marginBottom: 6 },
  logItem: { fontSize: 15, color: '#111827', paddingVertical: 2 },
  dim: { fontSize: 13, color: '#9ca3af' },
});
