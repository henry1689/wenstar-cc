// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / recall/semantic_vector.ts
// 路②：语义向量召回（vec0 KNN）
//   - vec0 扩展未加载 / 无查询向量时降级 FTS5（不阻塞主流程）
//   - 查询向量 = 真实 512 维 embedding（EmbeddingProvider），不再是 40D 哈希投影
//   - 🔴 有时间表达时**窗内优先召回**：见 recall() 内注释
// =====================================================================

import type Database from 'better-sqlite3';
import type { QueryContext, RawCandidate } from '../types';
import { BaseRecallStrategy, isVec0Available } from './base';
import { Bm25Recall } from './bm25';

interface KnnRow {
  id: string;
  distance: number;
  text: string;
  created_at: number;
  consolidation: number | null;
  activation_cache: number | null;
}

export class SemanticVectorRecall extends BaseRecallStrategy {
  readonly name = 'semantic';
  private vec0Ready = false;
  private warned = false;

  constructor(db: Database.Database) {
    super(db);
    this.vec0Ready = isVec0Available(db);
  }

  isAvailable(): boolean {
    // 即使 vec0 未装也可用（降级 FTS5）
    return true;
  }

  async recall(q: QueryContext): Promise<RawCandidate[]> {
    // 🔴 两个前提缺一不可：① vec0 扩展在当前连接上可用；② 本次查询拿到了真实
    //   embedding（`semantic_vec`）。旧实现只判 ① 却拿 `q.vec40`（40D 哈希投影）
    //   去 MATCH 512 维表，维度不匹配必然抛错 —— 即使建了表也永远走降级。
    if (!this.vec0Ready || !q.semantic_vec || q.semantic_vec.length === 0) {
      if (!this.warned) {
        console.warn(
          this.vec0Ready
            ? '[memarch-recall] semantic_vec 缺失（embedding 未就绪或超时）；本腿降级 FTS5'
            : '[memarch-recall] vec0 extension not loaded; falling back to FTS5 for semantic leg',
        );
        this.warned = true;
      }
      const bm = new Bm25Recall(this.db);
      const out = await bm.recall(q);
      return out.slice(0, 15);
    }

    try {
      // 512 维真 embedding 序列化成 blob（sqlite-vec 接受 Float32 二进制）
      const buf = Buffer.from(new Float32Array(q.semantic_vec).buffer);

      /**
       * 🔴 时间窗内优先召回（设计 §8.4 的时间约束必须在**召回侧**就有着力点）。
       *
       * 只靠融合阶段的 timeFit ×0.2 不够：KNN 取的是全局 top20，当查询是
       * 「前天的事还记得吗」这类元问句时，top20 会被窗外的高相似问句占满
       * （实测 9 条全在窗外），窗内候选根本进不了融合，timeFit 无处发力。
       *
       * 所以：有时间窗时先做一次**窗内 KNN**；窗内有结果就只用窗内，
       * 窗内为空才退回全局（并靠 timeFit 对窗外打折）。
       */
      const tr = q.time_range;
      const hasWindow = tr != null && (tr.abs_start != null || tr.abs_end != null);
      const winLo = tr?.abs_start ?? 0;
      const winHi = tr?.abs_end ?? Number.MAX_SAFE_INTEGER;

      /**
       * 🔴 窗内召回必须用 `vec_distance_cosine` 暴力算，**不能用 KNN 的 k**。
       *   sqlite-vec 的 `k` 是「先取全局近似 top-k，再 JOIN 后过滤」——
       *   实测 `k=60` 时窗内 45 条一条都没进 top60，过滤后直接为空。
       *   k 调大也没用（窗内内容本来就不是语义最相似的）。
       *   窗内条数通常几十到几百，暴力算 512 维余弦只要 ~18ms，完全够。
       */
      const runKnn = (withWindow: boolean): KnnRow[] => {
        if (withWindow) {
          return this.db.prepare(`
            SELECT m.id AS id,
                   vec_distance_cosine(v.embedding, @emb) AS distance,
                   m.created_at AS created_at,
                   m.consolidation AS consolidation,
                   m.activation_cache AS activation_cache,
                   COALESCE(m.summary, m.raw_input, '') AS text
            FROM vec_mem_semantic v
            JOIN memories m ON m.id = v.trace_id
            WHERE m.namespace = @ns
              AND m.created_at >= @lo AND m.created_at < @hi
              AND m.lifecycle_state NOT IN ('tombstone', 'purged')
            ORDER BY distance ASC
            LIMIT 20
          `).all({ emb: buf, ns: q.namespace, lo: winLo, hi: winHi }) as KnnRow[];
        }
        return this.db.prepare(`
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
        `).all({ emb: buf, ns: q.namespace }) as KnnRow[];
      };

      let rows: KnnRow[] = hasWindow ? runKnn(true) : [];
      const usedWindow = rows.length > 0;
      if (rows.length === 0) rows = runKnn(false);
      if (usedWindow) {
        console.log(`[memarch-recall] semantic 时间窗命中 ${rows.length} 条（窗内优先）`);
      }

      return rows.map((r) =>
        this.buildCandidate({
          id: r.id,
          text: r.text,
          source_namespace: q.namespace,
          raw_score: 1 / (1 + r.distance), // 距离越小越相关
          created_at: r.created_at,
          strength: r.consolidation ?? 0,
          activation: r.activation_cache ?? 0,
        }),
      );
    } catch (e) {
      // 维度不匹配 / 其他运行时错误：降级 FTS5
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
