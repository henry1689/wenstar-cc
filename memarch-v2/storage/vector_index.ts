/**
 * vector_index — vec0 扩展加载与向量表建置
 *
 * 为什么需要这个文件：
 *   `memarch-v2/storage/ddl/04_vector_index.sql` 早就写好了 vec0 虚表定义，
 *   但**从来没有执行器** —— 实测 v2 库 35 张表里一张 vec_ 表都没有，
 *   semantic / emotion 两条召回腿 100% 降级到 FTS5，等于「向量检索」从未存在。
 *
 * 🔴 前置条件：`better-sqlite3` 打开连接时必须传 `{ allowExtension: true }`，
 *   否则 `loadExtension` 抛 "not authorized"。调用方负责这一点，本模块只做
 *   fail-closed 收敛 —— 加载失败返回 ok:false，**绝不抛给主流程**。
 *
 * 🔴 维度必须与 EmbeddingProvider.EMBEDDING_DIM 严格一致。
 *   sqlite-vec 的 MATCH 要求查询向量维度 == 建表维度，不一致直接报错。
 *   本轮取 512（bge-small-zh-v1.5），理由见 EmbeddingProvider 文件头。
 *
 * 🔴 幂等：全部 CREATE ... IF NOT EXISTS，重复调用无副作用。
 */
import type Database from 'better-sqlite3';
import { load as loadVecExtension } from 'sqlite-vec';

/** 语义向量维度 —— 必须与 EmbeddingProvider.EMBEDDING_DIM 一致 */
export const SEMANTIC_DIM = 512;
/** 情感感知向量维度 —— 对应主库 memories.perception_40d 的 40 维 */
export const PERCEPTION_DIM = 40;

export interface VectorIndexStatus {
  ok: boolean;
  /** vec0 扩展版本（ok=true 时存在） */
  version?: string;
  /** 失败原因（ok=false 时存在），供运维端点原样透出 */
  error?: string;
}

/**
 * 在给定连接上加载 vec0 扩展并建齐三张向量表。
 * 幂等、fail-closed：任何异常都收敛成 { ok:false, error }。
 */
export function ensureVectorIndex(db: Database.Database): VectorIndexStatus {
  try {
    loadVecExtension(db);

    const version = (db.prepare('SELECT vec_version() AS v').get() as { v?: string } | undefined)?.v;

    // 语义向量：memories 与 episodes 共用同一模型同一维度
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_mem_semantic USING vec0(
        trace_id TEXT PRIMARY KEY,
        embedding float[${SEMANTIC_DIM}]
      );
    `);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_ep_semantic USING vec0(
        episode_id TEXT PRIMARY KEY,
        embedding float[${SEMANTIC_DIM}]
      );
    `);
    // 情感感知向量：维度必须与主库 perception_40d 的 dims.length 一致
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_mem_perception USING vec0(
        trace_id TEXT PRIMARY KEY,
        embedding float[${PERCEPTION_DIM}]
      );
    `);

    return { ok: true, version: version || 'unknown' };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) };
  }
}

/** 只读探测：当前连接能否用 vec0（不建表，不产生副作用） */
export function probeVec0(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT vec_version() AS v').get() as { v?: unknown } | undefined;
    return typeof row?.v === 'string' && row.v.length > 0;
  } catch {
    return false;
  }
}

/** 向量表当前行数快照（运维端点用） */
export function vectorIndexStats(db: Database.Database): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const t of ['vec_mem_semantic', 'vec_ep_semantic', 'vec_mem_perception']) {
    try {
      out[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    } catch {
      out[t] = null; // 表不存在
    }
  }
  return out;
}
