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
  STAGE_MAX_LEVEL,
  XP_PER_LEVEL,
  canEvolve,
} from './game';

// 성장 상태 shape 변경(xp → stageIndex/stageXp)으로 옛 저장본은 호환 안 됨.
// 키 버전을 v3 로 올려 기존 저장분을 자연히 무시(빈 상태로 시작=초기화)한다.
export const STORAGE_KEY = 'walkmon_state_v3';

// 저장본이 없거나 깨졌을 때의 기본 상태.
// petType(0~3, 0=불/1=물/2=땅/3=풀)은 외형 전용 — XP·점령·쿨다운·진화 규칙에 영향 없음.
// 옛 저장본(petType 없음)은 App.js 로드의 { ...INITIAL_STATE, ...저장본 } 병합으로 0 이 자동 채워진다.
export const INITIAL_STATE = { occupied: {}, stageIndex: 0, stageXp: 0, items: [], petType: 0 };

// 새 게임(초기화) 순수 함수. 진행 상태를 전부 비우고 선택한 속성으로 알 단계(Lv.0)에서 시작한다.
// reveal 집합 같은 세션 시야 상태는 이 함수 밖(App.js)에서 함께 리셋한다.
export function newGame(petType) {
  return { occupied: {}, stageIndex: 0, stageXp: 0, items: [], petType };
}

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

  // XP 는 이제 현재 단계 누적(stageXp)에 쌓인다. stageIndex 는 여기서 건드리지 않는다(진화는 evolve 전용).
  const stageXp = state.stageXp + (isNew ? NEW_CELL_XP : REVISIT_XP);

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
    // petType 은 외형 전용이라 방문/보상에서 변하지 않는다. 새 state 객체에도 그대로 실어 유실을 막는다.
    state: { occupied, stageIndex: state.stageIndex, stageXp, items, petType: state.petType },
    changed: true,
    currentKey: key,
  };
}

// 수동 진화(순수 함수). canEvolve 면 다음 단계로 올리고, 옛 단계 만렙만큼의 XP 를 차감해 초과분을 이월한다.
// 진화 불가면 입력 state 를 그대로 돌려준다. React 비의존 — 포그라운드·백그라운드 공유 규약.
export function evolve(state) {
  if (!canEvolve(state.stageXp, state.stageIndex)) return state;
  return {
    ...state,
    stageIndex: state.stageIndex + 1,
    stageXp: state.stageXp - STAGE_MAX_LEVEL[state.stageIndex] * XP_PER_LEVEL,
  };
}
