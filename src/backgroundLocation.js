// [선택] 백그라운드 위치 추적 — "주머니에 넣고 걸어도 누적" 기능.
// 개발 빌드에서만 동작하며, app.json의 백그라운드 권한 설정이 필요합니다.
// MVP가 검증된 뒤에 붙이세요. 붙이는 순서:
//   1) 앱 시작 시 registerBackgroundLocation() 호출
//   2) onLocation 콜백에서 좌표를 받아 점령 로직을 저장소(예: AsyncStorage/SQLite)에 기록
//   3) 앱이 포그라운드로 돌아오면 저장된 누적분을 화면에 반영
//
// 주의: 포그라운드 추적(useLocation)과 동시에 켜면 두 writer 가 같은 저장 키를 각자
//       read-modify-write 해 lost update 가 난다. 그래서 태스크는 앱이 포그라운드 active 인
//       동안엔 이번 배치를 skip 해 단일 writer 를 보장한다(아래 AppState 가드 참고).

import { AppState } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { STORAGE_KEY, STORAGE_KEY_V3, hydrate, applyPath } from './occupy';

const TASK_NAME = 'walkmon-bg-location';

TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
  if (error) return;
  const { locations } = data || {};
  if (!locations || locations.length === 0) return;

  // 단일 writer 보장: 앱이 포그라운드 active 인 동안엔 포그라운드(useLocation→App)가 같은 좌표를
  // 이미 처리·저장한다. 백그라운드가 여기서 또 read-modify-write 하면 두 복사본이 갈라져
  // lost update(AP·미터 감소분 유실)가 나므로 active 면 이번 배치를 통째로 skip 한다(손실 아님).
  // fail-safe: 'active' 로 명시될 때만 skip. 'background'/'inactive'/'unknown'(헤드리스 콜드
  // 런치 포함)은 포그라운드가 살아있지 않다는 뜻이라 처리·저장해 백그라운드 추적을 지킨다.
  if (AppState.currentState === 'active') return;

  // React 밖이라 state 가 없다 → 저장소에서 읽어 applyPath 로 누적 후 다시 저장(이제 단일 writer).
  try {
    // v4 우선, 없으면 v3 저장본을 hydrate 로 마이그레이션(포그라운드 로드와 동일 규칙).
    let raw = await AsyncStorage.getItem(STORAGE_KEY);
    let loadedFromV3 = false;
    if (!raw) {
      raw = await AsyncStorage.getItem(STORAGE_KEY_V3);
      loadedFromV3 = !!raw;
    }
    const now = Date.now();
    let state = hydrate(raw ? JSON.parse(raw) : {}, now);
    // 배치 내 연속 좌표 사이를 applyPath 로 경로 보간(건너뛴 칸 채움). prev 는 배치 안에서만 이어지고,
    // 배치 경계(직전 태스크 실행의 마지막 좌표 → 이번 배치 첫 좌표)는 채우지 않는다 — 그 좌표를 이으려면
    // 상태에 좌표를 남겨야 해 shape 변경 비용이 크므로, 배치 내 채우기까지만 한다(한계로 명시).
    let prev = null;
    for (const loc of locations) {
      state = applyPath(state, prev, loc.coords, now).state;
      prev = loc.coords;
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // v3 를 읽어 v4 로 옮겼으면(v4 부재) 죽은 v3 키 제거. v4 가 이미 있었으면 v3 는 안 건드림.
    if (loadedFromV3) await AsyncStorage.removeItem(STORAGE_KEY_V3);
  } catch {}
});

export async function registerBackgroundLocation() {
  const { status: fg } = await Location.requestForegroundPermissionsAsync();
  if (fg !== 'granted') return false;
  const { status: bg } = await Location.requestBackgroundPermissionsAsync();
  if (bg !== 'granted') return false;

  const already = await Location.hasStartedLocationUpdatesAsync(TASK_NAME);
  if (already) return true;

  await Location.startLocationUpdatesAsync(TASK_NAME, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 25, // 배터리 절약: 25m마다
    deferredUpdatesInterval: 10000,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'WalkMon',
      notificationBody: '이동을 따라 지역을 점령하는 중...',
    },
  });
  return true;
}

export async function stopBackgroundLocation() {
  const running = await Location.hasStartedLocationUpdatesAsync(TASK_NAME);
  if (running) await Location.stopLocationUpdatesAsync(TASK_NAME);
}
