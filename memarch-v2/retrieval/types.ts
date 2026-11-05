// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / types.ts
// 对外统一类型契约：Evidence / QueryContext / RawCandidate / Strategy
// =====================================================================

/** 最终返回给 LLM 上下文的证据条目（严格遵循任务书 §接口契约） */
export interface Evidence {
  memory_id: string;
  text: string;
  /** M1 视图命名空间：v_mem_real / v_conv_real / v_ep_real / v_fact_real / v_bd_active ... */
  source_namespace: string;
  /** 融合后最终分（RRF + 先验 boost + rerank） */
  score: number;
  /** 命中了哪几路召回（如 ['bm25','semantic','ppr']） */
  recall_sources: string[];
  /** 距今天数（0=今天，越大越旧） */
  recency: number;
  /** M3 巩固度 0~1 */
  strength: number;
  /** M3 激活度 0~1 */
  activation: number;
  /** 记忆产生时间 epoch ms */
  timestamp: number;
  entities?: string[];
  /** 40D 中的情绪子向量（长度 10，对应 QueryContext.emotion_vec） */
  emotion_vec?: number[];
}

/** 查询理解阶段产出的统一上下文 */
export interface QueryContext {
  /**
   * 🔴 本次查询的命名空间（物理隔离的唯一边界）。
   *
   * 为什么必须在这里：此前隔离完全依赖 `v_mem_real` 视图，而该视图硬编码
   * `namespace = 'default'` —— 按角色分 ns 写入的数据一条都召回不到，且看起来
   * "隔离生效"（任何 ns 都命中 0 条，测不出区别）。namespace 必须是**显式参数**，
   * 和 time_range 同级，错了一眼能看见。
   */
  namespace: string;
  /** 原始用户查询文本 */
  raw_query: string;
  /** 40D 感知向量（设计文档 §1.3 perception_40d） */
  vec40: number[];
  /**
   * 🔴 语义查询向量（512 维，bge-small-zh-v1.5）。
   *
   * 为什么与 vec40 并列而不是复用：vec40 是**哈希投影**（token bigram → 10 维等），
   * 与库里 memories.perception_40d 的真实感知向量**不在同一空间**，拿它做
   * vec_mem_semantic 的 KNN 只会得到一个恒定的小距离。语义腿必须用真 embedding。
   *
   * 可选：embedding 冷启动要 ~2.6s，超出 query_understand 预算时该字段为
   * undefined，语义腿据此降级到 FTS5 而不是用零向量去污染结果。
   */
  semantic_vec?: number[];
  /** 重要性概率 p_A ∈ [0,1]：高=语义/PPR 权重上调，低=BM25/档案上调 */
  p_A: number;
  /** 解析出的实体（已归一化为 uuid 或表面字符串） */
  entities: string[];
  /** 情绪子向量（40D 中第 20~29 维切片） */
  emotion_vec: number[];
  /** 时间范围（相对时间窗） */
  time_range: TimeRange;
  /** 识别出的对话意图（前瞻召回用） */
  intent: string;
}

/** 时间范围：相对天数 or 绝对 epoch ms */
export interface TimeRange {
  /** 相对"最近 N 天"，null=不限 */
  recent_days: number | null;
  /** 绝对窗口 [start, end) epoch ms；null=不约束 */
  abs_start: number | null;
  abs_end: number | null;
}

/** 单路召回的原始候选（未融合） */
export interface RawCandidate {
  memory_id: string;
  text: string;
  source_namespace: string;
  /** 该路内部分数（任意尺度，融合时 RRF 归一化） */
  raw_score: number;
  /** 命中的实体（可选） */
  entities?: string[];
  timestamp: number;
  /** 距今天数（由 buildCandidate 计算） */
  recency: number;
  strength: number;
  activation: number;
  emotion_vec?: number[];
}

/** 八路召回统一 Strategy 接口 */
export interface RecallStrategy {
  /** 策略名（如 'bm25' / 'semantic' / 'ppr' ...） */
  readonly name: string;
  /** 是否可用（vec0 未加载时 semantic 置 false，自动跳过） */
  isAvailable(): boolean;
  /** 执行召回；实现必须做参数化查询，禁止 SQL 拼接 */
  recall(q: QueryContext): Promise<RawCandidate[]>;
}

/** 降级熔断配置 */
export interface DegradeBudget {
  /** 查询理解阶段硬超时（ms） */
  query_understand_ms: number;
  /**
   * 查询向量化硬超时（ms）。
   * 热态单条 ~30ms；冷启动要加载 ONNX session（~2.6s）—— 冷态必然超时，
   * 此时 `semantic_vec` 留空、语义腿降级 FTS5，**绝不能让首查卡住整条检索**。
   */
  embed_ms: number;
  /** 多路召回并行硬超时（ms，Promise.all 之外的整体 race） */
  recall_ms: number;
  /** 重排阶段硬超时（ms） */
  rerank_ms: number;
  /** RRF top-N 送入重排 */
  rerank_top_n: number;
  /** MMR 最终保留条数 */
  mmr_top_k: number;
}

export const DEFAULT_DEGRADE: DegradeBudget = {
  query_understand_ms: 50,
  embed_ms: 120,
  recall_ms: 120,
  rerank_ms: 200,
  rerank_top_n: 50,
  mmr_top_k: 20,
};

/** 监控指标（降级路径必须记录） */
export interface RetrievalMetrics {
  phase_ms: {
    query_understand: number;
    /** 查询向量化耗时（含冷启动超时判定） */
    embed: number;
    recall_total: number;
    rerank: number;
  };
  /** 各路召回实际耗时（ms），失败/超时为 null */
  recall_leg_ms: Record<string, number | null>;
  /** 被降级跳过的路名 */
  degraded_legs: string[];
  /** 重排是否因超时跳过 */
  rerank_skipped: boolean;
  /** 最终返回条数 */
  final_count: number;
}
