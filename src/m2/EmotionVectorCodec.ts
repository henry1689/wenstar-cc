/**
 * EmotionVectorCodec — 24D情感向量统一编解码标准
 *
 * 全系统所有 24D 感知向量的序列化/反序列化、校验必须通过此接口。
 * 禁止业务模块自行 JSON.stringify/parse，确保口径唯一。
 *
 * 24D 向量顺序定义（下标0-23）：
 *   [0] pleasure     [1] arousal      [2] dominance    [3] aggression
 *   [4] sincerity    [5] humor        [6] factual      [7] logical
 *   [8] certainty    [9] abstract     [10] temporal_focus  [11] self_ref
 *   [12] intimacy    [13] power_diff  [14] dependency  [15] moral_judgment
 *   [16] etiquette   [17] belonging   [18] sexual_attraction  [19] sensory_craving
 *   [20] energy_merge [21] possessiveness [22] ecstasy   [23] safety
 */
import type { Perception24D } from '../m3/types/perception.js';

// ── 维度数量校验 ──
const EXPECTED_DIM = 24;

/**
 * 将 Perception24D 编码为 JSON 字符串
 * 统一入口：所有感知向量写入 fusion_memory / vault / zone 均必须走此方法
 */
export function encodeEmotionVector(p: Perception24D): string {
  const arr = [
    p.pleasure, p.arousal, p.dominance, p.aggression,
    p.sincerity, p.humor, p.factual, p.logical,
    p.certainty, p.abstract, p.temporal_focus, p.self_ref,
    p.intimacy, p.power_diff, p.dependency, p.moral_judgment,
    p.etiquette, p.belonging, p.sexual_attraction, p.sensory_craving,
    p.energy_merge, p.possessiveness, p.ecstasy, p.safety,
  ];
  return JSON.stringify(arr);
}

/**
 * 将 JSON 字符串解码为 Perception24D
 * 含格式校验：长度不对时返回 null 而非抛出异常
 */
export function decodeEmotionVector(json: string): Perception24D | null {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length !== EXPECTED_DIM) return null;
    // 校验所有值为有限数字
    for (let i = 0; i < EXPECTED_DIM; i++) {
      if (typeof arr[i] !== 'number' || !isFinite(arr[i])) return null;
    }
    return {
      pleasure: arr[0], arousal: arr[1], dominance: arr[2], aggression: arr[3],
      sincerity: arr[4], humor: arr[5], factual: arr[6], logical: arr[7],
      certainty: arr[8], abstract: arr[9], temporal_focus: arr[10], self_ref: arr[11],
      intimacy: arr[12], power_diff: arr[13], dependency: arr[14], moral_judgment: arr[15],
      etiquette: arr[16], belonging: arr[17], sexual_attraction: arr[18], sensory_craving: arr[19],
      energy_merge: arr[20], possessiveness: arr[21], ecstasy: arr[22], safety: arr[23],
    };
  } catch {
    return null;
  }
}

/**
 * 计算 24D 向量的 L2 范数（用于向量检索粗筛）
 * l2_norm = sqrt(Σx²)，值域 [0, sqrt(24)] ≈ [0, 4.9]
 * 范数接近 0 表示无情感倾向（纯事实文本），范数大表示情感强烈
 */
export function computeL2Norm(p: Perception24D): number {
  const keys: (keyof Perception24D)[] = [
    'pleasure', 'arousal', 'dominance', 'aggression',
    'sincerity', 'humor', 'factual', 'logical',
    'certainty', 'abstract', 'temporal_focus', 'self_ref',
    'intimacy', 'power_diff', 'dependency', 'moral_judgment',
    'etiquette', 'belonging', 'sexual_attraction', 'sensory_craving',
    'energy_merge', 'possessiveness', 'ecstasy', 'safety',
  ];
  let sumSq = 0;
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'number' && isFinite(v)) {
      sumSq += v * v;
    }
  }
  return Math.round(Math.sqrt(sumSq) * 100) / 100;
}

/**
 * 校验感知向量各维度是否在合法范围 [-1, 1] 内
 */
export function validateEmotionVector(p: Perception24D): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const keys: (keyof Perception24D)[] = [
    'pleasure', 'arousal', 'dominance', 'aggression',
    'sincerity', 'humor', 'factual', 'logical',
    'certainty', 'abstract', 'temporal_focus', 'self_ref',
    'intimacy', 'power_diff', 'dependency', 'moral_judgment',
    'etiquette', 'belonging', 'sexual_attraction', 'sensory_craving',
    'energy_merge', 'possessiveness', 'ecstasy', 'safety',
  ];
  for (const k of keys) {
    const v = p[k];
    if (typeof v !== 'number' || !isFinite(v)) {
      errors.push(`${k} 不是合法数字`);
    } else if (v < -1 || v > 1) {
      errors.push(`${k}=${v} 超出[-1,1]范围`);
    }
  }
  return { valid: errors.length === 0, errors };
}
