/**
 * M3Config — M3 逻辑决策层统一配置
 *
 * 所有钙化阈值、场景调整系数、情绪规则参数集中管理。
 * 与 MemoryConfig / TemporalConfig 对齐，后续接入全局配置中心。
 */
export const M3_CONFIG = {
  // ── 钙化等级阈值 ──
  calcium: {
    /** 粉末级上限（低于此值忽略） */
    level0Threshold: 0.3,
    /** 液体级上限 */
    level1Threshold: 0.6,
    /** 固体级上限 */
    level2Threshold: 0.8,
    /** 晶体级起始（≥此值触发 act 行动） */
    level3Threshold: 0.8,
  },

  // ── 场景调整系数 ──
  sceneAdjustments: {
    romanticIntimacyBonus: 0.2,
    romanticEcstasyBonus: 0.1,
    romanticThresholdOffset: 0.05,
    missFamilyIntimacyBonus: 0.15,
    missFamilyTemporalBias: -0.2,
    missFamilyScoreBonus: 0.05,
    fitnessArousalBonus: 0.1,
    burnoutDominancePenalty: -0.15,
    burnoutArousalPenalty: -0.1,
    burnoutScoreBonus: 0.05,
    suppressedPleasurePenalty: -0.15,
    suppressedSincerityBonus: 0.15,
    suppressedThresholdOffset: 0.1,
    workFactualBonus: 0.1,
    workCertaintyBonus: 0.1,
    familyConflictDominancePenalty: -0.1,
    familyConflictAggressionBonus: 0.1,
    familyConflictScoreBonus: 0.1,
  },

  // ── 上下文注入参数 ──
  context: {
    nightTimeArousalCap: 0.5,
    nightTimeIntimacyBonus: 0.1,
    morningArousalBonus: 0.1,
    longAbsenceIntimacyBonus: 0.15,
    longAbsenceHours: 8,
    longAbsenceTemporalFocus: 0.2,
    extendedAbsenceIntimacyBonus: 0.1,
    extendedAbsenceHours: 24,
    baselineAnomalyArousalBonus: 0.15,
    baselinePleasureDelta: 0.5,
    baselineArousalDelta: 0.4,
  },

  // ── 隐性情绪检测 ──
  suppressedEmotion: {
    maxExplicitEmotionWords: 2,
    pleasurePenalty: -0.2,
    sincerityBonus: 0.1,
    safetyPenalty: -0.1,
  },
} as const;
