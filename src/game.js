// 게임 규칙 상수와 성장 곡선. 밸런스는 여기서 다 조정합니다.

// 같은 셀을 재방문해도 이 시간이 지나기 전에는 보상이 안 나옵니다(제자리 파밍 방지).
export const COOLDOWN_MS = 1000 * 60 * 60; // 1시간

// 경로 보간(자전거·차·지하철 등 빠른 이동 시 위치 갱신 사이 건너뛴 칸 채우기)의 점프 가드.
// 직전 좌표와 새 좌표 간 거리가 이 값을 넘으면 순간이동성 점프(장시간 앱 꺼짐·비행기 등)로 보고
// 중간 칸을 채우지 않고 도착 칸만 처리한다(오점령 방지).
export const PATH_FILL_MAX_M = 2000; // 2km

// 이동 = AP(액션포인트) 적립. 케어 성장 모델(p26)에서 이동은 XP 를 직접 주지 않고
// AP 를 쌓아, 그 AP 로 케어 부스트·치료를 한다. 신규 칸이 재방문보다 크게(탐험 유도).
// 실제 적립 = 기본값 × 미터팩터(meterFactor). 방치(미터 낮음)면 적립이 줄어든다.
export const AP_NEW = 3;
export const AP_REVISIT = 1;

// 셀 누적 점수(occupied[key].points) 증가량. AP·XP 와 별개의 셀 단위 값.
export const NEW_CELL_POINTS = 4;
export const REVISIT_POINTS = 1;

// 성장 모델(기획 원안): 단계별 만렙 + 수동 진화 + 초과 XP 이월.
// 성장 단계는 알→유년→소년→청년→성년 일직선 5단계. 각 단계는 레벨 0부터 시작한다.
export const STAGES = ['알', '유년', '소년', '청년', '성년'];

// 단계별 만렙. 레벨당 필요 XP 는 구간·단계 무관 상수.
export const STAGE_MAX_LEVEL = [10, 20, 30, 40, 50];
export const XP_PER_LEVEL = 30;

// 크리처 외형 종류 수(스프라이트 아틀라스 행 수와 일치). 성장 규칙엔 영향 없고 외형 전용.
// 저장본의 petType 검증 범위(hydrate)로 쓴다. WP-8 크리처 정의 테이블 도입 시 이 상수가 그쪽으로 옮겨간다.
export const PET_TYPE_COUNT = 4;

// 현재 단계 내 레벨. 만렙에서 클램프되므로, 초과 XP 는 stageXp 에만 쌓였다가 진화 시 다음 단계로 이월된다.
export function levelInStage(stageXp, stageIndex) {
  return Math.min(Math.floor(stageXp / XP_PER_LEVEL), STAGE_MAX_LEVEL[stageIndex]);
}

// 진화 가능 여부. 현재 단계 레벨이 만렙에 도달하면 열린다. 실제 진화는 플레이어가 직접 실행(자동 진화 없음).
// 성년(마지막 단계)은 진화 없음.
export function canEvolve(stageXp, stageIndex) {
  return (
    stageIndex < STAGES.length - 1 &&
    levelInStage(stageXp, stageIndex) >= STAGE_MAX_LEVEL[stageIndex]
  );
}

// ── 케어 모델(다마고치 루프) 밸런스 ──────────────────────────────────────────
// 미터 3종은 0~100. 시간 경과로 선형 감소하고, 케어로 회복한다.

export const DAY_MS = 24 * 60 * 60 * 1000;

// 각 미터가 가득(100)에서 바닥(0)까지 감소하는 데 걸리는 시간(ms). 시간비례 선형.
export const METER_DECAY_MS = {
  satiety: 24 * 60 * 60 * 1000, // 포만감 24h
  happiness: 48 * 60 * 60 * 1000, // 행복도 48h
  cleanliness: 72 * 60 * 60 * 1000, // 청결도 72h
};

// 케어/치료의 AP 비용.
export const CARE_AP_COST = 2; // 케어 1회 부스트(정상 XP) 비용
export const TREAT_AP_COST = 4; // 건강코드 1개 치료 비용

// 케어 쿨다운. 같은 액션을 이 시간 안에 다시 하면 거부(무보상). 미터 만땅 거부만으로는
// 만땅 근처에서 tick/fix 마다 전액 XP 를 재획득하는 파밍이 남으므로(감쇠와 무관한 이진 XP),
// 액션별 쿨다운으로 획득 빈도를 묶는다. 액션별이라 다른 미터 케어 라운드(먹이→씻기→놀기)는 안 막힌다.
// ── 밸런스 노브: 짧으면(≤분) 파밍 억제는 약하고 페이스만, 길면 정상 케어(연속 보충)도 지연된다.
export const CARE_COOLDOWN_MS = 2 * 60 * 1000; // 2분

// 건강코드 발현 임계·스택. 미터가 낮을수록 그 미터의 코드 스택이 늘어난다(미터당 최대 3).
export const HEALTH_THRESHOLD = 40; // 이 값 이상이면 코드 없음(스택 0)
// 미터별 건강코드 3종(발현 후보). judgeHealth 가 이 중 결정적 무작위로 채운다.
export const HEALTH_CODES = {
  satiety: ['쇠약', '어지럼', '영양실조'],
  happiness: ['우울', '외로움', '무기력'],
  cleanliness: ['가려움', '악취', '질병'],
};

// 미터값 → 목표 스택 수(0~3). 낮을수록 깊어 코드가 늘어난다.
// 임계(40) 이상이면 0. 아래로 갈수록 25/10 을 넘겨 1→2→3 스택.
export function targetStacks(meterValue) {
  if (meterValue >= HEALTH_THRESHOLD) return 0;
  if (meterValue >= 25) return 1;
  if (meterValue >= 10) return 2;
  return 3;
}

// 방치 페널티 계수. 미터 평균이 가득이면 1, 바닥이면 0.33. 이동 AP 적립에 곱한다.
export function meterFactor(meters) {
  const avg = (meters.satiety + meters.happiness + meters.cleanliness) / 3;
  return 0.33 + 0.67 * (avg / 100);
}

// 경과 시간(ms)만큼 미터 3종을 선형 감소시켜 새 객체로 반환(0~100 클램프). 순수.
export function decayMeters(meters, elapsedMs) {
  const step = (v, fullMs) => Math.max(0, Math.min(100, v - (100 * elapsedMs) / fullMs));
  return {
    satiety: step(meters.satiety, METER_DECAY_MS.satiety),
    happiness: step(meters.happiness, METER_DECAY_MS.happiness),
    cleanliness: step(meters.cleanliness, METER_DECAY_MS.cleanliness),
  };
}

// 케어 액션 정의(치료 제외 7종). meters = 회복 델타, xp = AP 부스트 시 크리처 XP(미부스트 시 ÷3).
export const CARE_ACTIONS = {
  feed: { label: '먹이', meters: { satiety: 40 }, xp: 6 },
  snack: { label: '간식', meters: { satiety: 15, happiness: 5 }, xp: 3 },
  pet: { label: '쓰다듬', meters: { happiness: 20 }, xp: 4 },
  play: { label: '놀기', meters: { happiness: 40 }, xp: 8 },
  wash: { label: '씻기', meters: { cleanliness: 35 }, xp: 6 },
  clean: { label: '청소', meters: { cleanliness: 35 }, xp: 6 },
  poop: { label: '똥치우기', meters: { cleanliness: 25 }, xp: 4 },
};

// 나이(표시용). 성장과 무관 — 총 나이(태어난 시각 기준)와 단계 나이(현 단계 진입 기준)를 일 단위로.
export function ageInfo(state, now) {
  return {
    totalDays: state.bornAt ? Math.floor((now - state.bornAt) / DAY_MS) : 0,
    stageDays: state.stageStartedAt ? Math.floor((now - state.stageStartedAt) / DAY_MS) : 0,
  };
}
