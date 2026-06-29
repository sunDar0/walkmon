// 게임 규칙 상수와 성장 곡선. 밸런스는 여기서 다 조정합니다.

// 같은 셀을 재방문해도 이 시간이 지나기 전에는 보상이 안 나옵니다(제자리 파밍 방지).
export const COOLDOWN_MS = 1000 * 60 * 60; // 1시간

// 신규 셀은 크게, 재방문은 소량 → 탐험을 유도.
export const NEW_CELL_XP = 25;
export const REVISIT_XP = 5;
export const NEW_CELL_POINTS = 10;
export const REVISIT_POINTS = 2;

// XP → 레벨. sqrt 곡선이라 초반은 빠르고 뒤로 갈수록 완만합니다.
export function levelFromXp(xp) {
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

// 레벨 → 성장 단계. 다마고치 진화 분기를 넣고 싶으면 여기서 갈래를 칩니다.
const STAGES = ['알', '아기', '청소년', '성체', '진화체'];
export function stageFromLevel(level) {
  if (level >= 20) return STAGES[4];
  if (level >= 12) return STAGES[3];
  if (level >= 6) return STAGES[2];
  if (level >= 2) return STAGES[1];
  return STAGES[0];
}
