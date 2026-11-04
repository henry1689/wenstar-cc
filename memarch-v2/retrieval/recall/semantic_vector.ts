// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / recall/semantic_vector.ts
// 璺憽锛氳涔夊悜閲忓彫鍥烇紙vec0 KNN锛?
//   - vec0 鎵╁睍鏈姞杞芥椂锛歝onsole.warn + 鑷姩 fallback 鍒?FTS5锛堜笉闃诲涓绘祦绋嬶級
//   - TODO(embed): 鎺ュ叆 bge-small-zh 鍚庯紝灏?query_understanding 鐨?40D 鍝堝笇鎶曞奖
//                   鏇挎崲涓虹湡 1024D embedding锛涘綋鍓嶇敤 40D 鍝堝笇鍗犱綅銆?
// =====================================================================

import type Database from 'better-sqlite3';
import type { QueryContext, RawCandidate } from '../types';
import { BaseRecallStrategy, isVec0Available } from './base';
import { Bm25Recall } from './bm25';

export class SemanticVectorRecall extends BaseRecallStrategy {
  readonly name = 'semantic';
  private vec0Ready = false;
  private warned = false;

  constructor(db: Database.Database) {
    super(db);
    this.vec0Ready = isVec0Available(db);
  }

  isAvailable(): boolean {
    return true; // 鍗充娇 vec0 鏈涔熷彲鐢紙闄嶇骇涓?FTS5锛?
  }

  async recall(q: QueryContext): Promise<RawCandidate[]> {
    if (!this.vec0Ready) {
      if (!this.warned) {
        console.warn('[memarch-recall] vec0 extension not loaded; falling back to FTS5 for semantic leg');
        this.warned = true;
      }
      // 闄嶇骇锛氬鐢?Bm25Recall 鐨勭粨鏋滐紙浣嗘墦涓嶅悓鐨?label锛?
      const bm = new Bm25Recall(this.db);
      const out = await bm.recall(q);
      return out.slice(0, 15);
    }

    try {
      // 鎶?40D 鍚戦噺搴忓垪鎴?blob锛坰qlite-vec 鎺ュ彈 Float32 浜岃繘鍒讹級
      const buf = Buffer.from(new Float32Array(q.vec40).buffer);
      const sql = `
        SELECT s.trace_id AS id,
               s.distance AS distance,
               m.created_at AS created_at,
               m.consolidation AS consolidation,
               m.activation_cache AS activation_cache,
               COALESCE(m.summary, m.raw_input, '') AS text
        FROM vec_mem_semantic s
        JOIN memories m ON m.id = s.trace_id
        WHERE s.embedding MATCH @emb AND k = 20
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
          raw_score: 1 / (1 + r.distance), // 璺濈瓒婂皬瓒婄浉鍏?
          created_at: r.created_at,
          strength: r.consolidation ?? 0,
          activation: r.activation_cache ?? 0,
        })
      );
    } catch (e) {
      // 缁村害涓嶅尮閰?/ 鍏朵粬杩愯鏃堕敊璇細闄嶇骇鍒?FTS5
      if (!this.warned) {
        console.warn('[memarch-recall] semantic KNN failed, fallback to FTS5:', (e as Error).message);
        this.warned = true;
      }
      const bm = new Bm25Recall(this.db);
      const out = await bm.recall(q);
      return out.slice(0, 15);
    }
  }
}
