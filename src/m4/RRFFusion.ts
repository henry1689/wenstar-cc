/**
 * RRFFusion — Weighted Reciprocal Rank Fusion (V12.0)
 * ===================================================
 * 公式: score(d) = Σ w_i × 1 / (k + rank_i(d))
 * k = 60（标准 RRF 平滑常数，rank 从 0 开始）
 *
 * 设计原则:
 *   - 纯排名融合，不依赖原始分值量纲（不需要 Min-Max/Z-Score）
 *   - 多路命中 bonus：≥2 路同时命中 → RRF ×1.2
 *   - 权重可配置
 */

import type { RankedList } from './types/retrieval.js';
import type { RRFFusedItem } from './types/retrieval.js';
// 🔴 P1 配置化: V13 RRF 权重从 yaml 读取（消除魔法数字）
import { getRetrievalFusionConfig } from '../config/retrieval-fusion-config.js';

export interface RRFConfig {
  /** RRF 平滑常数 */
  k: number;
  /** 四路权重: source → weight */
  weights: Record<string, number>;
  /** 多路命中 bonus 乘数（≥2 路命中时生效） */
  multiHitBonus: number;
}

/** 默认 RRF 配置 — 🔴 P1 配置化: 权重从 yaml 读取（retrieval-fusion.config.yaml） */
export const DEFAULT_RRF_CONFIG: RRFConfig = (() => {
  const w = getRetrievalFusionConfig().v13_rrf_weights;
  return {
    k: 60,
    weights: {
      spine:   w.spine ?? 0.35,   // 40D 语义联想路（主力信号）
      keyword: w.keyword ?? 0.30, // n-gram 关键词路（精确匹配）
      work:    w.work ?? 0.25,    // 作品直达路（长文召回，指称解析命中即置顶）
      entity:  w.entity ?? 0.20,  // 实体归属路（实体定向）
      emotion: w.emotion ?? 0.10, // 情绪路（权重较低，情绪共振放 L1 预筛层）
      locus:   w.locus ?? 0.05,   // 时序邻近路（时序围栏已在 L0 处理）
    },
    multiHitBonus: w.multi_hit_bonus ?? 1.2,
  };
})();

/**
 * Weighted RRF 融合
 *
 * @param lists    四路各自排好序的排名列表
 * @param config   RRF 配置（权重 + k 值）
 * @param topK     融合后保留条数
 * @returns        融合排序结果（按 RRF score 降序）
 */
export function weightedRRF(
  lists: RankedList[],
  config: RRFConfig = DEFAULT_RRF_CONFIG,
  topK: number = 50,
): RRFFusedItem[] {
  const scoreMap = new Map<string, { rrf: number; sources: number }>();

  for (const list of lists) {
    const w = config.weights[list.source] ?? 0.05;
    if (w <= 0) continue;

    for (let rank = 0; rank < list.items.length; rank++) {
      const id = list.items[rank].id;
      const rrf = w / (config.k + rank + 1);  // rank 从 0 开始，分母 +1 避免除零

      const existing = scoreMap.get(id);
      if (existing) {
        existing.rrf += rrf;
        existing.sources += 1;
      } else {
        scoreMap.set(id, { rrf, sources: 1 });
      }
    }
  }

  // 多路命中 bonus：≥2 路同时命中，RRF ×1.2
  for (const [id, val] of scoreMap) {
    if (val.sources >= 2) {
      scoreMap.set(id, { ...val, rrf: val.rrf * config.multiHitBonus });
    }
  }

  const result: RRFFusedItem[] = [...scoreMap.entries()]
    .map(([id, val]) => ({ id, rrfScore: val.rrf, sourceCount: val.sources }))
    .sort((a, b) => b.rrfScore - a.rrfScore);

  return result.slice(0, topK);
}

/**
 * 从 MultiRankResult 构建按 ID 索引的文本映射
 * 用于 RRF 后 enrichment（填充 text 字段）
 */
export function buildIdToItem(lists: RankedList[]): Map<string, RankedList['items'][0]> {
  const map = new Map<string, RankedList['items'][0]>();
  for (const list of lists) {
    for (const item of list.items) {
      if (!map.has(item.id)) {
        map.set(item.id, item);
      }
    }
  }
  return map;
}
