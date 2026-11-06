// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / recall/bm25.ts
// Leg 1: BM25 full-text recall via FTS5 (trigram tokenizer).
// Uses v_mem_real view for namespace isolation. Parameterized MATCH.
// =====================================================================

import type Database from 'better-sqlite3';
import type { QueryContext, RawCandidate } from '../types';
import { BaseRecallStrategy } from './base';

export class Bm25Recall extends BaseRecallStrategy {
  readonly name = 'bm25';

  constructor(db: Database.Database) {
    super(db);
  }

  isAvailable(): boolean {
    const row = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='fts_memories'`)
      .get() as { name?: string } | undefined;
    return !!row;
  }

  async recall(q: QueryContext): Promise<RawCandidate[]> {
    const limit = 30;
    if (!this.isAvailable()) return [];

    // Split raw query into tokens, join with OR to avoid AND being too strict.
    // 🔴 FTS5 trigram 要求查询词 **>= 3 字符**，否则 MATCH 恒返回 0 条。
    //   实测：match '诗雨'(2字)=0 / '诗雨晚'(3字)=5 / 'the'(3字符)=25。
    //   原注释「trigram handles CJK bigrams automatically」是错的 —— trigram 切的是
    //   三元组不是 bigram；length>=2 的 token 会被保留却永远匹配不上，2 字中文查询
    //   （诗雨/电机/晚安…）在本腿静默失效，只能靠其他腿兜底。
    const tokens = q.raw_query
      .split(/[\s,，。.；;？?！!]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
      .slice(0, 8);
    const matchExpr = tokens.length > 0
      ? tokens.map((t) => `"${t}"`).join(' OR ')
      : q.raw_query;

    const sql = `
      SELECT m.id AS id,
             COALESCE(m.summary, m.raw_input, '') AS text,
             bm25(fts_memories) AS score,
             m.created_at AS created_at,
             m.consolidation AS consolidation,
             m.activation_cache AS activation_cache
      FROM fts_memories
      JOIN memories m ON m.id = fts_memories.trace_id
      WHERE fts_memories MATCH @q
        AND m.namespace = @ns
        AND m.lifecycle_state NOT IN ('tombstone', 'purged')
        AND (@abs_start IS NULL OR m.created_at >= @abs_start)
        AND (@abs_end   IS NULL OR m.created_at <= @abs_end)
      ORDER BY score ASC
      LIMIT @limit
    `;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all({
      q: matchExpr,
      ns: q.namespace,
      abs_start: q.time_range.abs_start,
      abs_end: q.time_range.abs_end,
      limit,
    }) as Array<{
      id: string; text: string; score: number;
      created_at: number; consolidation: number | null; activation_cache: number | null;
    }>;

    // FTS5 bm25() returns "smaller = more relevant" cost score; negate it.
    return rows.map((r) =>
      this.buildCandidate({
        id: r.id,
        text: r.text,
        source_namespace: q.namespace,
        raw_score: -r.score,
        created_at: r.created_at,
        strength: r.consolidation ?? 0,
        activation: r.activation_cache ?? 0,
      })
    );
  }
}
