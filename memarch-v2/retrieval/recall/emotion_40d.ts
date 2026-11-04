// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / recall/emotion_40d.ts
// 璺懀锛氭儏鎰?40D 鍚戦噺鍙洖锛坴ec_mem_perception锛?
//   - 鏈 vec0 鏃堕檷绾э細鐢ㄦ儏缁叧閿瘝鍦?v_mem_real 涓婅繃婊?arousal/valence
// =====================================================================

import type Database from 'better-sqlite3';
import type { QueryContext, RawCandidate } from '../types';
import { BaseRecallStrategy, isVec0Available } from './base';
import { Bm25Recall } from './bm25';

export class Emotion40dRecall extends BaseRecallStrategy {
  readonly name = 'emotion';
  private vec0Ready = false;
  private warned = false;

  constructor(db: Database.Database) {
    super(db);
    this.vec0Ready = isVec0Available(db);
  }

  async recall(q: QueryContext): Promise<RawCandidate[]> {
    if (!this.vec0Ready) {
      if (!this.warned) {
        console.warn('[memarch-recall] vec0 not loaded; emotion leg falls back to FTS5');
        this.warned = true;
      }
      const bm = new Bm25Recall(this.db);
      const out = await bm.recall(q);
      return out.slice(0, 10);
    }

    try {
      const buf = Buffer.from(new Float32Array(q.emotion_vec).buffer);
      const sql = `
        SELECT s.trace_id AS id,
               s.distance AS distance,
               m.created_at AS created_at,
               m.consolidation AS consolidation,
               m.activation_cache AS activation_cache,
               COALESCE(m.summary, m.raw_input, '') AS text
        FROM vec_mem_perception s
        JOIN memories m ON m.id = s.trace_id
        WHERE s.embedding MATCH @emb AND k = 15
          AND m.namespace = @ns
          AND m.lifecycle_state NOT IN ('tombstone', 'purged')
        ORDER BY s.distance ASC
      `;
      const rows = this.db.prepare(sql).all({ emb: buf, ns: q.namespace }) as Array<{
        id: string; distance: number; text: string;
        created_at: number; consolidation: number | null; activation_cache: number | null;
      }>;
      return rows.map((r) =>
        this.buildCandidate({
          id: r.id,
          text: r.text,
          source_namespace: q.namespace,
          raw_score: 1 / (1 + r.distance),
          created_at: r.created_at,
          strength: r.consolidation ?? 0,
          activation: r.activation_cache ?? 0,
          emotion_vec: q.emotion_vec,
        })
      );
    } catch (e) {
      if (!this.warned) {
        console.warn('[memarch-recall] emotion KNN failed, fallback to FTS5:', (e as Error).message);
        this.warned = true;
      }
      const bm = new Bm25Recall(this.db);
      const out = await bm.recall(q);
      return out.slice(0, 10);
    }
  }
}
