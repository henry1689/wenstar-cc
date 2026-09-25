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
    minCalciumScore: 0.15,  // V10.0: 与 WorkingMemory shouldGraduate() 实际阈值对齐
    /** 最少内容长度 */
    minContentLength: 10,
    /** 每批最大处理数 */
    batchSize: 100,  // V14: 30→100，减少晋升积压（原需2.2天清空）
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
    /** 有效强度下限 */
    strengthFloor: 0.1,
  },

  // ── P2-1: 保留衰减率 — 按内容类别独立控制（与 calcium_score 晋升/召回解耦）──
  /** calcium_score 仅用于晋升门槛和召回优先级，衰减速率由内容类别独立推导 */
  retentionDecay: {
    /** 情感/亲密类记忆（家属、情人、恋人） */
    emotional: { decay: 0.02, strengthFactor: 0.995 },
    /** 关系类记忆（朋友、同事、社交） */
    relational: { decay: 0.05, strengthFactor: 0.985 },
    /** 工作/项目类记忆 */
    work: { decay: 0.08, strengthFactor: 0.97 },
    /** 中性/默认记忆 */
    neutral: { decay: 0.10, strengthFactor: 0.95 },
    /** 被压制记忆（快速遗忘） */
    suppressed: { decay: 0.20, strengthFactor: 0.90 },
    /** 活跃记忆（保持优先） */
    active: { decay: 0.04, strengthFactor: 0.99 },
  },

  // ── 黑钻库 ──
  blackDiamond: {
    /**
     * 最大条目数（**仅统计 status='active'**）。
     * 🔴 2026-09-22 用户决定 A：200 → **800**。
     *   原因：晋升通道曾因钙化量纲错位而长期停摆，积压 2927 条候选；上限 200 太低，
     *   且原“淘汰”实现是 **DELETE 黑钻记录**，与本项目铁律「只增不删（记忆/卷宗/黑钻禁止删除）」冲突。
     *   现定为：上限 800；超出时**归档**（status='removed' + notes 记原因，记录保留），而非物理删除。
     */
    maxCount: 800,
  },

  // ── V4.0: 睡眠期巩固 (SleepTimeConsolidator) ──
  sleepConsolidation: {
    /** 砂金→金库弹性晋升最低钙化分 */
    sandToGoldMinCalcium: 0.3,
    /** 弹性晋升批量上限 */
    sandToGoldBatchSize: 50,
    /** 多人对话弹性阈值（≥2人） */
    multiPersonThreshold: 0.7,
    /** 单人对话弹性阈值 */
    singlePersonThreshold: 0.85,
    /** 惊讶度评估批量上限 */
    surpriseBatchSize: 50,
    /** 惊讶度触发阈值 */
    surpriseThreshold: 0.3,
    /** 惊讶度钙化 boost 系数 */
    surpriseBoostFactor: 0.5,
    /** 情景→语义归纳批量上限 */
    semanticInductionBatchSize: 200,
    /** 语义归纳最低提及次数(实体) */
    semanticMinEntityMentions: 3,
    /** 语义归纳最低提及次数(词组) */
    semanticMinWordMentions: 5,
    /** 语义归纳最低钙化均值 */
    semanticMinAvgCalcium: 0.25,
    /** 语义归纳钙化高关注度线 */
    semanticCalciumHigh: 0.6,
    /** 语义归纳钙化中度关注线 */
    semanticCalciumMid: 0.4,
    /** 语义归纳跨会话最低天数 */
    semanticCrossSessionMinDays: 2,
    /** 语义归纳主题筛选最低天数 */
    semanticTopicFilterMinDays: 3,
    /** 跨session关联搜索范围 */
    crossSessionBatchSize: 500,
    /** 遗忘执行强度降为 */
    forgettingStrengthFloor: 0.01,
    /** 遗忘执行钙化降为 */
    forgettingCalciumFloor: 0.1,
    /** 系统巩固钙化门槛 */
    systemsConsolidationCalcium: 1.0,
    /** 系统巩固批量上限 */
    systemsConsolidationBatchSize: 20,
    /** 钙化 boost 增量 */
    systemsConsolidationBoost: 0.2,
    /** 第二大脑同步摘要长度上限 */
    secondBrainSummaryMaxLen: 500,
    /** 第二大脑同步初始钙化 */
    secondBrainInitCalcium: 0.5,
    /** 第二大脑同步初始强度 */
    secondBrainInitStrength: 0.5,
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

  // ── 对话压缩 / 砂金库上下文窗口 ──
  // 🔴 V23.1(2026-09-13) 本段是**唯一事实源**。
  //   历史教训：同一概念曾在三处各自定义且取值不同 ——
  //     MemoryConfig.ts（本处 200/100）、config.ts.maintenance（40/20，零引用死配置）、
  //     webui/maintenance.ts 的 DEFAULT_CONFIG（硬编码 200/100，唯一实际生效）。
  //   现归一：本处为准，maintenance.ts 从此读本配置；config.ts 的遗留段删除。
  compaction: {
    /** 触发压缩的对话条数阈值（超过则把最早的归档，保留 keepFullTurns 条原文不压缩） */
    threshold: 200,
    /** 归档后保留的完整对话条数（不参与归档的"近期全量"窗口） */
    keepFullTurns: 100,
    /**
     * 注入 LLM 上下文的近期对话条数。
     *
     * 🔴 此前该值硬编码在调用点（chat.ts 的 queryEntityContext(…, 40, …) / getContextWindow(…, 40, …)），
     *   与 keepFullTurns(100) **脱节** —— 保留了 100 条却只注入 40 条，
     *   余下 60 条（约 30 轮）"留而不用"，是"聊久了记不住前面的事"的直接成因之一。
     *   现统一为本配置项，与 keepFullTurns 联动取用。
     */
    contextWindowTurns: 80,
    /**
     * 砂金库召回窗口（天）—— 超过内存上下文窗口的部分，按**时间跨度**兜底取回。
     *
     * 🔴 V34(2026-09-25) 原设计《三库记忆体系完整架构》§三：
     *   短时记忆 = ① 内存上下文轮次 + ② 砂金库（放不下的部分）；回忆时上下文找不到就去砂金库找。
     *   但实现里砂金库被 `is_compacted = 0` 焊成"只进不出的黑洞"，且兜底入口是**关键词枚举**
     *   （命中"记得/上次/之前"才去查）⇒ 不提触发词就压根不查；且窗口是**全库共享条数**，
     *   高频实体（实测单个实体 1 天 477 轮）会把窗口压到只剩几小时 —— 聊得越多记得越少。
     *   现改为按**时间跨度**取回，保证"近 N 天聊过的可被召回"，与条数上限双约束。
     *
     * 🔴 V34 阶段二 I2(2026-09-25)：7 → **21**，对齐原设计的三周生命周期。
     *   原设计把"超窗口内容不召回"当成降噪手段，却计划用「打包成概要 + 第三周清洗」去处理它；
     *   实测该路线的前提不成立（conversations 全表仅占库的 1.4%，清洗省不到空间），
     *   而"不召回"本身就是降噪 —— 于是把「避免噪音」的意图交回给**召回窗口**表达：
     *   窗口内靠相关性召回，窗口外自然不进候选池，既不删数据也不打包。
     *   代价：更早的内容可能进候选（受 sandboxRecallLimit 封顶，可调）。
     */
    sandboxRecallWindowDays: 21,
    /**
     * 砂金库时间窗召回的**条数上限**（防止长窗口 + 高频实体把注入撑爆）。
     * 与 sandboxRecallWindowDays 双约束：窗口定"多久以前的能召回"，本项定"一次最多注入多少条"。
     * 每条注入侧还会截断到 400 字 ⇒ 上限 12 条 ≈ 4.8K 字符，与既有「金库 8 条 × 250 字」同量级。
     */
    sandboxRecallLimit: 12,
    /**
     * 砂金库召回单条原文的最小长度（低于此值视为噪声轮次，不入候选）。
     * 倒排索引路径与时间窗兜底路径共用此门槛。
     */
    sandboxRecallMinContentLen: 40,
    /**
     * 倒排索引查询的最大 n-gram 词数（控制单次 SQL 的 IN 规模）。
     */
    sandboxRecallMaxTerms: 40,
    /**
     * 砂金库倒排索引**启动补齐**的单次批量上限（0 = 不限）。
     * 每进程只跑一次、幂等：只索引 `search_index` 里还没有的对话。
     * 已知技术债：写入侧尚无增量索引，故靠本补齐在每次重启时收敛缺口。
     */
    sandboxIndexBackfillBatch: 1000,
    /**
     * 全库「未归档轮次」的**硬上限**。
     *
     * 🔴 V34(2026-09-25) 归档策略从「全库头 100 条」改为「**per-entity 保底 + 全库封顶**」：
     *   原策略下窗口是**全库共享**的 —— 实测单个高频实体（1 天 477 轮）就把 100 条窗口
     *   100% 占满，其余实体的对话被瞬间归档 ⇒ **聊得越多、记得越少；不聊的反而被挤掉**。
     *   现每个实体各自保住自己的最近 keepFullTurns 条（互不挤占），全库总量以本值封顶防无界增长。
     *   keepFullTurns(100) × 实体数，再对本值取小：单实体时 = 100（与旧行为一致）。
     */
    maxUnarchivedRows: 2000,
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
