// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / recall/blackdiamond.ts
// 路⑤：黑钻召回（高巩固度 / 高激活度历史记忆优先）
//   - 走 v_bd_active 视图（M1 已过滤 status='active'）
//   - 叠加 v_mem_real：consolidation > 0.7 且 activation_cache > 0.5
//   - "近期激活"代理：last_reinforced_at 在最近 30 天
// =====================================================================

import type Database from 'better-sqlite3';
import type { QueryContext, RawCandidate } from '../types';
import { BaseRecallStrategy } from './base';

export class BlackDiamondRecall extends BaseRecallStrategy {
  readonly name = 'blackdiamond';

  async recall(q: QueryContext): Promise<RawCandidate[]> {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 3600 * 1000;

    const sql = `
      SELECT m.id AS id,
             COALESCE(m.summary, m.raw_input, '') AS text,
             m.created_at AS created_at,
             m.consolidation AS consolidation,
             m.activation_cache AS activation_cache,
             bd.self_defining AS self_defining
      FROM black_diamond_v2 bd
      JOIN memories m ON m.id = bd.ref_id
      WHERE bd.ref_type = 'trace'
        AND m.namespace = @ns
        AND m.lifecycle_state NOT IN ('tombstone', 'purged')
        AND m.consolidation > 0.7
        AND m.activation_cache > 0.5
      ORDER BY (m.activation_cache + COALESCE(bd.self_defining, 0)) DESC
      LIMIT 15
    `;
    const rows = this.db.prepare(sql).all({ ns: q.namespace }) as Array<{
      id: string; text: string; created_at: number;
      consolidation: number | null; activation_cache: number | null;
      self_defining: number | null;
    }>;

    return rows.map((r) =>
      this.buildCandidate({
        id: r.id,
        text: r.text,
        source_namespace: q.namespace,
        raw_score: 0.5 + (r.activation_cache || 0) * 0.5 + (r.self_defining || 0) * 0.3,
        created_at: r.created_at,
        strength: r.consolidation ?? 0,
        activation: r.activation_cache ?? 0,
      })
    );
  }
}
