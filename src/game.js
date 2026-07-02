// 게임 규칙 상수와 성장 곡선. 밸런스는 여기서 다 조정합니다.

// 같은 셀을 재방문해도 이 시간이 지나기 전에는 보상이 안 나옵니다(제자리 파밍 방지).
export const COOLDOWN_MS = 1000 * 60 * 60; // 1시간

// 신규 셀은 크게, 재방문은 소량 → 탐험을 유도.
// res11(칸 폭 ~50m)은 res10(~130m)보다 걷기 시 새 칸을 약 2.6배 자주 밟으므로,
// 걷는 거리당 성장 속도를 보존하려고 칸당 XP·포인트를 그 비율(÷2.5)만큼 낮췄다.
// 신규:재방문 비(5:1)는 유지해 탐험 유도 강도는 그대로 둔다.
export const NEW_CELL_XP = 10;
export const REVISIT_XP = 2;
export const NEW_CELL_POINTS = 4;
export const REVISIT_POINTS = 1;

// 성장 모델(기획 원안): 단계별 만렙 + 수동 진화 + 초과 XP 이월.
// 성장 단계는 알→유년→소년→청년→성년 일직선 5단계. 각 단계는 레벨 0부터 시작한다.
export const STAGES = ['알', '유년', '소년', '청년', '성년'];

// 단계별 만렙. 레벨당 필요 XP 는 구간·단계 무관 상수.
export const STAGE_MAX_LEVEL = [10, 20, 30, 40, 50];
export const XP_PER_LEVEL = 30;

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
