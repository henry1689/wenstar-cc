/**
 * SensationAdapter.ts — 瑶灵/瑶光→PFC 数据桥梁 (V4.0 Phase 2)
 * ================================================================
 * 负责将 Python 端瑶灵（32D 体感快照）和瑶光（6D 环境上下文）的数据
 * 映射到 PFC 能消费的 ConstraintInput 扩展字段。
 *
 * 使用:
 *   const enhanced = SensationAdapter.enhance(emotionVector, spineSnapshot, envSnapshot);
 *   // enhanced 可直接合并到 PFC._buildConstraintInput 的 emotionVector 中
 *
 * 注意: Python 端 GlobalBus 推送链路未开通时，方法返回原始 emotionVector，零影响。
 */

import { mapSomaticToHeart, mapEnvToThresholdAdjustments, DIM_MAPPING } from '../heart/heart-dim-mapping.js';

export interface SomaticSnapshot {
  /** yaoling 32D 体感值 Map<channelId, value[0,100]> */
  channelValues: Map<number, number>;
  /** 综合健康等级 */
  healthLevel: 'healthy' | 'sub_healthy' | 'risk' | 'danger';
  /** 生命体征 */
  vitals?: {
    heartRate?: number;
    bloodPressureSys?: number;
    bloodPressureDia?: number;
    cortisolAvg?: number;
  };
  /** 快照时间 */
  timestamp: string;
}

export interface EnvSnapshot {
  temperature_c?: number;
  noise_db?: number;
  light_lux?: number;
  crowd_density?: number;
  urgency?: number;
  circadian_shift?: number;
  timestamp: string;
}

export interface SensationEnhancement {
  /** 增强后的情感向量（heart 24D 原始值 + yaoling 32D 映射值 融合） */
  emotionVector: Record<string, number>;
  /** PFC 校验维度阈值调整系数 */
  thresholdAdjustments: ReturnType<typeof mapEnvToThresholdAdjustments>;
  /** 是否有有效的体感数据 */
  hasSomatic: boolean;
  /** 是否有有效的环境数据 */
  hasEnv: boolean;
  /** 综合健康等级 */
  healthLevel: string;
}

export const SensationAdapter = {
  /**
   * 增强 PFC 情感向量 — 融合 yaoling 体感 + yaoguang 环境数据
   *
   * @param baseEmotionVector heart 域 24D 原始情感向量
   * @param somatic yaoling 32D 体感快照（可选，Python 端不可用时为 null）
   * @param env yaoguang 6D 环境上下文（可选，Python 端不可用时为 null）
   * @returns 增强后的完整数据
   */
  enhance(
    baseEmotionVector: Record<string, number>,
    somatic: SomaticSnapshot | null,
    env: EnvSnapshot | null,
  ): SensationEnhancement {
    const result: SensationEnhancement = {
      emotionVector: { ...baseEmotionVector },
      thresholdAdjustments: { emotionTolerance: 1.0, logicTolerance: 1.0, realityTolerance: 1.0 },
      hasSomatic: false,
      hasEnv: false,
      healthLevel: 'healthy',
    };

    // ── 融合 yaoling 体感数据 ──
    if (somatic && somatic.channelValues.size > 0) {
      result.hasSomatic = true;
      result.healthLevel = somatic.healthLevel || 'healthy';

      const somaticMapped = mapSomaticToHeart(somatic.channelValues);
      // 将体感映射值合并到情感向量（heart 原始值优先，体感值补充）
      for (const [dim, value] of Object.entries(somaticMapped)) {
        if (value !== undefined) {
          // 如果 heart 已有该维度值，取加权平均；否则直接用体感值
          const existing = baseEmotionVector[dim];
          result.emotionVector[dim] = existing !== undefined
            ? Math.round(existing * 0.5 + value * 0.5)
            : Math.round(value);
        }
      }

      // 危险健康等级 → 标记
      if (somatic.healthLevel === 'danger' || somatic.healthLevel === 'risk') {
        result.emotionVector['fear'] = Math.max(result.emotionVector['fear'] || 0, 30);
        result.emotionVector['anxiety'] = Math.max(result.emotionVector['anxiety'] || 0, 30);
      }
    }

    // ── 融合 yaoguang 环境数据 ──
    if (env) {
      result.hasEnv = true;
      result.thresholdAdjustments = mapEnvToThresholdAdjustments(env);
    }

    return result;
  },

  /**
   * 从 globalThis 读取最新的瑶灵/瑶光快照
   * GlobalBusClient 收到推送后更新这两个缓存
   */
  getLatestSnapshots(): { somatic: SomaticSnapshot | null; env: EnvSnapshot | null } {
    return {
      somatic: (globalThis as any).__lastYaolingSnapshot || null,
      env: (globalThis as any).__lastYaoguangSnapshot || null,
    };
  },
};
