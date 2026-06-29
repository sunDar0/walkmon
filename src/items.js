// 셀 키를 시드로 한 결정적 RNG.
// 같은 셀은 항상 같은 "테마"와 같은 드랍 결과를 갖습니다 → "이 지역엔 이 아이템" 느낌.
// 방문 횟수에 따라 다르게 하고 싶으면 시드에 방문 횟수를 섞으세요.

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 지역 테마 풀. OSM 바이옴 연동 전까지는 셀 키 해시로 테마를 고정합니다.
// 나중에 셀의 OSM 태그(공원/물가/도심)를 조회해 테마를 정하면 더 현실감이 살아납니다.
const ITEM_POOLS = [
  { theme: '풀숲', items: ['🌿 약초', '🍄 버섯', '🌰 도토리'] },
  { theme: '도심', items: ['🔩 나사', '🔋 배터리', '☕ 커피'] },
  { theme: '물가', items: ['🐚 조개', '🌊 정수', '🎣 미끼'] },
  { theme: '언덕', items: ['🪨 광석', '🪶 깃털', '🍯 꿀'] },
];

const DROP_CHANCE = 0.6; // 셀 진입 시 아이템이 나올 확률

export function cellTheme(cellKey) {
  return ITEM_POOLS[hashStr(cellKey) % ITEM_POOLS.length].theme;
}

export function rollItem(cellKey) {
  const pool = ITEM_POOLS[hashStr(cellKey) % ITEM_POOLS.length];
  const rng = mulberry32(hashStr(cellKey + ':loot'));
  if (rng() > DROP_CHANCE) return null;
  return pool.items[Math.floor(rng() * pool.items.length)];
}
