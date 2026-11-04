/**
 * MemArch-v2.0.0 / M5-Presentation / config.ts
 *
 * 阈值表外置——所有"魔法数字"集中在这里，方便调参和 A/B。
 * 改阈值不需要动业务代码。
 */

import type { EvidenceLabel } from './types.js';

export interface RouterConfig {
  /** p_A >= high → A_direct 直出 */
  p_A_high: number;
  /** p_A < low → B_only 降级暗示 */
  p_A_low: number;
  /** [p_A_low, p_A_high) → hybrid 混合 */
}

export interface LabelThreshold {
  /** 进入该档所需的最低 score */
  min_score: number;
  /** 进入该档所需的最大 recency（天）。Infinity = 不限时间 */
  max_recency_days: number;
}

/**
 * 标签阈值表：四档对应的证据强度区间。
 * 顺序即优先级：remembered > impression > clue > refused。
 * 判定时自上而下匹配第一条满足条件的。
 */
export interface LabelConfig {
  remembered: LabelThreshold;
  impression: LabelThreshold;
  clue: LabelThreshold;
}

export interface GuardConfig {
  /** 断言蕴含验证：断言 tokens 与证据 raw_text 的最小 jaccard 重合度 */
  min_token_overlap: number;
  /** 单条断言至少要命中几个 token 才算有支撑 */
  min_token_hits: number;
  /** 通路 B 话术黑名单：出现这些叙事词就说明在讲事实，必须改写 */
  pathway_b_narrative_markers: RegExp[];
  /** 零证据兜底话术（不能硬编事实） */
  fallback_no_evidence: string;
}

export interface AttributionConfig {
  /** 确认词表（confirm） */
  confirm_patterns: RegExp[];
  /** 纠正词表（correct） */
  correct_patterns: RegExp[];
  /** engaged：用户提及了证据中的实体/关键词就算 engaged */
  engaged_min_token_overlap: number;
}

export interface ReconsolidateConfig {
  /** 再巩固写入时的 namespace */
  namespace: string;
  /** 旧版本进入 M3 衰减队列时发的 signal */
  decay_signal: 'decay';
}

export interface UpgradeConfig {
  /** B→A 升级所需累计强化次数（confirm/engaged 都计数） */
  promote_after_hits: number;
  /** 单次强化写入 boost 幅度 */
  boost_per_hit: number;
}

export interface PresentationConfig {
  router: RouterConfig;
  labels: LabelConfig;
  guard: GuardConfig;
  attribution: AttributionConfig;
  reconsolidate: ReconsolidateConfig;
  upgrade: UpgradeConfig;
}

// ============================================================
// 默认配置——上线后可按业务覆盖
// ============================================================

export const DEFAULT_CONFIG: PresentationConfig = {
  router: {
    p_A_high: 0.7,
    p_A_low: 0.3,
  },
  labels: {
    // 「记得」：强证据（score≥0.6）+ 时间近（30 天内）
    remembered: { min_score: 0.6, max_recency_days: 30 },
    // 「印象」：中等证据（score≥0.35），时间不敏感
    impression: { min_score: 0.35, max_recency_days: Infinity },
    // 「线索」：弱关联（score≥0.15）
    clue: { min_score: 0.15, max_recency_days: Infinity },
  },
  guard: {
    min_token_overlap: 0.2,
    min_token_hits: 1,
    // 通路 B 严禁事实陈述——这些是"在讲过去发生了什么"的标志
    pathway_b_narrative_markers: [
      /我记得/,
      /你说过/,
      /那天/,
      /上次你/,
      /你之前/,
      /那时候/,
      /我们那次/,
      /是你告诉/,
      /确实是/,
      /当时你/,
    ],
    fallback_no_evidence: '这部分我暂时没有相关记忆，你可以多告诉我一点。',
  },
  attribution: {
    // 注意：这些词单独出现时不要过度激活，后面会和"提到证据实体"做与条件
    confirm_patterns: [
      /^(对|是的|没错|对的|嗯对|记得|我记得|确实|就是这个|想起来了)/,
      /(对的|没错|是这样|就是它|就这个)$/,
    ],
    correct_patterns: [
      /不对/,
      /错了/,
      /不是这样/,
      /记错了/,
      /其实是/,
      /你记错/,
      /不是我说/,
      /应该是/,
    ],
    engaged_min_token_overlap: 0.2,
  },
  reconsolidate: {
    namespace: 'roleplay',
    decay_signal: 'decay',
  },
  upgrade: {
    promote_after_hits: 2,
    boost_per_hit: 0.15,
  },
};

/** 合并用户覆盖配置（深合并一层） */
export function mergeConfig(
  base: PresentationConfig,
  override?: Partial<PresentationConfig>,
): PresentationConfig {
  if (!override) return base;
  return {
    router: { ...base.router, ...(override.router ?? {}) },
    labels: {
      remembered: { ...base.labels.remembered, ...(override.labels?.remembered ?? {}) },
      impression: { ...base.labels.impression, ...(override.labels?.impression ?? {}) },
      clue: { ...base.labels.clue, ...(override.labels?.clue ?? {}) },
    },
    guard: { ...base.guard, ...(override.guard ?? {}) },
    attribution: { ...base.attribution, ...(override.attribution ?? {}) },
    reconsolidate: { ...base.reconsolidate, ...(override.reconsolidate ?? {}) },
    upgrade: { ...base.upgrade, ...(override.upgrade ?? {}) },
  };
}

/** 导出类型别名方便测试断言 */
export type { EvidenceLabel };
