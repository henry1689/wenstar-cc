/**
 * M6Config — M6 角色人格演化统一配置
 *
 * 所有演化参数、阈值、衰减系数集中管理。
 * 与 M3Config / M5Config / MemoryConfig 对齐。
 */
export const M6_CONFIG = {
  // ── 演化缓冲区 ──
  buffer: {
    /** 触发小幅自动演化的最少信号数 */
    triggerThreshold: 5,
    /** 触发中幅演化的最少信号数 */
    mediumThreshold: 15,
  },

  // ── 大五人格演变 ──
  trait: {
    /** 默认基线值 */
    baseline: {
      openness: 0.7,
      conscientiousness: 0.6,
      extraversion: 0.4,
      agreeableness: 0.8,
      neuroticism: 0.3,
    },
    /** 均值回归强度（每24小时向基线回拉的比例） */
    regressionRate: 0.02,
    /** 保险锁：不可超出此范围 */
    min: 0,
    max: 1,
  },

  // ── 叙事层 ──
  narrative: {
    /** 叙事层最大层数，超出后合并 */
    maxLayers: 20,
    /** 合并时保留的最低钙化分 */
    minCalciumToKeep: 0.5,
  },

  // ── 写入 ──
  persistence: {
    /** 防抖合并间隔（毫秒） */
    debounceMs: 30_000,
    /** 关键变更（如等级晋升）强制即时写入 */
    forceFlushOnKeyChange: true,
  },

  // ── 偏好衰减 ──
  preference: {
    /** 偏好未提及多少天后开始衰减 */
    decayDays: 30,
    /** 衰减比例 */
    decayRate: 0.8,
    /** 强度低于此值直接删除 */
    minStrength: 0.1,
  },

  // ── 边界衰减 ──
  boundary: {
    /** 边界触碰率衰减天数 */
    decayDays: 90,
    /** 强化所需最少触碰次数 */
    strengthenThreshold: 5,
  },

  // ── 演化delta映射 ──
  evolution: {
    /** 钙化等级→delta映射：0=粉末,1=液体,2=固体,3=晶体 */
    deltaByCalciumLevel: [0, 3, 8, 15],
  },
} as const;
