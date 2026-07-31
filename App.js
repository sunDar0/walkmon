import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  AppState,
  Pressable,
  Animated,
  Vibration,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';

import PixelHexMap, { latticeDiskKeys } from './src/PixelHexMap';
import CareRoom from './src/CareRoom';
import FullMap from './src/FullMap';

import { useLocation } from './src/useLocation';
import { cellKeyAt } from './src/grid';
import { cellTheme } from './src/items';
import {
  STAGES,
  STAGE_MAX_LEVEL,
  levelInStage,
  canEvolve,
  CARE_ACTIONS,
  CARE_AP_COST,
  TREAT_AP_COST,
  HEALTH_THRESHOLD,
} from './src/game';
import {
  STORAGE_KEY,
  STORAGE_KEY_V3,
  INITIAL_STATE,
  hydrate,
  tickState,
  applyPath,
  evolve,
  newGame,
  careAction,
  treat,
  previewCare,
} from './src/occupy';
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

// 미터 3종 표시 메타(게이지 순서·라벨·색). game.js 의 meters 키(satiety/happiness/cleanliness)와 1:1.
// 아이콘은 절차적 색(컬러 도트)로 표현 — 이모지는 시뮬레이터에서 tofu 로 떠 어디서나 확실히 렌더되는 색으로 간다.
const METER_META = [
  { key: 'satiety', label: '포만', color: '#f59e0b' },
  { key: 'happiness', label: '행복', color: '#ec4899' },
  { key: 'cleanliness', label: '청결', color: '#06b6d4' },
];
// 케어 프리뷰의 미터 델타를 짧은 한글 라벨로 표시하기 위한 룩업.
const METER_LABEL = { satiety: '포만', happiness: '행복', cleanliness: '청결' };
// 미터 낮음 신호(다마고치 신호등) 임계. 이하면 게이지/도트를 빨강 계열로.
const LOW_METER_RED = '#ef4444';
// 건강코드 문자열 -> 이모지(UI 표시 전용). game.js HEALTH_CODES 9종과 1:1.
// 코드 문자열 자체는 game-core SSOT(게임 로직·저장) 그대로 두고, 화면에만 이모지를 얹는다.
// iOS 26.1 에서 RN Text 컬러 이모지 렌더 확정(p35 실측). 배지/치료 칩(팝오버)에서 코드명과 함께 표시.
const HEALTH_EMOJI = {
  쇠약: '😫',
  어지럼: '😵',
  영양실조: '🦴',
  우울: '😢',
  외로움: '👤',
  무기력: '🛌',
  가려움: '🦟',
  악취: '🤢',
  질병: '🤒',
};
// 상단 케어 패널 높이 폴백(px). onLayout 측정 전 첫 프레임의 위쪽 슬라이드 거리·하단 패널 top 기준.
const CARE_TOP_FALLBACK = 320;
// 진화 CTA 알약 높이(evolveBtn: paddingVertical 10×2 + 텍스트 ≈ 44). 팝오버를 CTA 아래로 밀 때 쓴다.
const EVOLVE_CTA_H = 44;
// 상단바 아래 배치 기본 간격(px). 팝오버/진화 CTA 를 상단바 실측 하단에서 이만큼 띄운다.
const BELOW_BAR_GAP = 8;

export default function App() {
  // 하단 케어 패널(아래→위 슬라이드업)의 오프스크린 거리 계산용 화면 높이.
  const { height: winH } = useWindowDimensions();
  // 상단 케어 패널 실측 높이(px). onLayout 으로 재서 (1)위쪽 슬라이드 거리 (2)하단 패널 top(=방 아래 경계=결합선)을 잡는다.
  const [careTopH, setCareTopH] = useState(0);
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
  // 케어 시트(슬라이드업) 열림 여부. 평소엔 하단 단일 케어 FAB 만, 탭하면 시트가 올라온다.
  const [careOpen, setCareOpen] = useState(false);
  // 케어 버튼 쿨다운 카운트다운용 1초 클록. 시트 열림 동안만 돌아 버튼의 남은 시간을 갱신한다(닫히면 멈춤).
  const [careNow, setCareNow] = useState(() => Date.now());
  // 전역 AP 부스트 토글. ON 이면 케어 액션 = AP 소모·정상 XP, OFF 면 무AP·XP 1/3. AP 부족 시 자동 OFF.
  const [apBoost, setApBoost] = useState(false);
  // 건강코드 팝오버(상단바 경고 배지 탭) 표시 여부. 열리면 코드 칩(탭=개별 치료)을 보여준다.
  const [healthOpen, setHealthOpen] = useState(false);
  // 상단바 실측 하단 y(px). onLayout 으로 재서 팝오버·진화 CTA 를 상단바 아래에 상대 배치한다
  // (하드코딩 150 제거·무겹침). 측정 전 첫 프레임은 폴백(128) 사용.
  const [statusBarBottom, setStatusBarBottom] = useState(0);
  // 케어 손맛 연출 이벤트(④). 케어 성공 시 {action, at:now} 로 찍어 PixelHexMap 에 신호 -> 크리처 점프+하트/반짝.
  //  - joy 감정·파티클의 휘발성 소스(저장 안 함). 같은 액션 연타도 at 이 바뀌어 매번 재생된다.
  const [careEvent, setCareEvent] = useState(null);

  // 상단바 미터 게이지 "차오름" 애니메이션(④ 공통). 미터값(0~100)을 Animated.Value 로 두고 케어/tick 으로
  // 값이 바뀌면 부드럽게 보간(width %). 초기 100 에서 시작해 첫 로드 시 실측치로 정착한다.
  const meterAnims = useRef({
    satiety: new Animated.Value(100),
    happiness: new Animated.Value(100),
    cleanliness: new Animated.Value(100),
  }).current;

  // 케어 시트 슬라이드 애니메이션(0=닫힘/오프스크린, 1=열림). RN Animated 로 새 의존성 없이 처리.
  const careAnim = useRef(new Animated.Value(0)).current;
  const openCare = useCallback(() => {
    // 방 재열림 시 직전 careEvent 로 파티클이 다시 재생되지 않게 먼저 비운다(버그2).
    // 열린 상태에서 누른 케어는 doCare 가 새 {action,at} 을 찍어 정상 재생된다(연타 포함).
    setCareEvent(null);
    setCareOpen(true);
    Animated.timing(careAnim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  }, [careAnim]);
  const closeCare = useCallback(() => {
    Animated.timing(careAnim, { toValue: 0, duration: 180, useNativeDriver: true }).start(
      ({ finished }) => {
        if (finished) setCareOpen(false);
      },
    );
  }, [careAnim]);

  const loaded = useRef(false);
  const lastCoordsRef = useRef(null); // 직전 좌표(이동 방향 판정용)

  // 저장소에서 게임 상태를 읽어온다. v4 우선, 없으면 v3 저장본을 hydrate 로 마이그레이션(backfill).
  // 로드 직후 tick 으로 오프라인 경과(미터 감소·건강코드)를 즉시 정산한다. v3→v4 는 타임스탬프가
  // now 로 채워져 경과 0(미터 가득)에서 출발한다.
  // 반환: 'loaded'(저장본 반영) | 'empty'(저장본 없음=첫 실행) | 'error'(못 읽음).
  // 영속화 활성은 이 상태로 결정한다 — 'error' 면 켜지 않아 기존 바이트를 덮어쓰지 않는다.
  const loadGameState = useCallback(async () => {
    try {
      let raw = await AsyncStorage.getItem(STORAGE_KEY);
      let migratedFromV3 = false;
      if (!raw) {
        raw = await AsyncStorage.getItem(STORAGE_KEY_V3);
        migratedFromV3 = !!raw; // v4 없고 v3 를 읽었을 때만 마이그레이션.
      }
      if (!raw) return 'empty'; // 저장본 없음 = 정상 첫 실행(영속화 켜도 안전).
      const now = Date.now();
      const next = tickState(hydrate(JSON.parse(raw), now), now);
      setGameState(next);
      // v3→v4 마이그레이션이면 새 키로 먼저 저장한 뒤 옛 v3 키를 지워 죽은 데이터를 남기지 않는다.
      // v4 가 이미 있으면 v3 를 안 읽었으므로(migratedFromV3=false) 건드리지 않는다.
      if (migratedFromV3) {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        await AsyncStorage.removeItem(STORAGE_KEY_V3);
      }
      return 'loaded';
    } catch (e) {
      // 저장본을 못 읽었다(손상 파싱 실패·저장소 일시 오류). 이 상태로 영속화를 켜면 다음 setGameState 가
      // INITIAL_STATE 파생값을 기존 바이트 위에 덮어써 진행분이 사라진다. 'error' 로 이번 세션 영속화를
      // 막아 바이트를 보존한다 — 코드 수정·일시 오류 회복 뒤 다음 실행에서 복구할 여지를 남긴다.
      console.warn('[walkmon] 저장본 로드 실패 — 덮어쓰기 방지로 이번 세션 영속화 보류:', e);
      return 'error';
    }
  }, []);

  // 마운트 시 1회 로드. 로드가 error 가 아니면(정상 로드 또는 저장본 없음) 영속화를 켠다.
  useEffect(() => {
    (async () => {
      const status = await loadGameState();
      if (status !== 'error') loaded.current = true;
    })();
  }, [loadGameState]);

  // 상태 영속화 (첫 로드 전엔 건너뜀)
  useEffect(() => {
    if (!loaded.current) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(gameState)).catch(() => {});
  }, [gameState]);

  // 포그라운드 복귀 시 백그라운드 태스크가 저장소에 쌓아둔 누적분을 다시 로드해 화면에 반영.
  // loadGameState 가 로드 후 tick 하므로 백그라운드 동안의 미터 감소·건강코드도 함께 정산된다.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        // 마운트 때 로드 실패로 영속화가 꺼졌더라도, 복귀 시 정상 로드되면 그때 켠다(일시 오류 자가 회복).
        loadGameState().then((status) => {
          if (status !== 'error') loaded.current = true;
        });
      }
    });
    return () => sub.remove();
  }, [loadGameState]);

  // 포그라운드 유지 중 주기 tick(60s). 미터 감소·건강코드를 화면에서 실시간 반영한다.
  // 첫 로드 전(metersUpdatedAt=0)엔 tick 이 경과 0 으로 처리해 오작동하지 않는다.
  useEffect(() => {
    const id = setInterval(() => setGameState((s) => tickState(s, Date.now())), 60000);
    return () => clearInterval(id);
  }, []);

  // 마운트 시 백그라운드 위치 추적 시작(권한 요청 + 태스크 등록).
  // 실패하거나 거절돼도 포그라운드(useLocation)는 정상 동작해야 하므로 결과는 무시한다.
  useEffect(() => {
    registerBackgroundLocation().catch(() => {});
  }, []);

  // 개발 빌드 전용 상태 디버그 훅(expo-build-run 검증용). __DEV__ 가드라 프로덕션 번들엔 안 들어간다.
  // 시뮬레이터/디버거에서 global.__WALKMON__ 로 실제 상태 값(meters·ap·health·occupied 크기)을
  // 육안 상태 카드 없이 대조하는 통로. 웹/네이티브 모두 global 이 있어 안전. 읽기 전용 노출이라 게임 로직·렌더엔 영향 없음.
  useEffect(() => {
    if (!__DEV__) return;
    global.__WALKMON__ = {
      gameState,
      coords,
      currentKey,
      occupiedCount: Object.keys(gameState.occupied || {}).length,
    };
  }, [gameState, coords, currentKey]);

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

    // 함수형 업데이트로 stale 방지. v4 applyPath 는 내부 tickState 가 매 fix 새 상태 참조를 반환하므로
    // 보상이 없어도 매 fix 리렌더·영속화가 발생한다(p27 §3 이 수용한 비용 — v3 의 "같은 참조 스킵"은 폐기).
    // prev(직전 좌표, lastCoordsRef 를 덮기 전 값)를 넘겨, 위치 갱신 사이 건너뛴 칸까지 경로 보간으로 채운다.
    setGameState((s) => applyPath(s, prev, c, Date.now()).state);

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
    setGameState(newGame(petType, Date.now()));
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

  // 팝오버·진화 CTA 배치 기준 y. 상단바 실측 하단(폴백 128) 아래로 스택한다.
  //  - 진화 CTA: 상단바 바로 아래. 팝오버: 진화 CTA 가 떠 있으면 그 아래로 밀어 z-order 충돌(팝오버가 진화 버튼 덮음)을 없앤다.
  const barBottom = statusBarBottom || 128;
  const evolveTop = barBottom + BELOW_BAR_GAP;
  const popoverTop = barBottom + (evolvable ? EVOLVE_CTA_H + BELOW_BAR_GAP : 0) + BELOW_BAR_GAP;

  // 케어 UI 파생값(계약 p27 §7). meters/ap/health 는 hydrate 가 backfill 하므로 항상 존재하나 방어적 기본값을 둔다.
  const meters = gameState.meters || { satiety: 0, happiness: 0, cleanliness: 0 };
  const ap = gameState.ap || 0;
  const health = gameState.health || [];
  const boostAvailable = ap >= CARE_AP_COST; // AP 부스트 토글 가능 여부(AP 충분). 부족하면 토글 비활성.
  const canTreat = ap >= TREAT_AP_COST; // 치료 가능 여부(AP 필수)
  // 실제 적용되는 부스트: 토글 ON 이고 AP 충분할 때만. 이 값으로 careAction useAP 를 넘긴다.
  const effectiveBoost = apBoost && boostAvailable;
  // 단계 내 레벨 진행 게이지(레벨/만렙). 계약대로 stageXp 를 levelInStage/STAGE_MAX_LEVEL 로 표현.
  const xpPct = maxLevel > 0 ? Math.min(100, (level / maxLevel) * 100) : 0;

  // 머리 위 말풍선(③) 대상 미터: HEALTH_THRESHOLD(40) 아래인 것 중 "가장 낮은 하나"의 키(없으면 null).
  //  - 상단바 건강코드 배지(병)와 경계가 다른 신호(배고픔·심심·꼬질). health 유무와 독립으로 계산한다.
  //  - PixelHexMap 은 이 값을 말풍선(SpeechBubble)에만 쓴다(크리처 처짐은 sick 전용 -> 배고픔은 말풍선이 전담).
  const needMeter = useMemo(() => {
    let key = null;
    let lo = Infinity;
    for (const mm of METER_META) {
      const v = meters[mm.key] ?? 0;
      if (v < HEALTH_THRESHOLD && v < lo) {
        lo = v;
        key = mm.key;
      }
    }
    return key;
    // meters 개별 값만 deps(객체 참조 흔들림 방지).
  }, [meters.satiety, meters.happiness, meters.cleanliness]);

  // 미터 변동 -> 상단바 게이지 부드럽게 차오름/줄어듦(케어 손맛 ④의 공통 피드백). width %는 네이티브 드라이버 불가.
  useEffect(() => {
    for (const mm of METER_META) {
      Animated.timing(meterAnims[mm.key], {
        toValue: Math.round(meters[mm.key] ?? 0),
        duration: 500,
        useNativeDriver: false,
      }).start();
    }
  }, [meters.satiety, meters.happiness, meters.cleanliness, meterAnims]);

  // 케어 실행 + 즉각 손맛(④): 상태 적용 -> 연출 이벤트 신호 -> 짧은 진동(웹 no-op 가드). game-core 시그니처 그대로.
  const doCare = useCallback(
    (key) => {
      // 미터 만땅 또는 쿨다운 중이면 careAction 이 무보상으로 거부하므로, 손맛 연출(파티클·진동)도
      // 내지 않는다(없는 보상을 준 것처럼 안 보이게). 버튼은 흐림+"가득"/카운트다운으로 이미 신호.
      const p = previewCare(gameState, key, effectiveBoost, Date.now());
      if (p.wasted || p.cooldownRemainingMs > 0) return;
      setGameState((prev) => careAction(prev, key, effectiveBoost, Date.now()));
      setCareEvent({ action: key, at: Date.now() });
      if (Platform.OS !== 'web') Vibration.vibrate(15);
    },
    [effectiveBoost, gameState],
  );

  // 케어 시트 열림 동안만 1초 클록을 돌려 버튼 쿨다운 카운트다운을 갱신한다. 닫히면 인터벌 정리.
  useEffect(() => {
    if (!careOpen) return;
    setCareNow(Date.now());
    const id = setInterval(() => setCareNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [careOpen]);

  // AP 부족해지면 부스트 토글을 강제로 끈다(음수 AP·오해 방지). occupy.careAction 이 이미 방어하지만 UI 도 정합.
  useEffect(() => {
    if (!boostAvailable && apBoost) setApBoost(false);
  }, [boostAvailable, apBoost]);

  // 2패널 결합 애니메이션(같은 careAnim 소스, 반대 방향). 열림 시 상단은 위에서 아래로 펼쳐지고
  // 하단은 아래에서 위로 올라와 방 아래 경계에서 맞붙는다. 둘 다 useNativeDriver(translateY) 로 처리.
  const careTopTranslate = careAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-(careTopH || CARE_TOP_FALLBACK), 0], // 위로 접힘(자기 높이만큼 위로) -> 제자리
  });
  const careBottomTranslate = careAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [winH, 0], // 화면 아래로 완전히 내려가 있다 -> 제자리로 슬라이드업
  });

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
          health={gameState.health}
          needMeter={needMeter}
        />
      ) : (
        <FullMap occupiedKeys={Object.keys(gameState.occupied)} />
      )}

      {/* 상단 얇은 상태 표시줄(기존 큰 카드 대체). 화면 최상단 가장자리에 붙어 캐릭터를 안 가린다.
          1행: 단계·Lv + XP 진행 바 + AP pill. 2행: 미터 3종 아이콘+게이지(낮으면 신호등 빨강). */}
      {activeView === 'play' && !careOpen && (
        <View
          style={styles.statusBar}
          pointerEvents="box-none"
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout;
            setStatusBarBottom(y + height);
          }}
        >
          <View style={styles.statusRow1}>
            <View style={styles.statusStageWrap}>
              <Text style={styles.statusStage}>
                {stage} · Lv.{level}/{maxLevel}
              </Text>
              <View style={styles.xpTrack}>
                <View style={[styles.xpFill, { width: `${xpPct}%` }]} />
              </View>
            </View>
            <View style={styles.apPill}>
              <Text style={styles.apPillText}>AP {ap}</Text>
            </View>
          </View>

          {/* 미터 3종: 아이콘 + 짧은 게이지 한 줄. 값 < HEALTH_THRESHOLD 면 빨강(다마고치 신호등). */}
          <View style={styles.meterRow}>
            {METER_META.map((mm) => {
              const v = Math.round(meters[mm.key] ?? 0);
              const low = v < HEALTH_THRESHOLD;
              return (
                <View key={mm.key} style={styles.meterItem}>
                  <View
                    style={[styles.meterDot, { backgroundColor: low ? LOW_METER_RED : mm.color }]}
                  />
                  <View style={styles.mTrack}>
                    <Animated.View
                      style={[
                        styles.mFill,
                        {
                          width: meterAnims[mm.key].interpolate({
                            inputRange: [0, 100],
                            outputRange: ['0%', '100%'],
                            extrapolate: 'clamp',
                          }),
                          backgroundColor: low ? LOW_METER_RED : mm.color,
                        },
                      ]}
                    />
                  </View>
                </View>
              );
            })}
            {/* 활성 건강코드 경고 배지(있을 때만). 탭 → 아래 팝오버에서 개별 치료. */}
            {health.length > 0 && (
              <Pressable
                style={styles.healthBadge}
                onPress={() => setHealthOpen((o) => !o)}
              >
                <Text style={styles.healthBadgeText}>
                  {HEALTH_EMOJI[health[0]] || '!'} {health.length}
                </Text>
              </Pressable>
            )}
          </View>

          {/* 지역명만 아주 작게(점령 칸수는 정보 과부하라 제거). 위치 이상 시에만 경고. */}
          <View style={styles.statusFooter}>
            {currentKey ? (
              <Text style={styles.regionText}>{cellTheme(currentKey)}</Text>
            ) : (
              <Text style={styles.regionText}>위치 확인 중…</Text>
            )}
            {status !== 'tracking' && <Text style={styles.warn}>위치: {status}</Text>}
          </View>
        </View>
      )}

      {/* 건강코드 팝오버(배지 탭 시). 코드 칩 탭 = 개별 치료(AP 필수). 상단바 아래에 뜬다. */}
      {activeView === 'play' && healthOpen && health.length > 0 && (
        <View style={[styles.healthPopover, { top: popoverTop }]}>
          <Text style={styles.healthPopoverTitle}>
            {canTreat ? `칩 탭 = 치료 (AP -${TREAT_AP_COST})` : `치료하려면 AP ${TREAT_AP_COST} 필요`}
          </Text>
          <View style={styles.chipRow}>
            {health.map((code, i) => (
              <Pressable
                key={`${code}-${i}`}
                style={[styles.chip, !canTreat && styles.chipDisabled]}
                disabled={!canTreat}
                onPress={() => setGameState((prev) => treat(prev, code, Date.now()))}
              >
                <Text style={styles.chipText}>
                  {HEALTH_EMOJI[code] || ''} {code}
                  {canTreat ? ' ✕' : ''}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* 진화 CTA: canEvolve 참일 때만 뜨는 상황형 버튼(상단바 아래 중앙, 평소 숨김). */}
      {activeView === 'play' && evolvable && (
        <View style={[styles.evolveWrap, { top: evolveTop }]} pointerEvents="box-none">
          <Pressable
            style={styles.evolveBtn}
            onPress={() => setGameState((prev) => evolve(prev, Date.now()))}
          >
            <Text style={styles.evolveBtnText}>✦ 진화하기</Text>
          </Pressable>
        </View>
      )}

      {/* 하단 우측 단일 케어 FAB(플레이 뷰). 평소엔 이 버튼 하나만. 탭 → 케어 시트 슬라이드업. */}
      {activeView === 'play' && !careOpen && (
        <Pressable style={styles.careFab} onPress={openCare}>
          <Text style={styles.careFabText}>케어</Text>
        </Pressable>
      )}

      {/* 케어 화면 = 위·아래 두 패널이 방 아래 경계에서 맞붙는 결합 구조.
          상단 패널: 얇은 상태바가 아래로 확장(미터 3종 + 정육면체 방). 하단 패널: 케어 7액션(+ AP 부스트) 슬라이드업.
          두 패널은 careAnim 한 소스로 위/아래 반대 방향에서 와 결합한다. 백드롭은 결합 전(슬라이드 중) 뒤 화면을 덮는다. */}
      {careOpen && (
        <Animated.View pointerEvents="none" style={[styles.backdrop, { opacity: careAnim }]} />
      )}

      {/* 상단 패널: 화면 최상단에 앵커, 자기 높이만큼 위→아래로 펼쳐짐. onLayout 높이 = 하단 패널 결합선. */}
      {careOpen && (
        <Animated.View
          style={[styles.careTopPanel, { transform: [{ translateY: careTopTranslate }] }]}
          onLayout={(e) => setCareTopH(e.nativeEvent.layout.height)}
        >
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>돌봄 방</Text>
            <View style={styles.sheetHeaderRight}>
              <View style={styles.apPill}>
                <Text style={styles.apPillText}>AP {ap}</Text>
              </View>
              <Pressable style={styles.closeBtn} onPress={closeCare}>
                <Text style={styles.closeBtnText}>✕</Text>
              </Pressable>
            </View>
          </View>

          {/* 미터 3종 확장(라벨 + 게이지 + %). 값<40 이면 신호등 빨강(상단바와 동일 규칙). */}
          <View style={styles.roomMeters}>
            {METER_META.map((mm) => {
              const v = Math.round(meters[mm.key] ?? 0);
              const low = v < HEALTH_THRESHOLD;
              const col = low ? LOW_METER_RED : mm.color;
              return (
                <View key={mm.key} style={styles.roomMeterRow}>
                  <Text style={styles.roomMeterLabel}>{mm.label}</Text>
                  <View style={styles.roomMeterTrack}>
                    <Animated.View
                      style={[
                        styles.roomMeterFill,
                        {
                          width: meterAnims[mm.key].interpolate({
                            inputRange: [0, 100],
                            outputRange: ['0%', '100%'],
                            extrapolate: 'clamp',
                          }),
                          backgroundColor: col,
                        },
                      ]}
                    />
                  </View>
                  <Text style={[styles.roomMeterPct, { color: col }]}>{v}%</Text>
                </View>
              );
            })}
          </View>

          {/* 방은 상단 패널에 속한다. 절차적 정육면체 내부 + 크리처 산책(웹은 CareRoom.web=null). */}
          <View style={styles.roomWrap}>
            <CareRoom
              stage={stage}
              petType={gameState.petType}
              sad={health.length > 0}
              careEvent={careEvent}
            />
          </View>
        </Animated.View>
      )}

      {/* 하단 패널: 상단 패널 아래 경계(careTopH)에서 시작해 화면 하단까지. 아래→위 슬라이드업으로 상단과 결합. */}
      {careOpen && (
        <Animated.View
          style={[
            styles.careBottomPanel,
            { top: careTopH || CARE_TOP_FALLBACK, transform: [{ translateY: careBottomTranslate }] },
          ]}
        >
          <View style={styles.sheetHandle} />

          {/* AP 부스트 토글: ON 이면 AP 소모·정상 XP, OFF 면 무AP·XP 1/3. */}
          <View style={styles.boostRow}>
            <Pressable
              style={[
                styles.boostToggle,
                effectiveBoost && styles.boostToggleOn,
                !boostAvailable && styles.boostToggleDisabled,
              ]}
              disabled={!boostAvailable}
              onPress={() => setApBoost((b) => !b)}
            >
              <Text style={[styles.boostToggleText, effectiveBoost && styles.boostToggleTextOn]}>
                AP 부스트 {effectiveBoost ? 'ON' : 'OFF'}
              </Text>
            </Pressable>
          </View>

          {/* 케어 7액션(기능 그대로) */}
          <View style={styles.careGrid}>
            {Object.keys(CARE_ACTIONS).map((key) => {
              const def = CARE_ACTIONS[key];
              // 프리뷰 XP 는 현재 부스트 상태 기준(effectiveBoost). ON 이면 정상, OFF 면 1/3.
              // 거부 상태(만땅=wasted / 쿨다운=cooldownRemainingMs)면 버튼을 흐림 처리하고 라벨을
              // "가득" 또는 남은 시간으로 바꿔 정직하게 신호. careNow(1초 클록)로 카운트다운 갱신.
              const preview = previewCare(gameState, key, effectiveBoost, careNow);
              const xp = preview.xp;
              const cooling = preview.cooldownRemainingMs > 0;
              const blocked = preview.wasted || cooling;
              const coolSec = Math.ceil(preview.cooldownRemainingMs / 1000);
              const meterStr = Object.entries(def.meters)
                .map(([m, dv]) => `${METER_LABEL[m]}+${dv}`)
                .join(' ');
              // 아이콘 대체: 액션의 주 미터 색 도트(절차적 색). 먹이·간식=주황, 쓰다듬·놀기=분홍, 씻기·청소·똥=청록.
              const primaryMeter = Object.keys(def.meters)[0];
              const dotColor =
                (METER_META.find((m) => m.key === primaryMeter) || {}).color || '#9ca3af';
              return (
                <Pressable
                  key={key}
                  style={[styles.careCard, blocked && styles.careCardWasted]}
                  onPress={() => doCare(key)}
                >
                  <View style={[styles.careDot, { backgroundColor: dotColor }]} />
                  <Text style={styles.careLabel}>{def.label}</Text>
                  <Text style={styles.careMeter}>{meterStr}</Text>
                  <Text style={styles.careXp}>
                    {preview.wasted
                      ? '가득'
                      : cooling
                        ? coolSec >= 60
                          ? `${Math.ceil(coolSec / 60)}분`
                          : `${coolSec}초`
                        : `+${xp} XP`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Animated.View>
      )}

      {/* 유틸(코너 정리): 좌하단 지도 토글 + 그 위 작은 초기화. 매직넘버 offset 제거, 시트/FAB 와 무겹침.
          케어 시트가 열리면 시트 위로 뜨지 않게 숨긴다. */}
      {!careOpen && (
        <>
          <Pressable style={styles.resetBtn} onPress={() => setPickerOpen(true)} hitSlop={8}>
            <Text style={styles.resetBtnText}>초기화</Text>
          </Pressable>
          <Pressable
            style={styles.mapBtn}
            onPress={() => setActiveView((v) => (v === 'play' ? 'map' : 'play'))}
          >
            <Text style={styles.mapBtnText}>{activeView === 'play' ? '지도' : '플레이'}</Text>
          </Pressable>
        </>
      )}

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
  // --- 상단 얇은 상태 표시줄(최상단 가장자리) ---
  statusBar: {
    position: 'absolute',
    top: 52,
    left: 8,
    right: 8,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 3,
  },
  statusRow1: { flexDirection: 'row', alignItems: 'center' },
  statusStageWrap: { flex: 1 },
  statusStage: { fontSize: 15, fontWeight: '700', color: '#111827' },
  xpTrack: {
    height: 5,
    backgroundColor: '#e5e7eb',
    borderRadius: 3,
    marginTop: 4,
    overflow: 'hidden',
  },
  xpFill: { height: '100%', backgroundColor: '#7c3aed', borderRadius: 3 },
  apPill: {
    backgroundColor: '#eef2ff',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginLeft: 10,
  },
  apPillText: { fontSize: 13, fontWeight: '700', color: '#3730a3' },
  // 미터 3종 한 줄(아이콘 + 짧은 게이지). 낮으면 fill 이 빨강(신호등).
  meterRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  meterItem: { flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 8 },
  meterDot: { width: 9, height: 9, borderRadius: 5, marginRight: 5 },
  mTrack: {
    flex: 1,
    height: 7,
    backgroundColor: '#e5e7eb',
    borderRadius: 4,
    overflow: 'hidden',
  },
  mFill: { height: '100%', borderRadius: 4 },
  healthBadge: {
    backgroundColor: '#fee2e2',
    borderColor: '#ef4444',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 2,
  },
  healthBadgeText: { fontSize: 11, color: '#b91c1c', fontWeight: '700' },
  statusFooter: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  regionText: { fontSize: 11, color: '#6b7280' },
  warn: { fontSize: 11, color: '#b91c1c', marginLeft: 8 },
  // --- 건강코드 팝오버(배지 탭) ---
  healthPopover: {
    position: 'absolute',
    left: 8,
    right: 8,
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderRadius: 12,
    padding: 10,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  healthPopoverTitle: { fontSize: 12, color: '#374151', marginBottom: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    backgroundColor: '#fee2e2',
    borderColor: '#ef4444',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginRight: 6,
    marginBottom: 6,
  },
  chipDisabled: { backgroundColor: '#f3f4f6', borderColor: '#d1d5db' },
  chipText: { fontSize: 12, color: '#b91c1c', fontWeight: '600' },
  // --- 진화 CTA(상단바 아래 중앙, canEvolve 일 때만) ---
  evolveWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  evolveBtn: {
    backgroundColor: '#7c3aed',
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
  },
  evolveBtnText: { fontSize: 15, fontWeight: '700', color: '#ffffff' },
  // --- 하단 우측 단일 케어 FAB ---
  careFab: {
    position: 'absolute',
    right: 16,
    bottom: 28,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#7c3aed',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
  careFabText: { fontSize: 16, color: '#ffffff', fontWeight: '800' },
  // --- 케어 2패널 결합(상단 확장 + 하단 슬라이드업) ---
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  // 상단 패널: 최상단 앵커, 위→아래로 펼쳐짐. 방 아래 경계까지가 이 패널(높이 = 결합선).
  // 반투명 흰(0.96)으로 뒤 dim 백드롭이 외곽 라운드 모서리에서 비쳐 "떠 있는 카드"로 읽힌다.
  // 위쪽 모서리만 라운드(아래 = 하단 패널과 맞붙는 이음새라 각짐 유지). 그림자는 상단 패널에만(단일,
  // 이음새 이중 그림자 방지). 하단 패널은 같은 톤 배경으로 이어붙어 하나의 카드가 된다.
  careTopPanel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 52,
    paddingHorizontal: 16,
    paddingBottom: 12,
    zIndex: 20,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 8,
  },
  // 하단 패널: 결합선(top=careTopH)에서 화면 하단까지. 아래→위 슬라이드업.
  // 상단과 같은 반투명 톤 + 아래쪽 모서리만 라운드(위 = 이음새라 각짐). 그림자 없음(이음새 이중 그림자 방지).
  careBottomPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 28,
    zIndex: 20,
  },
  boostRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 10 },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d1d5db',
    alignSelf: 'center',
    marginBottom: 10,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  sheetHeaderRight: { flexDirection: 'row', alignItems: 'center' },
  boostToggle: {
    backgroundColor: '#e5e7eb',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
  },
  boostToggleOn: { backgroundColor: '#7c3aed' },
  boostToggleDisabled: { backgroundColor: '#f3f4f6' },
  boostToggleText: { fontSize: 12, fontWeight: '700', color: '#374151' },
  boostToggleTextOn: { color: '#ffffff' },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: { fontSize: 15, color: '#6b7280', fontWeight: '700' },
  // --- 돌봄 방: 상단 패널 미터 확장 + 방 ---
  roomMeters: { marginBottom: 10 },
  roomMeterRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  roomMeterLabel: { width: 40, fontSize: 13, fontWeight: '700', color: '#374151' },
  roomMeterTrack: {
    flex: 1,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#e5e7eb',
    overflow: 'hidden',
    marginHorizontal: 8,
  },
  roomMeterFill: { height: '100%', borderRadius: 5 },
  roomMeterPct: { width: 40, fontSize: 12, fontWeight: '700', textAlign: 'right' },
  roomWrap: {
    height: 150,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#cbb98d',
  },
  careGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  careCard: {
    width: '22%',
    marginHorizontal: '1.5%',
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    paddingVertical: 12,
    marginBottom: 10,
    alignItems: 'center',
  },
  careDot: { width: 22, height: 22, borderRadius: 11, marginBottom: 2 },
  careLabel: { fontSize: 13, fontWeight: '700', color: '#111827', marginTop: 4 },
  careMeter: { fontSize: 11, color: '#6b7280', marginTop: 2, textAlign: 'center' },
  careXp: { fontSize: 11, color: '#7c3aed', fontWeight: '700', marginTop: 2 },
  careCardWasted: { opacity: 0.4 }, // 거부 상태(미터 만땅/쿨다운): 눌러도 무보상이라 흐리게
  // --- 유틸(좌하단 코너): 지도 토글 + 그 위 작은 초기화 ---
  resetBtn: {
    position: 'absolute',
    left: 16,
    bottom: 90,
    backgroundColor: 'rgba(107,114,128,0.75)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  resetBtnText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  mapBtn: {
    position: 'absolute',
    left: 16,
    bottom: 28,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(37,99,235,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 5,
  },
  mapBtnText: { fontSize: 13, color: '#ffffff', fontWeight: '700' },
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
