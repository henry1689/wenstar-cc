// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / recall/ppr.ts
// 路③：PPR 个性化 PageRank 实体图扩散
//   - 种子：query.entities
//   - 阻尼 α=0.85，迭代 ≤ 20 次
//   - 超时（>30ms）直接截断返回当前结果
//   - 通过 trace_entities 把实体得分映射回 memory
// =====================================================================

import type Database from 'better-sqlite3';
import type { QueryContext, RawCandidate } from '../types';
import { BaseRecallStrategy } from './base';

const ALPHA = 0.85;
const MAX_ITER = 20;
const TIME_BUDGET_MS = 30;

interface EdgeRow { src_uuid: string; dst_uuid: string; weight: number }

export class PprRecall extends BaseRecallStrategy {
  readonly name = 'ppr';

  async recall(q: QueryContext): Promise<RawCandidate[]> {
    if (q.entities.length === 0) return [];

    const t0 = Date.now();
    // 1. 加载邻接表（内存，小图直接全量；大图可改按种子邻域剪枝）
    const edges = this.db
      .prepare(`SELECT src_uuid, dst_uuid, weight FROM entity_edges`)
      .all() as EdgeRow[];

    // 邻接表：src -> [{dst, w}]
    const adj = new Map<string, Array<{ dst: string; w: number }>>();
    const outW = new Map<string, number>();
    for (const e of edges) {
      if (!adj.has(e.src_uuid)) adj.set(e.src_uuid, []);
      adj.get(e.src_uuid)!.push({ dst: e.dst_uuid, w: e.weight || 1 });
      outW.set(e.src_uuid, (outW.get(e.src_uuid) || 0) + (e.weight || 1));
    }

    // 2. 种子向量
    const p = new Map<string, number>();
    const seedSum = 1 / q.entities.length;
    for (const ent of q.entities) p.set(ent, seedSum);

    // 3. PPR 迭代
    for (let it = 0; it < MAX_ITER; it++) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break; // 超时截断
      const next = new Map<string, number>();
      // teleports 项 (1-α) * p0
      for (const [k, v] of p) next.set(k, (1 - ALPHA) * v);
      // 扩散项 α * M^T * p
      for (const [src, w] of p) {
        const outs = adj.get(src);
        if (!outs) continue;
        const total = outW.get(src) || 1;
        for (const o of outs) {
          next.set(o.dst, (next.get(o.dst) || 0) + ALPHA * w * (o.w / total));
        }
      }
      // 收敛检查
      let diff = 0;
      for (const [k, v] of next) diff += Math.abs(v - (p.get(k) || 0));
      p.clear();
      for (const [k, v] of next) p.set(k, v);
      if (diff < 1e-6) break;
    }

    // 4. 把实体得分映射回 memory（top 实体对应的 trace）
    const topEnts = Array.from(p.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([e, s]) => ({ e, s }));
    if (topEnts.length === 0) return [];

    const placeholders = topEnts.map(() => `?`).join(',');
    const entScore = new Map(topEnts.map((x) => [x.e, x.s]));
    const entParams = topEnts.map((x) => x.e);

    const sql = `
      SELECT te.trace_id AS id,
             te.entity_uuid AS entity_uuid,
             m.created_at AS created_at,
             m.consolidation AS consolidation,
             m.activation_cache AS activation_cache,
             COALESCE(m.summary, m.raw_input, '') AS text
      FROM trace_entities te
      JOIN memories m ON m.id = te.trace_id
      WHERE te.entity_uuid IN (${placeholders})
        AND m.namespace = ?
        AND m.lifecycle_state NOT IN ('tombstone', 'purged')
    `;
    // ns 作为最后一个位置参数（与 IN 的 placeholders 混用命名参数有歧义）
    const rows = this.db.prepare(sql).all(...entParams, q.namespace) as Array<{
      id: string; entity_uuid: string; text: string;
      created_at: number; consolidation: number | null; activation_cache: number | null;
    }>;

    // 聚合：同一 memory 可能命中多个实体
    const agg = new Map<string, RawCandidate>();
    for (const r of rows) {
      const s = entScore.get(r.entity_uuid) || 0;
      const cur = agg.get(r.id);
      const cand = this.buildCandidate({
        id: r.id,
        text: r.text,
        source_namespace: q.namespace,
        raw_score: (cur?.raw_score ?? 0) + s,
        created_at: r.created_at,
        strength: r.consolidation ?? 0,
        activation: r.activation_cache ?? 0,
      });
      agg.set(r.id, cand);
    }
    return Array.from(agg.values()).sort((a, b) => b.raw_score - a.raw_score).slice(0, 20);
  }
}
