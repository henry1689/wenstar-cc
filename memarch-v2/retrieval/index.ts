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
import { weightedRRF, LegName } from './fusion/weighted_rrf';
import { CrossEncoderReranker } from './rerank/cross_encoder';
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
    this.reranker = new CrossEncoderReranker();
  }

  /** 涓诲叆鍙?*/
  async retrieve(rawQuery: string, namespace: string): Promise<RetrieveResult> {
    const metrics: RetrievalMetrics = {
      phase_ms: { query_understand: 0, recall_total: 0, rerank: 0 },
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
    metrics.phase_ms.query_understand = Date.now() - qt0;
    if (qWrap.timedOut) metrics.degraded_legs.push('query_understand');

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
    const fused = weightedRRF(legsMap, q.p_A, this.budget.rerank_top_n);

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
    const final = mmrSelect(reranked, this.budget.mmr_top_k, 0.7);
    metrics.final_count = final.length;

    return { evidence: final, metrics };
  }
}

export * from './types';
export { understandQuery } from './query_understanding';
export { weightedRRF, legWeights } from './fusion/weighted_rrf';
export { mmrSelect, packContext } from './postprocess/mmr';
