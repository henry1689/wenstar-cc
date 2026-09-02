// 40维语义感知坐标系 — M2 存储层类型定义
// 注意：此文件为 m2 层独立副本，避免反向依赖 m3
// 原始定义位于 src/m3/types/perception-40d.ts

/** 40D 感知向量：40 个命名键字段，按 D1-D40 编号 */
export interface PerceptionV40 {
  // ── 大类1: 肉身实体基底 D01-D08 ──
  d01_muscle_load: number;
  d02_pain_level: number;
  d03_nerve_arousal: number;
  d04_endocrine_hormones: number;
  d05_pheromone: number;
  d06_metabolic_cycle: number;
  d07_self_heal: number;
  d08_sensory_env: number;

  // ── 大类2: 个体内在精神 D09-D14 ──
  d09_self_identity: number;
  d10_desire_drive: number;
  d11_fear_fatigue: number;
  d12_enjoyment: number;
  d13_empathy: number;
  d14_self_protection: number;

  // ── 大类3: 圈层人际 D15-D20 ──
  d15_partner_attachment: number;
  d16_partner_protection: number;
  d17_family_belonging: number;
  d18_family_protection: number;
  d19_social_fit: number;
  d20_team_protection: number;

  // ── 大类4: 时空环境 D21-D26 ──
  d21_private_space: number;
  d22_home_environment: number;
  d23_workplace: number;
  d24_public_space: number;
  d25_spatiotemporal: number;
  d26_seasonal_climate: number;

  // ── 大类5: 动态成长 D27-D32 ──
  d27_micro_physiology: number;
  d28_nature_expansion: number;
  d29_social_refinement: number;
  d30_spiritual_growth: number;
  d31_quantum_coupling: number;
  d32_global_overview: number;

  // ── 大类6: 伴侣情感纹理 D33-D40 ──
  d33_sexual_attraction: number;
  d34_energy_merge: number;
  d35_sincerity: number;
  d36_dominance: number;
  d37_moral_judgment: number;
  d38_humor: number;
  d39_dependency: number;
  d40_possessiveness: number;
}

/** 40D 维度键序（固定，用于编解码对齐） */
export const PERCEPTION_40D_KEYS: (keyof PerceptionV40)[] = [
  'd01_muscle_load', 'd02_pain_level', 'd03_nerve_arousal', 'd04_endocrine_hormones',
  'd05_pheromone', 'd06_metabolic_cycle', 'd07_self_heal', 'd08_sensory_env',
  'd09_self_identity', 'd10_desire_drive', 'd11_fear_fatigue', 'd12_enjoyment',
  'd13_empathy', 'd14_self_protection', 'd15_partner_attachment', 'd16_partner_protection',
  'd17_family_belonging', 'd18_family_protection', 'd19_social_fit', 'd20_team_protection',
  'd21_private_space', 'd22_home_environment', 'd23_workplace', 'd24_public_space',
  'd25_spatiotemporal', 'd26_seasonal_climate', 'd27_micro_physiology', 'd28_nature_expansion',
  'd29_social_refinement', 'd30_spiritual_growth', 'd31_quantum_coupling', 'd32_global_overview',
  'd33_sexual_attraction', 'd34_energy_merge', 'd35_sincerity', 'd36_dominance',
  'd37_moral_judgment', 'd38_humor', 'd39_dependency', 'd40_possessiveness',
];

/** 创建全 0 的 PerceptionV40 */
export function createEmptyPerceptionV40(): PerceptionV40 {
  const p = {} as PerceptionV40;
  for (const k of PERCEPTION_40D_KEYS) p[k] = 0;
  return p;
}
