// [선택] 백그라운드 위치 추적 — "주머니에 넣고 걸어도 누적" 기능.
// 개발 빌드에서만 동작하며, app.json의 백그라운드 권한 설정이 필요합니다.
// MVP가 검증된 뒤에 붙이세요. 붙이는 순서:
//   1) 앱 시작 시 registerBackgroundLocation() 호출
//   2) onLocation 콜백에서 좌표를 받아 점령 로직을 저장소(예: AsyncStorage/SQLite)에 기록
//   3) 앱이 포그라운드로 돌아오면 저장된 누적분을 화면에 반영
//
// 주의: 포그라운드 추적(useLocation)과 동시에 켜면 보상이 중복될 수 있으니,
//       점령 처리는 한쪽(셀 키 + lastVisit 쿨다운)에서 멱등하게 처리하세요.

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { STORAGE_KEY, INITIAL_STATE, applyVisit } from './occupy';

const TASK_NAME = 'walkmon-bg-location';

TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
  if (error) return;
  const { locations } = data || {};
  if (!locations || locations.length === 0) return;

  // React 밖이라 state 가 없다 → 저장소에서 읽어 occupy.js 의 applyVisit 로 누적 후 다시 저장.
  // 포그라운드와 같은 STORAGE_KEY/규칙을 공유하므로 쿨다운으로 중복 보상이 멱등하게 막힌다.
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    let state = raw ? { ...INITIAL_STATE, ...JSON.parse(raw) } : INITIAL_STATE;
    const now = Date.now();
    for (const loc of locations) {
      state = applyVisit(state, loc.coords, now).state;
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
