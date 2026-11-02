/**
 * Flags — 检索架构 v11 回滚开关与冻结常量
 * ============================================================
 * 蓝皮书 §9.1 开关总表 / §9.2 开关读取规范 的**唯一实现**。
 *
 * 【为什么是函数不是常量对象】
 * 蓝皮书 §9.2 的示例写的是 `process.env.X === 'true'` 的 const 对象 —— 那是
 * **模块加载期求值**，改环境变量必须重启才生效。任务书 §S2 C 却明写「关影子
 * `RETRIEVAL_V11=0` **立即生效，无需重启**」。两条冲突时以任务书的验收要求为准，
 * 故本文件把开关实现为**每次调用实时读** `process.env` 的函数。
 * 「不得在业务代码里直接读 process.env」这条红线仍然成立 —— 业务代码只调
 * `Flags.xxx()`，`process.env` 的读取点全仓只有本文件。
 *
 * 【红线】
 *   1. 权重是**冻结常量**，函数内禁止写字面量（蓝皮书 §1.2 魔数禁令）。
 *      改权重 = 修订白皮书 §4.3，不是改代码；`w_semantic` 上限 0.10 任何阶段不得突破。
 *   2. 开关只控制**走哪条路**，**不得**控制「要不要过闸门」—— 五级闸门永远过。
 *   3. 本文件**不读写数据库、不落盘**，导入零副作用。
 *   4. `M3Config.ts` 的五级闸门阈值本阶段**冻结**（任务书 §S2 A8），不得借机调参。
 */

/** 精排四权重（白皮书 §4.3.1，蓝皮书 §1.2 常量表） */
export interface RetrievalWeights {
  hit: number;
  calcium: number;
  recency: number;
  semantic: number;
}

// ══════════════════════════════════════════════════════════════════
// 一、冻结常量（只增不改；改动 = 修订白皮书，须走书面变更）
// ══════════════════════════════════════════════════════════════════

/**
 * 精排四权重 —— **单一常量对象**，全仓唯一产出点。
 * 🔴 `semantic` 上限 0.10（白皮书 §4.3.1 / 附录 A 第 4 条），任何阶段不得抬高。
 */
export const RETRIEVAL_V11_WEIGHTS: Readonly<RetrievalWeights> = Object.freeze({
  hit: 0.45,
  calcium: 0.30,
  recency: 0.15,
  semantic: 0.10,
});

/**
 * ADR-010 §12.2.3 对话块双通道排序四权重（**业主确认 2026-10-18**）。
 *
 * 🔴 与 `RETRIEVAL_V11_WEIGHTS` 的关系是**分工，不是替代**：
 *   后者是 v11 通用精排（memory / conversation / work 三域，以及 dialog_group 改造前）；
 *   本对象是 ADR-010 为 `dialog_group` 域单独确认的法典权重。
 *   两者都必须落在本文件 —— 权重单一产出点（红线 1），散进业务函数即违反蓝皮书 §1.2 魔数禁令。
 *
 * 对应公式（ADR-010 §12.2.3）：
 * ```
 * score = convDensity×0.40 + summaryDensity×0.30 + bothChannels×0.15 + calcium×0.15
 * ```
 * 因此**纯原文候选最高 0.55**（0.40 + 0.15 钙满）、**纯摘要候选最高 0.45**（0.30 + 0.15 钙满）
 * —— 摘要命中略低于原文，但足以进入候选集（法典原文）。四分量同时拉满为 1.00。
 */
export interface Adr010BlockWeights {
  /** 原文密度 `min(1, 原文命中轮数 / turn_count)` */
  convDensity: number;
  /** 摘要密度 `min(1, 摘要命中分片数 / 10)` */
  summaryDensity: number;
  /** 双通道共振：原文与摘要同时命中 */
  bothChannels: number;
  /** 钙化度 `min(1, block_calcium_score / 10)` */
  calcium: number;
}

export const ADR_010_BLOCK_WEIGHTS: Readonly<Adr010BlockWeights> = Object.freeze({
  convDensity: 0.40,
  summaryDensity: 0.30,
  bothChannels: 0.15,
  calcium: 0.15,
});

/**
 * ADR-010 §12.2.3 `summaryDensity` 的分母（法典写死「摘要命中 n-gram 条数 / 10」）。
 * 抽成常量而非留在表达式里：它是法典数字，改它 = 修订 ADR-010，不是改代码。
 */
export const ADR_010_SUMMARY_DENSITY_CAP = 10;

/**
 * ADR-010 对话块方案的**钙分归一基准 = 5**（不是通用方案的 `CALCIUM_SCORE_MAX = 10`）。
 *
 * 🔴 依据 ADR-010 §13.1 原文：「**钙分归一基准 `/10` → `/5`**（高钙阈值即满分）：
 *    生产实测 max 7.72 / avg 3.85，除以 10 时高钙与 2~5 分段在 0.15 权重下只差 0.075，
 *    区分度结构性不足」。该句紧跟在 `0.40 原文密度 + 0.30 摘要密度 + 0.15 双通道共振
 *    + 0.15 钙分` 之后，指的就是本方案的钙分项。
 *
 * ⚠️ 两个基准**并存且各有归属**：`CALCIUM_SCORE_MAX`(10) 属 v11 通用四权重
 *    （白皮书 §4.2，memory/conversation/work 三域 + dialog_group 改造前），
 *    本常量只属于 `ADR_010_BLOCK_SCHEME`。历史实现 `c1888dc` 的
 *    `CALCIUM_NORM_DENOM = 5` 在 `19e1a68`（v11 接管）时连同公式一起丢失，
 *    2026-11-02 按 ADR 条文恢复。
 */
export const ADR_010_CALCIUM_NORM_DENOM = 5;

/** 时间近因半衰期 30 天（蓝皮书 §4.2 表格 🔴 标注：改它等于改召回性格） */
export const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** 钙化度量表上限（蓝皮书 §4.2：`calcium_score / 10` 归一） */
export const CALCIUM_SCORE_MAX = 10;

/** 围栏候选池上限（蓝皮书 §2.2 `EnclosureQuery.limit` 默认 500） */
export const ENCLOSURE_DEFAULT_LIMIT = 500;

/**
 * 关键词分片数上限。
 *
 * 🔴 **12**（业主 2026-10-27 裁决「降到 12，先保预算」）。
 * 原值 40 来自白皮书 §4.2.2「去重后取前 40 个，沿用既有上限」，但真实生产库只读
 * 探针实测：40 分片下 `domain='conversation'` 围栏耗时 **84–185ms**，超出蓝皮书
 * §3.4 单域 ≤100ms 预算。按蓝皮书 §3.4 的超预算处置顺序（① 降 LIMIT →
 * ② 减分片数 → ③ 收时间窗），取第 ② 项。
 *
 * 依据：白皮书 §4.2.2 自己的实测基线（5 分片 = 38ms）本就远低于 40；
 * 围栏定位是「只求全、不求准」（§4.2.3），召回面损失由精排层补回。
 * ⚠️ 该常量是冻结值，再改须修订蓝皮书 §3.4 / 白皮书 §4.2.2。
 */
export const QUERY_SHARD_MAX = 12;

/**
 * 精排截断 top-K —— **新链路最终返回多少条候选**。
 *
 * 🔴 **50**（业主 2026-10-27 裁决「可以考虑 top-k 到返回 50 条看看效果」）。
 *
 * 与蓝皮书 §4.1 [2]「K 默认 12」的关系（**这是两回事，勿混为一谈**）：
 *   - 蓝皮书的 12 是**精排层的设计截断值**，即「候选池 → 注入层」的目标宽度；
 *   - 本常量在生产里承担的是**新链路对旧链路的返回量对齐**——
 *     旧路 `retrieveMemories` 是 `return merged`（六路合并后实测 30–60 条），
 *     **不按 `options.limit` 截断**（`limit` 在旧路只用于知识库配额）。
 *   - 2026-10-27 首次切换上线时 v11 按 5 条返回，业主实测到召回质量下降
 *     （角色回「那个 XX 真没印象」），随即回滚。取 50 落在旧路区间内，
 *     既有对照性又不至于把 prompt 撑爆。
 *
 * ⚠️ 该取值与蓝皮书 §4.1 的 12 冲突，须走书面修订（任务书 v1.1 已记录）。
 * 再改须修订任务书 / 蓝皮书，不得直接改代码。
 */
export const RERANK_TOP_K = 50;

// ══════════════════════════════════════════════════════════════════
// 二、八个回滚开关（蓝皮书 §9.1）
// ══════════════════════════════════════════════════════════════════

/** 仅显式 `'true'` 判真 —— 未设 / `0` / `false` / 任何拼写变体一律为关（fail-safe） */
function readFlag(name: string): boolean {
  return process.env[name] === 'true';
}

export const Flags = Object.freeze({
  /** 全局：走新链路；异常时回落旧链路。S2 期间兼作「影子是否运行」的总闸 */
  enabled: () => readFlag('RETRIEVAL_V11'),
  /** 围栏层：启用结构化围栏（可单独灰度） */
  enclosure: () => readFlag('RETRIEVAL_V11_ENCLOSURE'),
  /** 精排层：启用四权重精排 */
  rerank: () => readFlag('RETRIEVAL_V11_RERANK'),
  /** 单通道：启用 `w_semantic` 语义通道 */
  semantic: () => readFlag('RETRIEVAL_V11_SEMANTIC'),
  /** 单通道：启用 LLM 兜底精排（默认关，成本 5–10k token/次） */
  llmRerank: () => readFlag('RETRIEVAL_V11_LLM_RERANK'),
  /** 单域：启用对话组主路召回 */
  dialogGroup: () => readFlag('RETRIEVAL_V11_DIALOG_GROUP'),
  /**
   * 安全边界：闸门加载失败时返回空而非放行（蓝皮书 §5.3 业主裁决 2026-10-27 方案 A）。
   * 🔴 S3 起默认 true。**不得**因观测噪声关掉它（任务书 §S5 C）。
   */
  gateFailClosed: () => readFlag('RETRIEVAL_V11_GATE_FAILCLOSED'),
  /** 观测：写每日缺口台账（S1.1 方案② 强制配套，S1 起 true） */
  gapLedger: () => readFlag('RETRIEVAL_V11_GAP_LEDGER'),
});

/** 开关名清单 —— 供 S5-B「回滚开关演练」逐个点名，避免漏演练 */
export const V11_FLAG_NAMES: readonly string[] = Object.freeze([
  'RETRIEVAL_V11',
  'RETRIEVAL_V11_ENCLOSURE',
  'RETRIEVAL_V11_RERANK',
  'RETRIEVAL_V11_SEMANTIC',
  'RETRIEVAL_V11_LLM_RERANK',
  'RETRIEVAL_V11_DIALOG_GROUP',
  'RETRIEVAL_V11_GATE_FAILCLOSED',
  'RETRIEVAL_V11_GAP_LEDGER',
]);
