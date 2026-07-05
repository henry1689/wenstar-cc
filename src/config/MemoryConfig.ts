/**
 * MemoryConfig — 三库记忆系统统一配置
 *
 * 所有阈值、周期、系数集中管理，业务代码零硬编码。
 * 与 TemporalConfig 共同构成全局配置体系的记忆侧。
 *
 * 修改配置无需改动业务源码。
 */
export const MEMORY_CONFIG = {
  // ── 砂金→金库 晋升 ──
  sandToGold: {
    /** 调度间隔（毫秒） */
    intervalMs: 30 * 60 * 1000,
    /** 最低钙化分门槛 */
    minCalciumScore: 1.0,
    /** 最少内容长度 */
    minContentLength: 10,
    /** 每批最大处理数 */
    batchSize: 30,
  },

  // ── 金库→黑钻 晋升 ──
  goldToDiamond: {
    /** 调度间隔（毫秒） */
    intervalMs: 2 * 60 * 60 * 1000,
    /** 晋升钙化分门槛（v2规格） */
    minCalciumScore: 4.5,
    /** 晋升最低召回次数 */
    minRecallCount: 5,
    /** 每批最大处理数 */
    batchSize: 5,
  },

  // ── 钙化分衰减 ──
  decay: {
    /** 调度间隔（毫秒） */
    intervalMs: 24 * 60 * 60 * 1000,
    /** 强烈情感记忆（calcium>=3）衰减速率 */
    highCalciumDecay: 0.02,
    /** 工作相关记忆衰减速率 */
    workDecay: 0.05,
    /** 普通中性记忆衰减速率 */
    normalDecay: 0.10,
    /** 强烈情感记忆强度衰减系数 */
    highStrengthFactor: 0.995,
    /** 工作记忆强度衰减系数 */
    workStrengthFactor: 0.985,
    /** 普通记忆强度衰减系数 */
    normalStrengthFactor: 0.95,
    /** 有效强度下限 */
    strengthFloor: 0.1,
  },

  // ── 黑钻库 ──
  blackDiamond: {
    /** 最大条目数 */
    maxCount: 200,
  },

  // ── 召回评分 ──
  recall: {
    /** 每次召回递增钙化分 */
    increment: 0.2,
    /** 钙化分上限 */
    calciumMax: 10.0,
    /** 钙化分下限 */
    calciumMin: 0.0,
  },

  // ── 对话压缩 ──
  compaction: {
    /** 触发压缩的对话轮次阈值 */
    threshold: 200,
    /** 压缩后保留的完整轮次数 */
    keepFullTurns: 100,
  },

  // ── 黑钻快查情绪标签 ──
  knownEmotionTags: [
    "中性","平静","快乐","思念","委屈","焦虑","不安","恐惧",
    "愤怒","沮丧","愧疚","无奈","麻木","怀念","空虚","爱意",
    "满足","幸福","惊喜","感动","温馨","欲望","渴望","占有",
    "依赖","期待","慵懒","倾诉","失落","矛盾","释然","警惕",
    "共鸣","嫉妒","疏离","包容","温馨","感动","幸福","疲惫",
  ],
} as const;
