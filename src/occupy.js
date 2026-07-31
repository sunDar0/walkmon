// 공유 게임 상태 모듈. 포그라운드(React state)와 백그라운드(AsyncStorage)가
// 같은 규칙과 같은 저장 상태를 공유하도록 상태 전이를 순수 함수로 둔다.
// React 에 의존하지 않으므로 컴포넌트 밖(백그라운드 태스크)에서도 그대로 쓸 수 있다.
//
// 성장 모델(p26 케어 기반): 이동 → AP 적립 → 케어 액션(AP 부스트) → 크리처 XP → 진화.
//  - applyPath: 이동으로 AP 를 적립(포그·백 공유). 미터팩터(방치 페널티)를 위해 내부에서 tick 한다.
//  - tickState: 시간 경과로 미터 감소 + 건강코드 판정. 순수(now 주입).
//  - careAction/treat: 케어·치료(포그라운드 UI 전용).

import { cellKeyAt, pathKeys, coordDistanceM } from './grid';
import { rollItem, hashStr } from './items';
import {
  COOLDOWN_MS,
  AP_NEW,
  AP_REVISIT,
  NEW_CELL_POINTS,
  REVISIT_POINTS,
  PATH_FILL_MAX_M,
  STAGES,
  STAGE_MAX_LEVEL,
  XP_PER_LEVEL,
  PET_TYPE_COUNT,
  HEALTH_CODES,
  CARE_ACTIONS,
  CARE_AP_COST,
  CARE_COOLDOWN_MS,
  TREAT_AP_COST,
  canEvolve,
  meterFactor,
  decayMeters,
  targetStacks,
} from './game';

// 케어 성장 모델로 상태 shape 이 확장돼(ap·meters·health·타임스탬프) 옛 저장본과 shape 이 다르다.
// 키를 v4 로 올리되, v3 저장본은 hydrate 로 backfill 해 진행분(occupied·stage)을 이어받는다(마이그레이션).
export const STORAGE_KEY = 'walkmon_state_v4';
export const STORAGE_KEY_V3 = 'walkmon_state_v3';

// 저장본이 없거나 깨졌을 때의 기본 상태.
// petType(0~3)은 외형 전용 — 성장 규칙에 영향 없음. 타임스탬프 0 은 "미설정" 센티널로,
// hydrate/newGame 이 로드 시각(now)으로 채운다(정적 상수라 여기 now 를 박을 수 없다).
export const INITIAL_STATE = {
  occupied: {},
  stageIndex: 0,
  stageXp: 0,
  items: [],
  petType: 0,
  ap: 0,
  meters: { satiety: 100, happiness: 100, cleanliness: 100 },
  health: [],
  careAt: {}, // 액션별 마지막 케어 시각(쿨다운 판정). action -> ms 타임스탬프.
  bornAt: 0,
  stageStartedAt: 0,
  metersUpdatedAt: 0,
};

// 새 게임(초기화) 순수 함수. 진행 상태를 전부 비우고 선택 속성으로 알 단계에서 시작한다.
// 타임스탬프는 now 로 박아 "지금부터 나이 0·미터 가득"에서 출발한다.
export function newGame(petType, now) {
  return {
    occupied: {},
    stageIndex: 0,
    stageXp: 0,
    items: [],
    petType,
    ap: 0,
    meters: { satiety: 100, happiness: 100, cleanliness: 100 },
    health: [],
    careAt: {},
    bornAt: now,
    stageStartedAt: now,
    metersUpdatedAt: now,
  };
}

// 저장본(파싱된 객체)을 v4 shape 으로 정규화한다. 로드·마이그레이션의 단일 출처.
//  - 누락 필드는 INITIAL_STATE 기본값으로 메운다(v3→v4 backfill: ap0·meters100·health[]).
//  - 타임스탬프가 없거나(구버전) 0 이면 now 로 채운다. v4 저장본의 실제 타임스탬프는 보존
//    (0 이 아니므로) → 이후 tick 이 오프라인 경과를 정산한다.
// 케어 쿨다운 맵 정규화: 객체가 아니면 {}, 값이 유한수 아니면 그 키를 버린다.
function sanitizeCareAt(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const k in raw) if (Number.isFinite(raw[k])) out[k] = raw[k];
  return out;
}

export function hydrate(parsed, now) {
  const p = parsed || {};
  const pm = p.meters || {};
  // 손상·조작 저장본 방어: 미터 3값·ap 가 유한 숫자가 아니면(null·NaN·문자열) 기본값으로.
  // typeof NaN === 'number' 라 옛 typeof 검사는 NaN 을 통과시켰다 → decayMeters→meterFactor→
  // round(NaN) 로 ap 까지 오염. Number.isFinite 로 걸러 오염 전파를 막는다.
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  // 배열 인덱스로 쓰이는 필드(stageIndex→STAGES, petType→스프라이트 행)는 범위를 벗어나면
  // STAGES[i] undefined 크래시나 빈 크리처(스프라이트 프레임 없음)를 낳는다. 손상·조작 저장본을
  // 유효 정수 범위로 클램프해 렌더·성장이 깨지지 않게 한다.
  const clampInt = (v, lo, hi, d) => {
    const n = Math.floor(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
  };
  const dm = INITIAL_STATE.meters;
  return {
    ...INITIAL_STATE,
    ...p,
    stageIndex: clampInt(p.stageIndex, 0, STAGES.length - 1, 0),
    stageXp: Math.max(0, num(p.stageXp, 0)),
    petType: clampInt(p.petType, 0, PET_TYPE_COUNT - 1, 0),
    meters: {
      satiety: num(pm.satiety, dm.satiety),
      happiness: num(pm.happiness, dm.happiness),
      cleanliness: num(pm.cleanliness, dm.cleanliness),
    },
    health: Array.isArray(p.health) ? p.health : [],
    ap: num(p.ap, 0),
    // 케어 쿨다운 타임스탬프 맵. 손상 저장본이 문자열·NaN 을 넣으면 now-값=NaN 으로 버튼이
    // 영구 잠기므로, 객체가 아니거나 유한수 아닌 값은 버린다(옛 저장본엔 아예 없어 {} backfill).
    careAt: sanitizeCareAt(p.careAt),
    bornAt: p.bornAt || now,
    stageStartedAt: p.stageStartedAt || now,
    metersUpdatedAt: p.metersUpdatedAt || now,
  };
}

// 건강코드 판정(단조). 미터 깊이(targetStacks)까지 코드를 채우고, 미터가 회복되면 최근 스택부터 뗀다.
//  - 미터별로 활성 코드(현 health 중 그 미터 소속)를 세고 목표 스택과 비교.
//  - 부족: 후보(미활성 코드)를 now 시드 결정적 순서로 정렬해 필요분만큼 추가(무작위 발현, 재현 가능).
//  - 초과(미터 회복): 배열 끝(최근 발현)부터 잘라 목표까지 줄인다.
// 매 tick 새로 뽑지 않고 기존 활성분을 유지하므로 깜빡이지 않고 치료(개별 해제)도 유지된다.
function judgeHealth(meters, health, now) {
  const cur = Array.isArray(health) ? health : [];
  let out = [];
  for (const meter of ['satiety', 'happiness', 'cleanliness']) {
    const codes = HEALTH_CODES[meter];
    const active = cur.filter((c) => codes.includes(c));
    const target = targetStacks(meters[meter]);
    if (active.length >= target) {
      out = out.concat(active.slice(0, target)); // 회복: 최근 스택부터 해제
    } else {
      const need = target - active.length;
      const candidates = codes
        .filter((c) => !active.includes(c))
        .sort((a, b) => hashStr(a + ':' + now) - hashStr(b + ':' + now));
      out = out.concat(active, candidates.slice(0, need));
    }
  }
  return out;
}

// 시간 경과 정산. metersUpdatedAt~now 경과로 미터 감소 + 건강코드 재판정. 순수(now 주입).
// 앱 마운트·포그라운드 복귀·주기 tick, 그리고 케어/이동 처리 전에 호출된다.
export function tickState(state, now) {
  const last = state.metersUpdatedAt || now; // 미설정(0)이면 경과 0(즉시 감소 방지)
  const elapsed = Math.max(0, now - last);
  const meters = decayMeters(state.meters, elapsed);
  const health = judgeHealth(meters, state.health, now);
  return { ...state, meters, health, metersUpdatedAt: now };
}

// 셀 키 하나에 대한 방문 판정(코어). 이동으로 AP 를 적립한다(XP 는 안 줌).
// factor = 미터팩터(applyPath 가 tick 후 한 번 계산해 넘김). changed=false 면 보상 없음.
function visitCell(state, key, now, factor) {
  const cell = state.occupied[key];
  const isNew = !cell;
  const cooled = cell && now - cell.lastVisit > COOLDOWN_MS;

  // 재방문 + 쿨다운 미경과: 보상 없음(제자리 파밍 방지). 입력 state 그대로.
  if (!isNew && !cooled) {
    return { state, changed: false, currentKey: key };
  }

  // 이동 AP 적립 = 기본값 × 미터팩터(방치 페널티). XP 는 여기서 안 준다(케어로만 오름).
  const baseAp = isNew ? AP_NEW : AP_REVISIT;
  const ap = (state.ap || 0) + Math.round(baseAp * factor);

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

  // 확장 필드(meters·health·stage·타임스탬프)를 유실 없이 실어 나른다.
  return {
    state: { ...state, occupied, ap, items },
    changed: true,
    currentKey: key,
  };
}

// 좌표 한 건을 받아 방문(AP 적립)을 판정한다. applyPath 로 위임(중간 채움 없이 도착 칸만).
export function applyVisit(state, coords, now) {
  return applyPath(state, null, coords, now);
}

// 직전 좌표 → 새 좌표 사이를 경로 보간해 건너뛴 칸까지 이번 이동으로 처리한다.
// AP 적립 전 미터팩터를 위해 **내부에서 tick 을 먼저 돌린다**(포그·백 두 호출부가 tick 조율 불필요).
// 반환 shape { state, changed, currentKey } — 포그라운드·백그라운드 공유.
//  - 주의: tick 이 항상 미터를 갱신하므로 무보상이어도 state 는 입력과 다른 참조(정산 반영)를 돌려준다.
//  - prevCoords 없음(첫 fix): 도착 칸만 처리.
//  - 점프 가드(PATH_FILL_MAX_M 초과): 도착 칸만 처리(중간 채움 없음).
//  - 그 외: from→to H3 경로 칸을 순서대로 방문(from 칸 제외, 중복 보상 방지).
export function applyPath(state, prevCoords, coords, now) {
  const ticked = tickState(state, now);
  const factor = meterFactor(ticked.meters);
  const destKey = cellKeyAt(coords.latitude, coords.longitude);

  if (!prevCoords) return visitCell(ticked, destKey, now, factor);
  if (coordDistanceM(prevCoords, coords) > PATH_FILL_MAX_M) {
    return visitCell(ticked, destKey, now, factor);
  }

  const fromKey = cellKeyAt(prevCoords.latitude, prevCoords.longitude);
  let keys;
  try {
    keys = pathKeys(fromKey, destKey); // [from, ...중간, dest]
  } catch {
    return visitCell(ticked, destKey, now, factor);
  }

  // keys[0]=fromKey 는 직전 방문에서 처리됐으므로 건너뛴다. 같은 칸이면 루프가 안 돌고 ticked 를 돌려준다.
  // 정지(from==dest, 제자리)는 여기서 무보상 — 걷기 게임은 이동만 보상(의도됨). 옛 applyVisit 은
  // 도착 칸을 매 fix 재판정했으나, 연속 추적 경로에선 셀을 실제로 벗어난 이동만 AP 를 준다.
  let cur = ticked;
  let changed = false;
  let currentKey = destKey;
  for (let i = 1; i < keys.length; i++) {
    const r = visitCell(cur, keys[i], now, factor);
    cur = r.state;
    if (r.changed) changed = true;
    currentKey = keys[i];
  }
  return { state: cur, changed, currentKey };
}

// 케어 액션(포그라운드 전용). tick 먼저 → 대응 미터 회복 + 크리처 XP 지급 → (부스트면 AP 차감).
//  - useAP 이고 AP 충분하면 정상 XP + AP -CARE_AP_COST, 아니면 XP÷3(내림) + AP 불변.
//  - 미터 회복분으로 건강코드 재판정(회복 시 스택 자동 해제).
// 진화 가능 판정·실행은 호출부에서 canEvolve/evolve 로(기존 재사용).
export function careAction(state, action, useAP, now) {
  const def = CARE_ACTIONS[action];
  if (!def) return state;

  const s = tickState(state, now);

  // 실제 회복량 집계. 목표 미터가 이미 만땅이면 회복 0 → 케어 낭비(과식 등)로 보고
  // XP·AP 를 주지 않는다. 제자리 연타로 미터 만땅에서 XP 를 무한 파밍하던 구멍을 막는다
  // (다마고치 '배부르면 거부'). XP 처리량은 미터 감쇠 속도에 묶여 이동→AP 경제와 정합.
  const meters = { ...s.meters };
  let recovered = 0;
  for (const m of Object.keys(def.meters)) {
    const before = meters[m];
    meters[m] = Math.max(0, Math.min(100, before + def.meters[m]));
    recovered += meters[m] - before;
  }
  if (recovered <= 0) return s; // 회복 없음: tick 정산만 반영, XP·AP·미터 불변

  // 케어 쿨다운: 같은 액션을 CARE_COOLDOWN_MS 안에 또 하면 무보상 거부. 만땅 근처에서 tick/fix
  // 마다 전액 XP 를 재획득하던 M-1 파밍을 획득 빈도로 묶는다. 미터 회복은 이미 일어났지만(위)
  // 회복분을 버리고 s(tick 만) 를 돌려 보상·미터 변화 모두 무효화 → 눌러도 아무 일 없음.
  const lastAt = Number.isFinite(s.careAt && s.careAt[action]) ? s.careAt[action] : 0;
  if (now - lastAt < CARE_COOLDOWN_MS) return s;

  const boost = useAP && (s.ap || 0) >= CARE_AP_COST;
  const gainedXp = boost ? def.xp : Math.floor(def.xp / 3);
  const health = judgeHealth(meters, s.health, now);

  return {
    ...s,
    meters,
    health,
    stageXp: s.stageXp + gainedXp,
    ap: boost ? s.ap - CARE_AP_COST : s.ap,
    careAt: { ...(s.careAt || {}), [action]: now },
  };
}

// 치료(포그라운드 전용). AP 충분(-TREAT_AP_COST)하면 해당 건강코드 1개 제거. 부족하면 무변경(막힘).
//  - AP 부족·해당 코드 없음: 입력 state 그대로(무변경). AP 필수.
export function treat(state, code, now) {
  if ((state.ap || 0) < TREAT_AP_COST) return state;
  if (!(state.health || []).includes(code)) return state;

  const s = tickState(state, now);
  const idx = s.health.indexOf(code);
  if (idx === -1) return state; // tick 후 사라졌으면(회복) 무변경
  const health = s.health.slice();
  health.splice(idx, 1);
  return { ...s, health, ap: s.ap - TREAT_AP_COST };
}

// UI 프리뷰: 이 케어를 지금 하면 얼마 회복되고 XP·AP 가 얼마인지. pixel-render 버튼 라벨용.
export function previewCare(state, action, useAP, now = Date.now()) {
  const def = CARE_ACTIONS[action];
  if (!def) return null;
  // careAction 과 같은 거부 판정(만땅·쿨다운)을 미리 노출해 버튼 라벨이 실제 지급과 어긋나지 않게 한다.
  // wasted=미터 만땅, cooldownRemainingMs>0=쿨다운 중. 둘 중 하나라도면 눌러도 XP·AP 0.
  const meters = state.meters || {};
  let recovered = 0;
  for (const m of Object.keys(def.meters)) {
    const before = Number.isFinite(meters[m]) ? meters[m] : 0;
    recovered += Math.max(0, Math.min(100, before + def.meters[m])) - before;
  }
  const wasted = recovered <= 0;
  const lastAt = Number.isFinite(state.careAt && state.careAt[action]) ? state.careAt[action] : 0;
  const cooldownRemainingMs = Math.max(0, CARE_COOLDOWN_MS - (now - lastAt));
  const blocked = wasted || cooldownRemainingMs > 0;
  const boost = useAP && (state.ap || 0) >= CARE_AP_COST;
  return {
    label: def.label,
    meters: def.meters,
    xp: blocked ? 0 : boost ? def.xp : Math.floor(def.xp / 3),
    apCost: blocked ? 0 : boost ? CARE_AP_COST : 0,
    wasted,
    cooldownRemainingMs,
  };
}

// 수동 진화(순수 함수). canEvolve 면 다음 단계로 올리고 옛 단계 만렙 XP 를 차감(초과분 이월),
// stageStartedAt 을 now 로 갱신(단계 나이 리셋). 진화 불가면 입력 state 그대로.
export function evolve(state, now) {
  if (!canEvolve(state.stageXp, state.stageIndex)) return state;
  return {
    ...state,
    stageIndex: state.stageIndex + 1,
    stageXp: state.stageXp - STAGE_MAX_LEVEL[state.stageIndex] * XP_PER_LEVEL,
    stageStartedAt: now,
  };
}
