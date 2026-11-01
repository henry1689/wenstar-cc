/**
 * reconsolidation — 记忆再巩固机制
 *
 * 每次检索到旧记忆时，根据当下的情绪状态和关系强度重新加权。
 * 就像人回忆往事时会带着当下的情绪滤镜。
 *
 * 权责分层：
 * - 再巩固 = 运行时微观微调（鲜活度/重要度），单次≤5分，自动执行
 * - AQC = 结构性变更（跨库流转/遗忘/修正）终审
 *
 * 跨库阈值：重要度累计变化超过 30 分时提交 AQC 审核
 */
import type { EmotionState24 } from '../../bus/types.js';

export interface ReconsolidationInput {
  /** 记忆当前重要度 0-100 */
  currentImportance: number;
  /** 记忆当前鲜活度 0-100 */
  currentVividness: number;
  /** 检索时的情感向量 */
  retrievalEmotion: EmotionState24;
  /** 关系信任度 0-100 */
  trust: number;
  /** 记忆距今小时数 */
  ageHours: number;
  /** 该记忆已被检索的次数 */
  retrievalCount: number;
}

export interface ReconsolidationOutput {
  /** 调整后的重要度 */
  newImportance: number;
  /** 调整后的鲜活度 */
  newVividness: number;
  /** 本轮调整量（重要度） */
  importanceDelta: number;
  /** 本轮调整量（鲜活度） */
  vividnessDelta: number;
  /** 累计重要度偏移量（距首次存储） */
  cumulativeShift: number;
  /** 是否触发 AQC 审核阈值 */
  triggerAQC: boolean;
}

// ── 再巩固参数 ──
const MAX_SINGLE_DELTA = 5;         // 单次调整上限
const AQC_THRESHOLD = 30;           // 累计偏移触发 AQC
const VIVIDNESS_DECAY_HALFLIFE = 720; // 鲜活度自然衰减半衰期 (30天)

/**
 * 应用记忆再巩固
 *
 * 规则：
 * 1. 情感共鸣增强：检索时的情绪强度与记忆的情感强度越匹配，重要度提升越大
 * 2. 信任调幅：高信任时正向记忆增强、负向记忆削弱
 * 3. 遗忘衰减：长期不检索的记忆自然衰减鲜活度
 * 4. 检索效应：每检索一次，重要度小幅度自然增强（被想起本身就会加深记忆）
 */
export function applyReconsolidation(
  input: ReconsolidationInput,
  /** 累计偏移量（需外部维护） */
  cumulativeShift: number = 0,
): ReconsolidationOutput {
  const { currentImportance, currentVividness, retrievalEmotion, trust, ageHours, retrievalCount } = input;

  // 情感强度（基于检索时的 emotional arousal）
  const emotionIntensity = Math.max(0,
    retrievalEmotion.arousal / 100 + retrievalEmotion.joy / 100 + retrievalEmotion.intimacy / 100,
  );

  // 1. 情感共鸣：情绪强度 > 0.5 时增强
  let importanceDelta = 0;
  let vividnessDelta = 0;

  if (emotionIntensity > 0.5) {
    const boost = (emotionIntensity - 0.5) * 4; // 0-2 分
    importanceDelta += boost;
    vividnessDelta += boost;
  }

  // 2. 信任调幅
  const trustNorm = trust / 100;
  if (currentImportance > 50) {
    // 重要记忆 → 高信任时增强
    importanceDelta += trustNorm * 1.5;
  } else if (currentImportance < 20) {
    // 不重要记忆 → 高信任时可能削弱（新记忆覆盖旧记忆）
    importanceDelta -= trustNorm * 0.5;
  }

  // 3. 检索效应：每检索一次小幅度增强
  if (retrievalCount > 1) {
    const retrievalBoost = Math.min(1, retrievalCount * 0.2);
    importanceDelta += retrievalBoost;
    vividnessDelta += retrievalBoost;
  }

  // 4. 衰减：长期不检索时鲜活度自然衰退
  const decayFactor = Math.exp(-ageHours / VIVIDNESS_DECAY_HALFLIFE);
  const baseVividness = 100 * (1 - decayFactor) + currentVividness * decayFactor;
  vividnessDelta += (baseVividness - currentVividness) * 0.1;

  // 钳制单次调整量
  importanceDelta = clamp(importanceDelta, -MAX_SINGLE_DELTA, MAX_SINGLE_DELTA);
  vividnessDelta = clamp(vividnessDelta, -MAX_SINGLE_DELTA, MAX_SINGLE_DELTA);

  // 计算新值
  const newImportance = clamp(currentImportance + importanceDelta, 0, 100);
  const newVividness = clamp(currentVividness + vividnessDelta, 0, 100);

  const newCumulativeShift = cumulativeShift + Math.abs(importanceDelta);

  return {
    newImportance: Math.round(newImportance * 10) / 10,
    newVividness: Math.round(newVividness * 10) / 10,
    importanceDelta: Math.round(importanceDelta * 10) / 10,
    vividnessDelta: Math.round(vividnessDelta * 10) / 10,
    cumulativeShift: Math.round(newCumulativeShift * 10) / 10,
    triggerAQC: newCumulativeShift >= AQC_THRESHOLD,
  };
}

/**
 * 判断是否需要跨库晋升（AQC 提交审核）
 *
 * 规则：
 * - 重要度持续 > 70 + 鲜活度 > 60 → 砂金→金库候选人
 * - 重要度持续 > 85 + 鲜活度 > 80 且关系亲密 → 金库→黑钻候选人
 * - 重要度 < 10 且超过 90 天未检索 → 遗忘候选人
 */
export function evaluateLibraryPromotion(
  importance: number,
  vividness: number,
  trust: number,
  relationState: string,
): 'promote_sand_to_gold' | 'promote_gold_to_diamond' | 'forget' | null {
  if (importance > 85 && vividness > 80 && trust > 60 && relationState === 'intimate') {
    return 'promote_gold_to_diamond';
  }
  if (importance > 70 && vividness > 60) {
    return 'promote_sand_to_gold';
  }
  if (importance < 10) {
    return 'forget';
  }
  return null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
