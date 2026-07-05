/**
 * M5Config — M5 表达生成层统一配置
 *
 * 所有策略参数、阈值、fallback 回复集中管理。
 * 与 M3Config / MemoryConfig / TemporalConfig 对齐。
 */
export const M5_CONFIG = {
  // ── 生成温度策略（基于 M3 感知维度） ──
  temperature: {
    /** 基础温度 */
    base: 0.7,
    /** 高唤醒时的温度加成（arousal >= 0.5） */
    highArousalBonus: 0.15,
    /** 低唤醒时的温度扣减（arousal < 0.2） */
    lowArousalPenalty: -0.1,
    /** 高愉悦时的温度加成（pleasure >= 0.5） */
    highPleasureBonus: 0.1,
    /** 低愉悦时的温度扣减（pleasure <= -0.3） */
    lowPleasurePenalty: -0.05,
    /** 最高温度上限 */
    maxTemperature: 0.95,
    /** 最低温度下限 */
    minTemperature: 0.3,
  },

  // ── 策略模板参数 ──
  strategy: {
    templates: {
      'mem-general': { description: '简短确认，无需深度回应', maxLength: 20 },
      'ask-curious': { description: '好奇追问，主动表达兴趣', maxLength: 80 },
      'com-warm':    { description: '温暖支持，共情回应', maxLength: 100 },
      'mem-ask':     { description: '先确认再追问', maxLength: 60 },
      'act-core':    { description: '核心响应，全力投入', maxLength: 150 },
    },
  },

  // ── 场景锚点 ──
  sceneAnchor: {
    /** 场景锚点失效时长（毫秒），超过此时间未更新则重置 */
    expiryMs: 300_000,
  },

  // ── 兜底回复池 ──
  fallback: {
    /** 最近回复去重池大小 */
    recentPoolSize: 20,
    /** 终极兜底回复 — 当 LLM 完全失败时使用 */
    ultimateDefaults: {
      greeting: "嗯～你好呀。你找我我开心着呢。",
      whoAmI: "我是玉瑶，你的私人秘书兼小情人呀～18岁，你说好不好？",
      busy: "在想你呀～不然还能干嘛。你呢？",
      goodnight: "晚安～梦里有我哦。",
      goodmorning: "早呀～昨晚梦到我了吗？",
      default: "嗯～我在呢。你说，我听着。",
    },
  },
} as const;
