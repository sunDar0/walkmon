import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, ScrollView, AppState, Pressable } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';

import PixelHexMap, { latticeDiskKeys } from './src/PixelHexMap';
import FullMap from './src/FullMap';

import { useLocation } from './src/useLocation';
import { cellKeyAt } from './src/grid';
import { cellTheme } from './src/items';
import { STAGES, STAGE_MAX_LEVEL, levelInStage, canEvolve } from './src/game';
import { STORAGE_KEY, INITIAL_STATE, applyVisit, evolve, newGame } from './src/occupy';
import { registerBackgroundLocation } from './src/backgroundLocation';

// 초기 시야 반경(셀 키 기준 링). 최초 위치 수신 시 gridDisk k=2(중심1+6+12=19칸)만 reveal.
const REVEAL_RING = 2;

// 초기화 속성 선택지. type 은 상태 petType(0~3), 색은 미리보기 라벨용(스프라이트 속성 색과 통일).
const PET_OPTIONS = [
  { type: 0, label: '불', color: '#e0533d' },
  { type: 1, label: '물', color: '#4ea3e0' },
  { type: 2, label: '땅', color: '#c79a5e' },
  { type: 3, label: '바람', color: '#5fb87a' },
];

export default function App() {
  const [coords, setCoords] = useState(null);
  const [currentKey, setCurrentKey] = useState(null);
  // 게임 상태 단일 진실원. occupied/stageIndex/stageXp/items 를 한 객체로 묶어 포그라운드·백그라운드가 같은 shape 을 쓴다.
  const [gameState, setGameState] = useState(INITIAL_STATE);
  // 펫이 바라보는 방향. false = 왼쪽 보기(스프라이트 기본), true = 오른쪽(동쪽 이동 시 반전).
  const [facingRight, setFacingRight] = useState(false);
  // reveal(드러나 배치된 그리드) 세션 상태. A안(쌓임): 한 번 드러난 칸은 세션 동안 유지되며 탐험할수록 커진다.
  //  - cells: 지금까지 드러난 셀 키 Set (렌더 대상). 영속화하지 않음 — 앱 재시작 시 다시 현재 위치 k=2 부터.
  //  - newly: 이번 위치 갱신에서 새로 드러난 셀 키 배열(pixel-render 낙하 애니메이션 대상). 신규 없는 스텝엔 [].
  const [reveal, setReveal] = useState({ cells: new Set(), newly: [] });
  // 초기화 속성 선택 오버레이 표시 여부(임시 테스트용).
  const [pickerOpen, setPickerOpen] = useState(false);
  // 활성 뷰. 'play'=캐릭터 중심 플레이 뷰(PixelHexMap), 'map'=전체 지도 뷰(발자취 개요, FullMap).
  // 버튼 토글로만 전환(줌 구간 안 이음). 기본 'play'.
  const [activeView, setActiveView] = useState('play');

  const loaded = useRef(false);
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

    // 함수형 업데이트로 stale 방지. 보상이 없으면 applyVisit 가 같은 참조를 돌려줘 리렌더가 생략된다.
    setGameState((prev) => applyVisit(prev, c, Date.now()).state);

    // reveal 확장(A안): 현재 셀 k=2 이웃 중 아직 안 드러난 칸을 집합에 추가. 최초 스텝엔 19칸 전부 신규.
    // 신규가 없으면 prev 를 그대로(같은 참조) 돌려 리렌더 자체를 생략한다. newly 는 소비자(PixelHexMap
    // 인트로 effect)가 참조 동일성(Object.is)으로만 트리거하는 엣지 신호라, 같은 참조를 유지하면 재낙하가
    // 안 난다 — 굳이 새 []로 비울 필요가 없다. 오히려 새 []로 비우면, 기동 시 watchPositionAsync 가 캐시+
    // 신규 fix 를 연달아 줘 두 setReveal 이 한 배치로 합쳐질 때 첫 fix 의 newly(19)를 같은 커밋 안에서 덮어
    // 버려, 소비자가 newly>0 커밋을 한 번도 못 보고 인트로가 통째로 씹힌다(cells 만 채워짐).
    setReveal((prev) => {
      // reveal 소스는 렌더의 똑바른 격자 2링 아래 H3 키(latticeDiskKeys). H3 gridDisk(diskKeys)를 쓰면
      // H3 육각이 격자와 기울어 19칸 중 ~13칸만 매칭돼 화면이 비었다 → 격자 기준 헬퍼로 교체(19칸 정합).
      const disk = latticeDiskKeys(c.latitude, c.longitude, REVEAL_RING);
      const newly = disk.filter((k) => !prev.cells.has(k));
      if (newly.length === 0) {
        return prev;
      }
      const cells = new Set(prev.cells);
      for (const k of newly) cells.add(k);
      return { cells, newly };
    });
  }, []);

  // 초기화 확정: 선택 속성으로 새 게임 시작 + reveal 세션 시야도 최초 상태로 되돌린다.
  // 마지막으로 알던 좌표가 있으면 현재 셀 k=2(19칸)를 즉시 재시드한다 — 정지 상태에서 초기화하면
  // watchPositionAsync 가 새 fix 를 안 줘 handleCoords 가 다시 안 불리므로, 여기서 바로 seed 하지 않으면
  // reveal 이 빈 채로 남아 맵이 안 뜬다(앱 최초 기동은 마운트가 fix 를 유발해 문제 없었다).
  // newly=disk 로 넘겨 인트로 낙하(그리드 순차 → 캐릭터)도 재생된다. handleCoords 와 동일한
  // latticeDiskKeys·REVEAL_RING 을 재사용해 일관성 유지. 좌표 미수신이면 빈 Set(다음 fix 가 처리).
  const resetWithType = useCallback((petType) => {
    setGameState(newGame(petType));
    const last = lastCoordsRef.current;
    if (last) {
      const disk = latticeDiskKeys(last.latitude, last.longitude, REVEAL_RING);
      setReveal({ cells: new Set(disk), newly: disk });
    } else {
      setReveal({ cells: new Set(), newly: [] });
    }
    setPickerOpen(false);
  }, []);

  const status = useLocation(handleCoords);

  const stageIndex = gameState.stageIndex;
  const stage = STAGES[stageIndex];
  const level = levelInStage(gameState.stageXp, stageIndex);
  const maxLevel = STAGE_MAX_LEVEL[stageIndex];
  const evolvable = canEvolve(gameState.stageXp, stageIndex);

  return (
    // GestureHandlerRootView 가 앱 루트에 있어야 PixelHexMap 내부의 GestureDetector(핀치 줌)가 동작한다.
    <GestureHandlerRootView style={styles.container}>
      {activeView === 'play' ? (
        <PixelHexMap
          coords={coords}
          occupied={gameState.occupied}
          currentKey={currentKey}
          stage={stage}
          facingRight={facingRight}
          petType={gameState.petType}
          revealedCells={reveal.cells}
          newlyRevealed={reveal.newly}
        />
      ) : (
        <FullMap occupiedKeys={Object.keys(gameState.occupied)} />
      )}

      {activeView === 'play' && (
        <View style={styles.card}>
          <Text style={styles.title}>나의 다마고치</Text>
          <Text style={styles.stage}>
            {stage} · Lv.{level} / {maxLevel}
          </Text>
          <Text style={styles.sub}>
            이번 단계 XP {gameState.stageXp} · 점령 {Object.keys(gameState.occupied).length}칸
          </Text>
          <Text style={styles.sub}>
            현재 지역: {currentKey ? cellTheme(currentKey) : '위치 확인 중...'}
          </Text>
          {status !== 'tracking' && (
            <Text style={styles.warn}>위치 상태: {status}</Text>
          )}
          {evolvable && (
            <Pressable
              style={styles.evolveBtn}
              onPress={() => setGameState((prev) => evolve(prev))}
            >
              <Text style={styles.evolveBtnText}>✦ 진화하기</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* 최근 획득 로그: 디버그 중 임시 숨김. 다시 보려면 false -> true. */}
      {false && (
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
      )}

      {/* 임시 뷰 토글 버튼(우하단, 초기화 위). 플레이 뷰 ↔ 전체 지도 뷰 전환. */}
      <Pressable
        style={styles.viewToggleBtn}
        onPress={() => setActiveView((v) => (v === 'play' ? 'map' : 'play'))}
      >
        <Text style={styles.viewToggleBtnText}>{activeView === 'play' ? '지도' : '플레이'}</Text>
      </Pressable>

      {/* 임시 테스트용 초기화 버튼(나중에 제거 전제). 탭하면 확인창 없이 바로 속성 선택 오버레이. */}
      <Pressable style={styles.resetBtn} onPress={() => setPickerOpen(true)}>
        <Text style={styles.resetBtnText}>초기화</Text>
      </Pressable>

      {/* 속성 선택 오버레이: 4개 중 하나를 고르는 순간 초기화 확정(resetWithType). */}
      {pickerOpen && (
        <View style={styles.pickerOverlay}>
          <Text style={styles.pickerTitle}>속성 선택 (새 게임)</Text>
          <View style={styles.pickerRow}>
            {PET_OPTIONS.map((o) => (
              <Pressable
                key={o.type}
                style={[styles.pickerOption, { backgroundColor: o.color }]}
                onPress={() => resetWithType(o.type)}
              >
                <Text style={styles.pickerOptionText}>{o.label}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable style={styles.pickerCancel} onPress={() => setPickerOpen(false)}>
            <Text style={styles.pickerCancelText}>취소</Text>
          </Pressable>
        </View>
      )}
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
  evolveBtn: {
    marginTop: 12,
    backgroundColor: '#7c3aed',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  evolveBtnText: { fontSize: 15, fontWeight: '700', color: '#ffffff' },
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
  // 임시 테스트용 초기화 버튼(우하단, 눈에 띄게만). 나중에 제거 전제.
  resetBtn: {
    position: 'absolute',
    right: 16,
    bottom: 40,
    backgroundColor: 'rgba(185,28,28,0.9)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  resetBtnText: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  // 임시 뷰 토글 버튼(초기화 버튼 바로 위).
  viewToggleBtn: {
    position: 'absolute',
    right: 16,
    bottom: 80,
    backgroundColor: 'rgba(37,99,235,0.9)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  viewToggleBtnText: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  // 속성 선택 오버레이(화면 전체 반투명 막 + 중앙 카드).
  pickerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerTitle: { color: '#ffffff', fontSize: 18, fontWeight: '700', marginBottom: 16 },
  pickerRow: { flexDirection: 'row' },
  pickerOption: {
    width: 64,
    height: 64,
    borderRadius: 12,
    marginHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerOptionText: { color: '#ffffff', fontSize: 18, fontWeight: '700' },
  pickerCancel: { marginTop: 20, paddingHorizontal: 16, paddingVertical: 8 },
  pickerCancelText: { color: '#d1d5db', fontSize: 14 },
});
