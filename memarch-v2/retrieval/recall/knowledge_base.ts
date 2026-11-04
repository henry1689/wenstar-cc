// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / recall/knowledge_base.ts
// 路⑦：知识库召回（结构化知识条目）
//   - 走 v_fact_real，domain = 'kb'
//   - 用 MATCH 简易匹配（如已建 fts_facts），否则用 LIKE 扫描
// =====================================================================

import type Database from 'better-sqlite3';
import type { QueryContext, RawCandidate } from '../types';
import { BaseRecallStrategy } from './base';

export class KnowledgeBaseRecall extends BaseRecallStrategy {
  readonly name = 'kb';

  async recall(q: QueryContext): Promise<RawCandidate[]> {
    // 用 LIKE 做参数化模糊匹配（避免 SQL 注入，query 全部绑定）
    const like = `%${q.raw_query.slice(0, 30)}%`;
    const sql = `
      SELECT f.id AS id,
             f.subject_uuid || ' | ' || f.predicate || ' ' || COALESCE(f.object_text, '') AS text,
             f.recorded_at AS created_at,
             f.confidence AS confidence
      FROM v_fact_real f
      WHERE f.domain = 'kb'
        AND (
          f.object_text LIKE @like
          OR f.predicate LIKE @like
        )
      ORDER BY f.confidence DESC
      LIMIT 15
    `;
    const rows = this.db.prepare(sql).all({ like }) as Array<{
      id: string; text: string; created_at: number; confidence: number;
    }>;

    return rows.map((r) =>
      this.buildCandidate({
        id: r.id,
        text: r.text,
        source_namespace: 'v_fact_real',
        raw_score: r.confidence || 0.5,
        created_at: r.created_at,
        strength: 0.8,
        activation: 0.4,
      })
    );
  }
}
