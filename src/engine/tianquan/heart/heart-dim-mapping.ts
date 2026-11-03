/**
 * heart-dim-mapping.ts — Heart 情绪状态分量 ↔ YaoLing 体感通道 维度映射表 (V4.0 Phase 2)
 *
 * 🔴 P076 乙方案（2026-10-24）：原 dim_mapping_24d_32d.ts 去量纲化改名——
 * TS 端 heart 域使用 EmotionState24（24 项情绪状态分量，非测量维度）；
 * 此文件定义两个体系的对应关系，供 SensationAdapter 做降维映射（Python 端通道已 40D 化，本表仅映射有对应关系者）。
 *
 * 使用:
 *   import { DIM_MAPPING } from './heart-dim-mapping.js';
 *   const heartDims = mapSomaticToHeart(yaolingSnapshot);
 */

/** 单个维度映射 */
export interface DimMapping {
  /** heart 情绪状态分量中的目标名 */
  heartDim: string;
  /** yaoling 体感通道源 ID（历史 32D 编号，通道已 40D 化） */
  yaolingChannelId: number;
  /** yaoling 通道标签 */
  yaolingLabel: string;
  /** 映射方式: weighted(加权平均) | max(取最大值) | trigger(超过阈值触发) */
  mode: 'weighted' | 'max' | 'trigger';
  /** 权重 [0,1]，mode=weighted 时使用 */
  weight: number;
  /** 触发阈值，mode=trigger 时使用 */
  threshold?: number;
  /** 映射说明 */
  description: string;
}

/** 完整的情绪分量↔体感通道维度映射表 */
export const DIM_MAPPING: DimMapping[] = [
  // ── arousal 相关 ──
  { heartDim: 'arousal', yaolingChannelId: 1, yaolingLabel: 'D1_肌肉乳酸', mode: 'weighted', weight: 0.3, description: '高乳酸→高arousal' },
  { heartDim: 'arousal', yaolingChannelId: 4, yaolingLabel: 'D4_内分泌', mode: 'weighted', weight: 0.5, description: '皮质醇/肾上腺素→arousal' },
  { heartDim: 'arousal', yaolingChannelId: 32, yaolingLabel: 'D32_综合健康', mode: 'trigger', weight: 1.0, threshold: 60, description: '健康指数<60→arousal异常' },

  // ── fear / anxiety 相关 ──
  { heartDim: 'fear', yaolingChannelId: 4, yaolingLabel: 'D4_皮质醇', mode: 'trigger', weight: 1.0, threshold: 70, description: '皮质醇>70%→fear上升' },
  { heartDim: 'anxiety', yaolingChannelId: 11, yaolingLabel: 'D11_SAS焦虑', mode: 'weighted', weight: 0.8, description: 'SAS焦虑→anxiety' },
  { heartDim: 'fear', yaolingChannelId: 8, yaolingLabel: 'D8_睡眠', mode: 'trigger', weight: 1.0, threshold: 30, description: '睡眠<30%→fear上升' },

  // ── intimacy / affection 相关 ──
  { heartDim: 'intimacy', yaolingChannelId: 12, yaolingLabel: 'D12_催产素', mode: 'weighted', weight: 0.6, description: '催产素→intimacy' },
  { heartDim: 'affection', yaolingChannelId: 12, yaolingLabel: 'D12_幸福感', mode: 'weighted', weight: 0.4, description: '幸福感→affection' },
  { heartDim: 'intimacy', yaolingChannelId: 26, yaolingLabel: 'D26_记忆', mode: 'max', weight: 0.5, description: '记忆强度→intimacy' },

  // ── fatigue / calm 相关 ──
  { heartDim: 'fatigue', yaolingChannelId: 1, yaolingLabel: 'D1_肌肉', mode: 'weighted', weight: 0.7, description: '肌肉疲劳→fatigue' },
  { heartDim: 'fatigue', yaolingChannelId: 8, yaolingLabel: 'D8_睡眠', mode: 'weighted', weight: 0.3, description: '睡眠不足→fatigue' },
  { heartDim: 'calm', yaolingChannelId: 32, yaolingLabel: 'D32_综合健康', mode: 'max', weight: 1.0, description: '综合健康→calm' },

  // ── joy / excitement 相关 ──
  { heartDim: 'joy', yaolingChannelId: 12, yaolingLabel: 'D12_幸福感', mode: 'weighted', weight: 0.6, description: '幸福感→joy' },
  { heartDim: 'joy', yaolingChannelId: 4, yaolingLabel: 'D4_多巴胺', mode: 'weighted', weight: 0.4, description: '多巴胺→joy' },
  { heartDim: 'excitement', yaolingChannelId: 4, yaolingLabel: 'D4_肾上腺素', mode: 'max', weight: 1.0, description: '肾上腺素→excitement' },
];

/**
 * 将 yaoling 体感快照映射到 heart 情绪状态分量
 * @param somaticValues Map<channelId, normalizedValue[0,100]>
 * @returns Partial heart 情绪分量集（只包含有映射的维度）
 */
export function mapSomaticToHeart(
  somaticValues: Map<number, number>,
): Partial<Record<string, number>> {
  const result: Record<string, number> = {};

  // 按 heartDim 分组聚合
  const byHeartDim = new Map<string, DimMapping[]>();
  for (const mapping of DIM_MAPPING) {
    const list = byHeartDim.get(mapping.heartDim) || [];
    list.push(mapping);
    byHeartDim.set(mapping.heartDim, list);
  }

  for (const [heartDim, mappings] of byHeartDim) {
    const values: number[] = [];
    for (const m of mappings) {
      const somaticVal = somaticValues.get(m.yaolingChannelId);
      if (somaticVal === undefined) continue;

      if (m.mode === 'trigger') {
        if (m.threshold !== undefined && somaticVal > m.threshold) {
          // 触发模式：超过阈值时线性映射到 heart 维度
          const excess = (somaticVal - m.threshold) / (100 - m.threshold);
          values.push(excess * 100);
        }
      } else if (m.mode === 'max') {
        values.push(somaticVal * m.weight);
      } else {
        // weighted
        values.push(somaticVal * m.weight);
      }
    }

    if (values.length > 0) {
      // 取所有映射结果的加权平均值
      result[heartDim] = values.reduce((a, b) => a + b, 0) / values.length;
    }
  }

  return result;
}

/**
 * 将 yaoguang 6D 环境上下文映射到 PFC 约束校验阈值调整系数
 * @returns 各校验维度的阈值调整系数 [0.5, 1.5]
 */
export function mapEnvToThresholdAdjustments(
  env6d: { temperature_c?: number; noise_db?: number; light_lux?: number; crowd_density?: number; urgency?: number; circadian_shift?: number },
): { emotionTolerance: number; logicTolerance: number; realityTolerance: number } {
  let emotionTolerance = 1.0;
  let logicTolerance = 1.0;
  let realityTolerance = 1.0;

  // 嘈杂环境 → 放宽情感阈值
  if ((env6d.noise_db ?? 0) > 60) emotionTolerance += 0.2;
  // 高温 → 放宽情感阈值
  if ((env6d.temperature_c ?? 20) > 30) emotionTolerance += 0.1;
  // 高紧迫 → 放宽情感/逻辑阈值
  if ((env6d.urgency ?? 0) > 0.5) { emotionTolerance += 0.1; logicTolerance += 0.1; }
  // 昼夜节律偏移 → 放宽所有阈值
  if ((env6d.circadian_shift ?? 0) > 0.3) { emotionTolerance += 0.1; logicTolerance += 0.05; realityTolerance += 0.05; }

  return {
    emotionTolerance: Math.min(1.5, emotionTolerance),
    logicTolerance: Math.min(1.5, logicTolerance),
    realityTolerance: Math.min(1.5, realityTolerance),
  };
}
