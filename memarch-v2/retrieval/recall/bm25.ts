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

    // ── 双路召回（业主 2026-11-06 选 A「先回退，修完再切」）──────────────
    // FTS5 trigram 要求查询词 **>= 3 字符**，2 字中文查询 MATCH 恒返回 0 条。
    // 实测 ns_yuyao 域 SQL 真值 vs 检索：
    //   鸿艺 1453 → 0 ；声音 225 → 0 ；玉瑶 1633 → 10（靠 semantic/emotion/ppr 兜底）
    //   谁在说话(4字) 5 → 5 ✅
    // 故：>=3 走 FTS（原生支持 + bm25 相关性分），<3 走 LIKE 子串兜底。
    // 两路按 id 合并去重，**FTS 优先**（保留相关性分），LIKE 结果只补位、按时间倒序。
    const allTokens = q.raw_query
      .split(/[\s,，。.；;？?！!]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 1)
      .slice(0, 8);
    const ftsTokens = allTokens.filter((t) => t.length >= 3);
    const shortTokens = allTokens.filter((t) => t.length < 3).slice(0, 4);

    const byId = new Map<string, RawCandidate>();
    const base = {
      ns: q.namespace,
      abs_start: q.time_range.abs_start,
      abs_end: q.time_range.abs_end,
      limit,
    };

    // ── 腿 A：FTS5（>=3 字符，trigram 原生支持）────────────────────────
    if (ftsTokens.length > 0) {
      // 双引号是 FTS5 短语定界符，查询词内出现时须转义为 ""
      const matchExpr = ftsTokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      const ftsSql = `
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
      const rows = this.db.prepare(ftsSql).all({ ...base, q: matchExpr }) as Array<{
        id: string; text: string; score: number;
        created_at: number; consolidation: number | null; activation_cache: number | null;
      }>;
      // FTS5 bm25() returns "smaller = more relevant" cost score; negate it.
      for (const r of rows) {
        byId.set(r.id, this.buildCandidate({
          id: r.id, text: r.text, source_namespace: q.namespace,
          raw_score: -r.score, created_at: r.created_at,
          strength: r.consolidation ?? 0, activation: r.activation_cache ?? 0,
        }));
      }
    }

    // ── 腿 B：LIKE 兜底（<3 字符，trigram 不支持）──────────────────────
    // 转义字符用 '|'（不用反斜杠：模板字符串里 '\' 会被 JS 先行吃掉，易写错）。
    if (shortTokens.length > 0) {
      const esc = (s: string) => '%' + s.replace(/[|%_]/g, (c) => '|' + c) + '%';
      const likeParams: Record<string, string | null> = {};
      const orClauses: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const v = shortTokens[i - 1] ?? null;
        likeParams['l' + i] = v === null ? null : esc(v);
        orClauses.push(`(@l${i} IS NOT NULL AND (COALESCE(m.summary,'') || COALESCE(m.raw_input,'')) LIKE @l${i} ESCAPE '|')`);
      }
      const likeSql = `
        SELECT m.id AS id,
               COALESCE(m.summary, m.raw_input, '') AS text,
               m.created_at AS created_at,
               m.consolidation AS consolidation,
               m.activation_cache AS activation_cache
        FROM memories m
        WHERE m.namespace = @ns
          AND m.lifecycle_state NOT IN ('tombstone', 'purged')
          AND (@abs_start IS NULL OR m.created_at >= @abs_start)
          AND (@abs_end   IS NULL OR m.created_at <= @abs_end)
          AND (${orClauses.join(' OR ')})
        ORDER BY m.created_at DESC
        LIMIT @limit
      `;
      const likeRows = this.db.prepare(likeSql).all({ ...base, ...likeParams }) as Array<{
        id: string; text: string;
        created_at: number; consolidation: number | null; activation_cache: number | null;
      }>;
      // score=0 → raw_score=0，自然排在 FTS 结果之后；且不覆盖 FTS 已有的同 id 项。
      for (const r of likeRows) {
        if (byId.has(r.id)) continue;
        byId.set(r.id, this.buildCandidate({
          id: r.id, text: r.text, source_namespace: q.namespace,
          raw_score: 0, created_at: r.created_at,
          strength: r.consolidation ?? 0, activation: r.activation_cache ?? 0,
        }));
      }
    }

    return [...byId.values()];
  }
}
