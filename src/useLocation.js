import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';

// 포그라운드 위치 추적. 앱이 화면에 떠 있는 동안 좌표가 갱신될 때마다 onUpdate(coords)를 호출합니다.
// 백그라운드(주머니에 넣고 걷기)는 src/backgroundLocation.js 참고.
export function useLocation(onUpdate) {
  const [status, setStatus] = useState('idle'); // idle | denied | tracking
  const subRef = useRef(null);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const { status: fg } = await Location.requestForegroundPermissionsAsync();
      if (fg !== 'granted') {
        if (mounted) setStatus('denied');
        return;
      }
      if (mounted) setStatus('tracking');

      subRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          distanceInterval: 10, // 10m 이동마다
          timeInterval: 3000, // 또는 3초마다
        },
        (loc) => {
          if (mounted) onUpdate(loc.coords);
        }
      );
    })();

    return () => {
      mounted = false;
      if (subRef.current) subRef.current.remove();
    };
  }, []);

  return status;
}
