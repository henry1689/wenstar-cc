// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / fusion/weighted_rrf.ts
// Weighted RRF 融合：
//   score(d) = Σ_i w_i(p_A) / (k + rank_i(d))
//   k = 60（标准 RRF 常数）
//
// 权重随 p_A 插值（p_A=0 偏字面/档案，p_A=1 偏语义/PPR）：
//   w_bm25(p_A)        = 0.25 - 0.15*p_A
//   w_semantic(p_A)    = 0.10 + 0.25*p_A
//   w_ppr(p_A)         = 0.05 + 0.15*p_A
//   w_emotion(p_A)     = 0.05
//   w_blackdiamond(p_A) = 0.15 - 0.05*p_A
//   w_profile(p_A)      = 0.20 - 0.12*p_A
//   w_kb(p_A)           = 0.15 - 0.08*p_A
//   w_foresight(p_A)    = 0.05
//
// 权重表（p_A=0 / p_A=1 两端）：
//   leg          | w(0)  | w(1)
//   bm25         | 0.25  | 0.10
//   semantic     | 0.10  | 0.35
//   ppr          | 0.05  | 0.20
//   emotion      | 0.05  | 0.05
//   blackdiamond | 0.15  | 0.10
//   profile      | 0.20  | 0.08
//   kb           | 0.15  | 0.07
//   foresight    | 0.05  | 0.05
//   sum          | 1.00  | 1.00
// =====================================================================

import type { RawCandidate, Evidence, TimeRange } from '../types';

/**
 * 时间契合度（设计 §8.4「查询带时间表达时，区间外的条目乘 0.2」）。
 *
 * 🔴 这是 `QueryContext.time_range` 的**唯一消费点** —— 在此之前的实现里，
 *   时间表达被解析出来后只塞进 vec40 的几个维度，召回/融合/重排/MMR 全程不看，
 *   等于「前天」「上周」这些词对结果零影响。实测「前天的事还记得吗」
 *   召回的全是今天和昨天的内容。
 */
function computeTimeFit(ts: number, tr?: TimeRange): number {
  if (!tr) return 1;
  if (tr.abs_start == null && tr.abs_end == null) return 1; // 查询无时间表达
  const start = tr.abs_start ?? 0;
  const end = tr.abs_end ?? Date.now();
  return ts >= start && ts < end ? 1 : 0.2;
}

export const RRF_K = 60;

export type LegName =
  | 'bm25' | 'semantic' | 'ppr' | 'emotion'
  | 'blackdiamond' | 'profile' | 'kb' | 'foresight';

/** 权重插值函数（暴露给测试与 README） */
export function legWeights(p_A: number): Record<LegName, number> {
  const p = Math.max(0, Math.min(1, p_A));
  return {
    bm25: 0.25 - 0.15 * p,
    semantic: 0.10 + 0.25 * p,
    ppr: 0.05 + 0.15 * p,
    emotion: 0.05,
    blackdiamond: 0.15 - 0.05 * p,
    profile: 0.20 - 0.12 * p,
    kb: 0.15 - 0.08 * p,
    foresight: 0.05,
  };
}

interface FusedEntry {
  memory_id: string;
  text: string;
  source_namespace: string;
  rrf_score: number;
  recall_sources: string[];
  timestamp: number;
  strength: number;
  activation: number;
  recency: number;
  entities?: string[];
  emotion_vec?: number[];
}

/**
 * 输入：八路召回的结果（每路一个数组）
 * 输出：融合后的 Evidence[]（RRF + 先验 boost），按 score 降序
 */
export function weightedRRF(
  legs: Partial<Record<LegName, RawCandidate[]>>,
  p_A: number,
  topN: number = 50,
  timeRange?: TimeRange,
): Evidence[] {
  const w = legWeights(p_A);

  // 1. 每路按 raw_score 排序，给 rank
  const legRanks = new Map<LegName, Map<string, number>>(); // leg -> (id -> rank 1-based)
  for (const [legName, cands] of Object.entries(legs) as Array<[LegName, RawCandidate[]]>) {
    const sorted = [...cands].sort((a, b) => b.raw_score - a.raw_score);
    const rankMap = new Map<string, number>();
    sorted.forEach((c, i) => rankMap.set(c.memory_id, i + 1));
    legRanks.set(legName, rankMap);
  }

  // 2. 聚合所有 memory_id
  const agg = new Map<string, FusedEntry>();
  for (const [legName, cands] of Object.entries(legs) as Array<[LegName, RawCandidate[]]>) {
    for (const c of cands) {
      const rank = legRanks.get(legName)!.get(c.memory_id) ?? 999;
      const contrib = (w[legName] || 0) / (RRF_K + rank);
      let e = agg.get(c.memory_id);
      if (!e) {
        e = {
          memory_id: c.memory_id,
          text: c.text,
          source_namespace: c.source_namespace,
          rrf_score: 0,
          recall_sources: [],
          timestamp: c.timestamp,
          strength: c.strength,
          activation: c.activation,
          recency: c.recency,
          entities: c.entities,
          emotion_vec: c.emotion_vec,
        };
        agg.set(c.memory_id, e);
      }
      e.rrf_score += contrib;
      if (!e.recall_sources.includes(legName)) e.recall_sources.push(legName);
    }
  }

  // 3. 先验 boost（M3 巩固度/激活度）：RRF 之后、重排之前
  //    boost = 1 + 0.25*strength + 0.15*activation
  const out: Evidence[] = [];
  for (const e of agg.values()) {
    const boost = 1 + 0.25 * e.strength + 0.15 * e.activation;
    const timeFit = computeTimeFit(e.timestamp, timeRange);
    out.push({
      memory_id: e.memory_id,
      text: e.text,
      source_namespace: e.source_namespace,
      score: e.rrf_score * boost * timeFit,
      recall_sources: e.recall_sources,
      recency: e.recency,
      strength: e.strength,
      activation: e.activation,
      timestamp: e.timestamp,
      entities: e.entities,
      emotion_vec: e.emotion_vec,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topN);
}
