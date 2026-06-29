import React from 'react';
import { StyleSheet } from 'react-native';
import MapView, { Polygon } from 'react-native-maps';

// 네이티브(안드로이드/iOS) 전용 지도. S2 셀을 폴리곤으로 오버레이합니다.
// 웹에서는 react-native-maps가 동작하지 않으므로 GameMap.web.js가 대신 로드됩니다.
export default function GameMap({ coords, gridCells, occupied, currentKey }) {
  return (
    <MapView
      style={StyleSheet.absoluteFill}
      showsUserLocation
      followsUserLocation
      initialRegion={
        coords
          ? {
              latitude: coords.latitude,
              longitude: coords.longitude,
              latitudeDelta: 0.01,
              longitudeDelta: 0.01,
            }
          : undefined
      }
    >
      {gridCells.map((c) => {
        const occ = occupied[c.key];
        const isCurrent = c.key === currentKey;
        return (
          <Polygon
            key={c.key}
            coordinates={c.corners}
            strokeColor={isCurrent ? '#1d4ed8' : 'rgba(0,0,0,0.25)'}
            strokeWidth={isCurrent ? 2 : 1}
            fillColor={occ ? 'rgba(34,197,94,0.35)' : 'rgba(0,0,0,0.03)'}
          />
        );
      })}
    </MapView>
  );
}
