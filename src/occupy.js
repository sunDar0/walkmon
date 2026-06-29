// 공유 점령 모듈. 포그라운드(React state)와 백그라운드(AsyncStorage)가
// 같은 점령/보상 규칙과 같은 저장 상태를 공유하도록 점령 로직을 순수 함수로 둔다.
// React 에 의존하지 않으므로 컴포넌트 밖(백그라운드 태스크)에서도 그대로 쓸 수 있다.

import { cellKeyAt } from './grid';
import { rollItem } from './items';
import {
  COOLDOWN_MS,
  NEW_CELL_XP,
  REVISIT_XP,
  NEW_CELL_POINTS,
  REVISIT_POINTS,
} from './game';

export const STORAGE_KEY = 'walkmon_state_v1';

// 저장본이 없거나 깨졌을 때의 기본 상태.
export const INITIAL_STATE = { occupied: {}, xp: 0, items: [] };

// 좌표 한 건을 받아 점령/보상을 판정한다. 기존 App.js handleCoords 와 결과가 동치다.
// 반환: { state, changed, currentKey }
//  - changed=false 면 보상이 없어 state 는 입력과 같은 참조를 그대로 돌려준다
//    (React setState 가 같은 참조를 받아 리렌더를 생략하도록).
export function applyVisit(state, coords, now) {
  const key = cellKeyAt(coords.latitude, coords.longitude);
  const cell = state.occupied[key];
  const isNew = !cell;
  const cooled = cell && now - cell.lastVisit > COOLDOWN_MS;

  // 재방문 + 쿨다운 미경과: 보상 없음(제자리 파밍 방지). 원본 state 그대로.
  if (!isNew && !cooled) {
    return { state, changed: false, currentKey: key };
  }

  const xp = state.xp + (isNew ? NEW_CELL_XP : REVISIT_XP);

  const item = rollItem(key);
  const items = item
    ? [{ item, key, t: now }, ...state.items].slice(0, 20)
    : state.items;

  const occupied = {
    ...state.occupied,
    [key]: {
      points: (cell?.points || 0) + (isNew ? NEW_CELL_POINTS : REVISIT_POINTS),
      lastVisit: now,
    },
  };

  return {
    state: { occupied, xp, items },
    changed: true,
    currentKey: key,
  };
}
