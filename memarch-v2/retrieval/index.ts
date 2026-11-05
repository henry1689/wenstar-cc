// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / index.ts
// 瀵瑰闂ㄩ潰锛歊etriever.retrieve(query) -> { evidence, metrics }
//
// 绠＄嚎锛?
//   raw_query
//     -> understandQuery (鈮?0ms)
//     -> 8-way parallel recall (鈮?20ms锛屾瘡璺嫭绔嬭秴鏃?
//     -> weighted RRF + M3 鍏堥獙 boost
//     -> cross-encoder rerank (鈮?00ms锛岃秴鏃剁洿鎺ョ敤 RRF top-K)
//     -> MMR (位=0.7) 鍘婚噸
//     -> Evidence[]
// =====================================================================

import type Database from 'better-sqlite3';
import type {
  QueryContext, RawCandidate, RecallStrategy,
  Evidence, DegradeBudget, RetrievalMetrics,
} from './types';
import { DEFAULT_DEGRADE } from './types';
import { understandQuery } from './query_understanding';
import { getEmbeddingProvider } from './embedding/EmbeddingProvider';
import { ensureEntityDict, matchEntitiesInQuery } from '../storage/entity_dict';
import { weightedRRF, LegName } from './fusion/weighted_rrf';
import { CrossEncoderReranker, getSharedCrossEncoder } from './rerank/cross_encoder';
import { mmrSelect } from './postprocess/mmr';
import { withTimeout } from './degrade/timeout_breaker';

import { Bm25Recall } from './recall/bm25';
import { SemanticVectorRecall } from './recall/semantic_vector';
import { PprRecall } from './recall/ppr';
import { Emotion40dRecall } from './recall/emotion_40d';
import { BlackDiamondRecall } from './recall/blackdiamond';
import { ProfileRecall } from './recall/profile';
import { KnowledgeBaseRecall } from './recall/knowledge_base';
import { ForesightRecall } from './recall/foresight';

export interface RetrieveResult {
  evidence: Evidence[];
  metrics: RetrievalMetrics;
}

export class Retriever {
  private db: Database.Database;
  private legs: RecallStrategy[];
  private reranker: CrossEncoderReranker;
  private budget: DegradeBudget;
  /** entity_names 字典是否已确保建表（首个查询时建一次） */
  private dictReady = false;

  constructor(db: Database.Database, budget: Partial<DegradeBudget> = {}) {
    this.db = db;
    this.budget = { ...DEFAULT_DEGRADE, ...budget };
    this.legs = [
      new Bm25Recall(db),
      new SemanticVectorRecall(db),
      new PprRecall(db),
      new Emotion40dRecall(db),
      new BlackDiamondRecall(db),
      new ProfileRecall(db),
      new KnowledgeBaseRecall(db),
      new ForesightRecall(db),
    ];
    // 用共享单例：预热（BridgeRegistry 启动时）与实际重排必须是同一个实例
    this.reranker = getSharedCrossEncoder();
  }

  /**
   * 主入口。
   *
   * 🔴 `opts.topK`：MMR 最终保留条数的**上限覆盖**。
   *   此前该参数**只在旧链路（legacy）路径上被使用**，v2 路径完全忽略它 ——
   *   调用方即使明确传 `topK: 8`，也仍然返回 `budget.mmr_top_k`（默认 20）。
   *   实测 V14 每次「命中 20 条」顶格，直接把上下文撑到 22000+ tokens 超限。
   */
  async retrieve(
    rawQuery: string,
    namespace: string,
    opts?: { topK?: number },
  ): Promise<RetrieveResult> {
    const finalTopK = Math.max(1, Math.min(opts?.topK ?? this.budget.mmr_top_k, 50));
    const metrics: RetrievalMetrics = {
      phase_ms: { query_understand: 0, embed: 0, recall_total: 0, rerank: 0 },
      recall_leg_ms: {},
      degraded_legs: [],
      rerank_skipped: false,
      final_count: 0,
    };

    // 1. 鏌ヨ鐞嗚В锛堚墹50ms锛?
    const qt0 = Date.now();
    const qWrap = await withTimeout(
      Promise.resolve().then(() => understandQuery(rawQuery, namespace)),
      this.budget.query_understand_ms,
      understandQuery(rawQuery, namespace, Date.now()) // fallback 鐢ㄥ悓姝ュ厹搴?
    );
    const q: QueryContext = qWrap.value;
    if (qWrap.timedOut) metrics.degraded_legs.push('query_understand');

    // 1b. 语义查询向量（真 embedding）。冷启动 ~2.6s 必然超出 embed_ms →
    //     此时 semantic_vec 留空，语义腿据此降级 FTS5，而不是拿 40D 哈希投影
    //     去 MATCH 512 维表（旧实现的必然失败路径）。
    const et0 = Date.now();
    const eWrap = await withTimeout(
      (async () => {
        try {
          const v = await getEmbeddingProvider().embed(rawQuery);
          return Array.from(v);
        } catch {
          return null;
        }
      })(),
      this.budget.embed_ms,
      null
    );
    if (eWrap.value && eWrap.value.length > 0) {
      q.semantic_vec = eWrap.value;
    } else {
      metrics.degraded_legs.push('semantic_embed');
    }
    metrics.phase_ms.query_understand = Date.now() - qt0;
    metrics.phase_ms.embed = Date.now() - et0;

    // 1c. 实体识别（PPR 种子）。
    //   `understandQuery.extractEntities` 只认括号/引号/英文词，中文人名一个都抽不出，
    //   所以 PPR 腿此前种子恒空 —— 即使 entity_edges 已迁满 13,636 行仍返回 0 条。
    //   这里用 entity_names 字典做最长匹配，把命中结果**归一化成 uuid** 覆盖掉
    //   表面字符串（`trace_entities.entity_uuid` 要的是 uuid，不是名字）。
    try {
      if (!this.dictReady) { ensureEntityDict(this.db); this.dictReady = true; }
      const hits = matchEntitiesInQuery(this.db, rawQuery);
      if (hits.length > 0) q.entities = hits;
    } catch {
      /* 字典表缺失时退回原行为，不影响其它腿 */
    }

    // 2. 鍏矾鍙洖骞惰锛堟瘡璺嫭绔嬭秴鏃?+ 鏁翠綋 120ms 纭笂闄愶級
    const rt0 = Date.now();
    const legTimeout = this.budget.recall_ms; // 姣忚矾鍚屾牱棰勭畻锛堝苟琛岋級
    const legResults = await Promise.all(
      this.legs.map(async (leg) => {
        const wrap = await withTimeout(
          (async () => {
            if (!leg.isAvailable()) return [] as RawCandidate[];
            return leg.recall(q);
          })(),
          legTimeout,
          [] as RawCandidate[]
        );
        metrics.recall_leg_ms[leg.name] = wrap.timedOut ? null : wrap.elapsed;
        if (wrap.timedOut) metrics.degraded_legs.push(leg.name);
        return { name: leg.name as LegName, data: wrap.value };
      })
    );
    // 鏁翠綋纭笂闄愶細濡傛灉骞惰鍚庢€绘椂闀夸粛瓒?120ms锛岃褰曚絾涓嶄涪寮冨凡瀹屾垚缁撴灉
    metrics.phase_ms.recall_total = Date.now() - rt0;

    const legsMap = Object.fromEntries(legResults.map((r) => [r.name, r.data])) as Partial<Record<LegName, RawCandidate[]>>;

    // 3. Weighted RRF + M3 鍏堥獙 boost
    // 第 4 参传入时间窗：设计 §8.4 要求「查询带时间表达时，区间外条目 ×0.2」
    const fused = weightedRRF(legsMap, q.p_A, this.budget.rerank_top_n, q.time_range);

    // 4. 閲嶆帓锛堚墹200ms锛岃秴鏃剁洿鎺ョ敤 RRF 缁撴灉锛?
    const rt1 = Date.now();
    const rWrap = await withTimeout(
      this.reranker.rerank(rawQuery, fused),
      this.budget.rerank_ms,
      fused, // 瓒呮椂 fallback锛歊RF 缁撴灉鐩存帴鐢?
      () => { metrics.rerank_skipped = true; }
    );
    const reranked = rWrap.value;
    metrics.phase_ms.rerank = Date.now() - rt1;

    // 5. MMR 鍘婚噸
    const final = mmrSelect(reranked, finalTopK, 0.7);
    metrics.final_count = final.length;

    return { evidence: final, metrics };
  }
}

export * from './types';
export { understandQuery } from './query_understanding';
export { weightedRRF, legWeights } from './fusion/weighted_rrf';
export { mmrSelect, packContext } from './postprocess/mmr';
