// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / recall/base.ts
// 鍏矾鍙洖鐨勬娊璞″熀绫伙細鎸佹湁 better-sqlite3 鍚屾杩炴帴锛屾彁渚涚粺涓€鍊欓€夋瀯閫?
// =====================================================================

import type Database from 'better-sqlite3';
import type { QueryContext, RawCandidate, RecallStrategy } from '../types';

export abstract class BaseRecallStrategy implements RecallStrategy {
  abstract readonly name: string;
  protected db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  isAvailable(): boolean {
    return true;
  }

  abstract recall(q: QueryContext): Promise<RawCandidate[]>;

  /** 鏋勯€?RawCandidate 鐨勫伐鍏锋柟娉曪紝缁熶竴琛?recency/strength/activation */
  protected buildCandidate(row: {
    id: string;
    text: string;
    source_namespace: string;
    raw_score: number;
    created_at: number;
    /** M3 consolidation 0~1 */
    strength: number;
    /** M3 activation_cache 0~1 */
    activation: number;
    entities?: string[];
    emotion_vec?: number[];
  }, now: number = Date.now()): RawCandidate {
    const DAY = 24 * 3600 * 1000;
    return {
      memory_id: row.id,
      text: row.text,
      source_namespace: row.source_namespace,
      raw_score: row.raw_score,
      timestamp: row.created_at,
      recency: (now - row.created_at) / DAY,
      strength: row.strength,
      activation: row.activation,
      entities: row.entities,
      emotion_vec: row.emotion_vec,
    };
  }
}

/** 宸ュ叿锛氭鏌?vec0 鎵╁睍鏄惁鍙敤 */
/**
 * 探测 vec0 扩展是否在**当前连接**上可用。
 *
 * 🔴 旧实现是假探测：它只查 `sqlite_master` 里有没有 `vec_mem_perception` 这张表。
 *    那个查询永远不抛异常（找不到就返回 undefined），所以**恒返回 true** ——
 *    即使扩展没加载、表不存在，也报告"可用"。实测导致 semantic/emotion 两条腿
 *    在 vec0 缺失时仍然走进 KNN 分支，靠外层 catch 才降级。
 *
 * 真探测必须调用扩展提供的函数：`vec_version()` 只在扩展加载后存在。
 */
export function isVec0Available(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT vec_version() AS v').get() as { v?: unknown } | undefined;
    return typeof row?.v === 'string' && row.v.length > 0;
  } catch {
    return false;
  }
}
