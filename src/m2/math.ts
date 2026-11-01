/**
 * FusionMath — 融合记忆系统的核心算法库
 *
 * 纯函数，零外部依赖。所有记忆动力学基于感知向量运算。
 * 🔴 P072/P074：中间层 PerceptionState24（24 维）与钙分 24D 输入属待废——M3 直产 40D 后钙分公式 40D 化（40D 量纲统一法令）。
 */
import type { PerceptionState24 } from '../m3/types/perception.js';
import type { SimilarityMode, EmotionalMemoryRecord } from './types/index.js';

// ──────────────────────────────────────────────
// 1. 向量归一化
// ──────────────────────────────────────────────

/** 哪些维度是双极性的 (-1..1)，需要映射到 [0,1] */
const BIPOLAR_FIELDS: Array<keyof PerceptionState24> = [
  'pleasure', 'dominance', 'aggression',
  'temporal_focus', 'power_diff', 'moral_judgment',
];

function normalizeValue(value: number, bipolar: boolean): number {
  return bipolar ? (value + 1) / 2 : value;  // -1→0, 0→0.5, 1→1
}

/** 将感知向量转为 24 维归一化向量（🔴 P074 待废：钙分命门当前依赖，40D 化后退役） */
export function toNormalizedVector(p: PerceptionState24): Float64Array {
  const v = new Float64Array(24);
  const keys = Object.keys(p) as Array<keyof PerceptionState24>;
  for (let d = 0; d < 24; d++) {
    v[d] = normalizeValue(p[keys[d]], BIPOLAR_FIELDS.includes(keys[d]));
  }
  return v;
}

// ──────────────────────────────────────────────
// 2. 钙化 = L2 范数
// ──────────────────────────────────────────────

/**
 * calcium = ||v|| / sqrt(N)
 *
 * 蓝皮书 V3.0 §5.2 公式（含惊讶度因子）:
 *   calcium = ||24D|| / sqrt(24) + w_surprise × surprise（🔴 P074 待废口径：重构后钙分输入 40D 化）
 *   V2.0 基础上增加惊讶度，偏离基线越远越优先巩固
 *
 * 惊讶度原理: 越偏离用户日常情绪基线的信息，越值得巩固。
 * 这与生物学中"惊讶驱动学习"一致——意外的经历更容易被记住。
 *
 * @param p - 当前感知向量（🔴 P074 待废：PerceptionState24 中间层）
 * @param baseline - 用户情绪基线（可选），含 pleasure/arousal/intimacy
 * @returns calcium score (0-1) + level (0-3)
 */
export function computeCalcium(
  p: PerceptionState24,
  baseline?: { pleasure: number; arousal: number; intimacy: number },
): { score: number; level: 0 | 1 | 2 | 3 } {
  const v = toNormalizedVector(p);
  const dimCount = 24; // P3: → 32
  let sumSq = 0;
  for (let d = 0; d < dimCount; d++) sumSq += v[d] * v[d];
  let score = Math.sqrt(sumSq) / Math.sqrt(dimCount);

  // V3.0: 惊讶度因子 — 偏离情绪基线的程度
  if (baseline) {
    const surprise = (
      Math.abs(p.pleasure - baseline.pleasure) +
      Math.abs(p.arousal - baseline.arousal) +
      Math.abs(p.intimacy - baseline.intimacy)
    ) / 3;  // 归一化到 [0, 1]
    const W_SURPRISE = 0.3;  // 惊讶度权重系数
    score = Math.min(1.0, score + W_SURPRISE * surprise);
  }

  let level: 0 | 1 | 2 | 3;
  if (score < 0.3) level = 0;
  else if (score < 0.6) level = 1;
  else if (score < 0.8) level = 2;
  else level = 3;

  return { score: Math.round(score * 1000) / 1000, level };
}

/**
 * 计算惊讶度因子 — 当前感知偏离情绪基线的程度
 * 用于记忆优先级排序，偏离越大的信息越值得巩固
 */
export function surpriseFactor(
  current: { pleasure: number; arousal: number; intimacy: number },
  baseline: { pleasure: number; arousal: number; intimacy: number },
): number {
  const surprise = (
    Math.abs(current.pleasure - baseline.pleasure) +
    Math.abs(current.arousal - baseline.arousal) +
    Math.abs(current.intimacy - baseline.intimacy)
  ) / 3;
  return Math.min(1, Math.max(0, surprise));
}

// ──────────────────────────────────────────────
// 3. 情感相似度 = 象限加权余弦
// ──────────────────────────────────────────────

/** 象限权重分配 */
function allocateQuadrantWeights(mode: SimilarityMode): [number, number, number, number] {
  switch (mode) {
    case 'mood_congruent': return [0.55, 0.10, 0.20, 0.15];
    case 'intimacy_search': return [0.10, 0.05, 0.15, 0.70];
    case 'cognitive_match': return [0.10, 0.60, 0.15, 0.15];
    case 'social_resonance': return [0.10, 0.10, 0.65, 0.15];
    case 'by_calcium': return [0.25, 0.25, 0.25, 0.25]; // override later
    case 'balanced':
    default: return [0.25, 0.25, 0.25, 0.25];
  }
}

// ──────────────────────────────────────────────
// 4. 记忆动力学
// ──────────────────────────────────────────────
// 🔴 P072 批2 墓碑：原 emotionalSimilarity（24 维加权余弦，零外部消费方）已删除——
//   禁止 24 维量纲相似度函数（40D 量纲统一法令）；toNormalizedVector 保留（computeCalcium 钙分命门内部依赖，归 P074）。

/** 初始强度：S 曲线，calcium→编码强度 */
export function initialStrength(calciumScore: number): number {
  // S-curve: calcium 0.0→0.1, 0.5→0.3, 0.8→0.7, 1.0→1.0
  return 0.1 + 0.9 / (1 + Math.exp(-6 * (calciumScore - 0.5)));
}

/** 衰减率：钙化越高衰减越慢 */
export function decayRate(calciumScore: number): number {
  return 0.05 / (1 + calciumScore * 8);
}

/** 应用衰减 */
export function applyDecay(
  currentStrength: number,
  calciumScore: number,
  daysSinceLastUpdate: number,
  recallCount: number,
): number {
  const rate = decayRate(calciumScore);
  const recallResistance = 1 + recallCount * 0.05;
  const effectiveDecay = rate * daysSinceLastUpdate / recallResistance;
  return Math.max(0.01, currentStrength * (1 - effectiveDecay));
}

/** 召回增强：越弱的记忆增强越大 */
export function recallBoost(currentStrength: number): number {
  return 0.05 * (1 - currentStrength);
}

/** 情感相似事件增强 */
export function reinforcementBoost(
  existingCalcium: number,
  newCalcium: number,
  similarity: number,
): number {
  return newCalcium * similarity * existingCalcium * 0.3;
}

/** 晋升检查：是否应该成为年轮地标 */
export function shouldPromote(
  calciumScore: number,
  reinforcementAccumulator: number,
  recallCount: number,
  effectiveStrength: number,
): boolean {
  if (calciumScore >= 0.65) return true;
  if (reinforcementAccumulator >= 1.5) return true;
  if (recallCount >= 3 && effectiveStrength > 0.5) return true;
  return false;
}

/** 完整更新一条记忆的动力学 */
export function updateDynamics(
  record: EmotionalMemoryRecord,
  now: Date = new Date(),
): EmotionalMemoryRecord {
  const lastUpdate = record.strength_updated_at ? new Date(record.strength_updated_at) : now;
  const daysElapsed = (now.getTime() - lastUpdate.getTime()) / 86_400_000;

  record.effective_strength = applyDecay(
    record.effective_strength,
    record.calcium_score,
    daysElapsed,
    record.recall_count,
  );
  record.strength_updated_at = now.toISOString();

  // 自动晋升
  if (!record.is_landmark && shouldPromote(
    record.calcium_score,
    record.reinforcement_accumulator,
    record.recall_count,
    record.effective_strength,
  )) {
    record.is_landmark = true;
    record.landmarked_at = now.toISOString();
  }

  return record;
}

// ──────────────────────────────────────────────
// 5. 检索权重分配
// ──────────────────────────────────────────────

export interface RetrievalWeights {
  emotional: number;
  topic: number;
  entity: number;
  calcium: number;
}

export function allocateRetrievalWeights(
  entityCount: number,
  arousal: number,
  mode: SimilarityMode,
): RetrievalWeights {
  // Q1: 钙化分已归一化到 [0,1] (/10)，权重相应提升以保持语义——被反复召回的
  // 记忆应有检索优势，但不淹没情感相似度。各模式的钙化权重大约×1.7 补偿 /10 缩小。
  let wE = 0.35, wT = 0.20, wEnt = 0.20, wCa = 0.25;

  if (entityCount >= 2) {
    wEnt = 0.40; wE = 0.20; wT = 0.15; wCa = 0.25;
  }
  if (arousal > 0.7) {
    wE = 0.50; wT = 0.10; wEnt = 0.10; wCa = 0.30;
  }
  if (mode === 'by_calcium') {
    wCa = 0.50; wE = 0.30; wT = 0.10; wEnt = 0.10;
  }

  const sum = wE + wT + wEnt + wCa;
  return { emotional: wE / sum, topic: wT / sum, entity: wEnt / sum, calcium: wCa / sum };
}

// ═══════════════════════════════════════════════
// P074-A2 · 钙分 40D 化双算观测（2026-10-24）
// ═══════════════════════════════════════════════

/**
 * P074-A2 双算观测：新钙分口径候选核心项 = 40D 14 语义维 L2 范数 / √14。
 *   - 值域 [0,1]（双极维 D36/D37 先归一到 [0,1]）；全零向量 → 0。
 *   - 🔴 纯观测：无任何消费方，不参与晋升/衰减/三库判定；
 *     积累新旧钙分对比数据后，由业主裁决切换时点（P074 三步走：双算→报告→切换）。
 */
export function calciumFromPerceptionV40(
  p40: { [k: string]: number | undefined } | import('../m3/types/perception-40d.js').PerceptionV40,
): number {
  const keys = [
    'd09_self_identity', 'd12_enjoyment', 'd14_self_protection', 'd15_partner_attachment',
    'd17_family_belonging', 'd19_social_fit',
    'd33_sexual_attraction', 'd34_energy_merge', 'd35_sincerity', 'd36_dominance',
    'd37_moral_judgment', 'd38_humor', 'd39_dependency', 'd40_possessiveness',
  ];
  let sumSq = 0;
  const src = p40 as { [k: string]: number | undefined };
  for (const k of keys) {
    let v = Number(src[k] ?? 0);
    if (!Number.isFinite(v)) v = 0;
    if (k === 'd36_dominance' || k === 'd37_moral_judgment') v = (v + 1) / 2; // 双极 [-1,1] → [0,1]
    else v = Math.max(0, Math.min(1, v));
    sumSq += v * v;
  }
  return Math.sqrt(sumSq) / Math.sqrt(keys.length);
}
