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
export function isVec0Available(db: Database.Database): boolean {
  try {
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vec_mem_perception'`).get();
    return true;
  } catch {
    return false;
  }
}
