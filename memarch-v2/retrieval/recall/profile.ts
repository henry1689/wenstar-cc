// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / recall/profile.ts
// 路⑥：档案召回（用户 Profile / 长期档案）
//   - 走 v_fact_real 视图，domain IN ('dossier','preference')
//   - 与 query 实体/subject 匹配优先
// =====================================================================

import type Database from 'better-sqlite3';
import type { QueryContext, RawCandidate } from '../types';
import { BaseRecallStrategy } from './base';

export class ProfileRecall extends BaseRecallStrategy {
  readonly name = 'profile';

  async recall(q: QueryContext): Promise<RawCandidate[]> {
    const sql = `
      SELECT f.id AS id,
             f.subject_uuid || ' | ' || f.predicate || ' ' || COALESCE(f.object_text, '') AS text,
             f.recorded_at AS created_at,
             f.confidence AS confidence,
             f.subject_uuid AS subject_uuid
      FROM v_fact_real f
      WHERE f.domain IN ('dossier', 'preference')
      ORDER BY f.confidence DESC
      LIMIT 20
    `;
    const rows = this.db.prepare(sql).all() as Array<{
      id: string; text: string; created_at: number;
      confidence: number; subject_uuid: string;
    }>;

    // 实体匹配加权
    return rows.map((r) => {
      const entHit = q.entities.some((e) => r.subject_uuid.includes(e) || r.text.includes(e));
      return this.buildCandidate({
        id: r.id,
        text: r.text,
        source_namespace: 'v_fact_real',
        raw_score: (r.confidence || 0.5) + (entHit ? 0.3 : 0),
        created_at: r.created_at,
        strength: 0.9, // 档案事实默认高巩固
        activation: 0.5,
      });
    });
  }
}
