/**
 * FiveStageGate.ts — 五级记忆闸门 (P0 核心基础设施)
 * ====================================================
 * 适配: 五级闸门详细设计规范 V1.0 / 蓝皮书 §4.1-4.3 / DNA V2.0
 *
 * 五级管道 (不可绕过, 不可关闭):
 *   G1 语义初筛    → HNSW Top-K, cosine ≥ 0.3
 *   G2 时空一致性  → location_fingerprint 比对, PASS/P1/P2/P3 分级
 *   G3 仿生遗忘    → applyDecay (math.ts 统一公式), floor=0.05
 *   G4 意图区分    → active_recall vs passive_chat (regex 触发)
 *   G5 话题壁垒    → 跨话题记忆 ×0.1 冻结
 *
 * 铁律 (蓝皮书 §4.1):
 *   1. 五级闸门不可关闭, 底层硬强制
 *   2. 瑶光空白期 (location_fingerprint 全0) → G2 全PASS但不跳过
 *   3. 单次检索必须经过全5级, 任何中间级不可跳过
 *
 * 使用:
 *   import { fiveStageGate } from '../m3/FiveStageGate.js';
 *   const filtered = fiveStageGate.filter(memories, query, context);
 */

// ── 类型 ────────────────────────────────────────────────

import { applyDecay } from '../m2/math.js';
import { M3_CONFIG } from '../config/M3Config.js';

// ── 类型 ────────────────────────────────────────────────

export interface ScoredMemory {
  id?: string;
  global_uid?: string;
  dna_root_id?: string;
  content?: string;
  summary?: string;
  raw_input?: string;
  calcium_score?: number;
  calcium_level?: number;
  effective_strength?: number;
  created_at?: string;
  timestamp_ms?: number;
  absolute_timestamp?: number;
  perception_40d?: string;  // V12.4 根除24D: perception_json → perception_40d
  location_fingerprint?: string;
  locus_path?: string;
  leaf_zone?: string;
  similarity_score?: number;
  cosine_score?: number;
  [key: string]: unknown;
}

export interface GateContext {
  /** 当前用户查询文本 */
  query: string;
  /** 当前区位指纹 (瑶光空白期为全0) */
  locationFingerprint?: string;
  /** 当前话题关键词 */
  topicKeywords?: string[];
  /** 上一个对话组的 topic (G5使用) */
  previousTopic?: string;
  /** 当前已过多少小时 (G3使用) */
  hoursSinceCreation?: (timestamp: number) => number;
}

export interface GateResult {
  /** G1-G5 过滤后的候选记忆 */
  passed: ScoredMemory[];
  /** 各级统计 */
  stageStats: {
    g1In: number; g1Out: number;
    g2In: number; g2Out: number; g2Suppressed: { P1: number; P2: number; P3: number };
    g3In: number; g3Out: number;
    g4In: number; g4Out: number;
    g5In: number; g5Out: number;
  };
  /** 是否发生降级 */
  degraded: boolean;
  degradationReasons: string[];
}

// ── 配置 (蓝皮书 §4.2) ────────────────────────────────

// V4.0 Phase 4: 阈值从 M3_CONFIG 读取（原硬编码值已迁移）
const _gcfg = M3_CONFIG.fiveStageGate;
const G1_COSINE_THRESHOLD = _gcfg.g1CosineThreshold;
const G2_SCORE_THRESHOLDS = {
  PASS: _gcfg.g2ScoreThresholds.PASS,
  P1: _gcfg.g2ScoreThresholds.P1,
  P2: _gcfg.g2ScoreThresholds.P2,
  P3: _gcfg.g2ScoreThresholds.P3,
};
const G2_SUPPRESSION_WEIGHTS = {
  P1: _gcfg.g2SuppressionWeights.P1,
  P2: _gcfg.g2SuppressionWeights.P2,
  P3: _gcfg.g2SuppressionWeights.P3,
};
const G3_DECAY_FLOOR = _gcfg.g3DecayFloor;
const G4_ACTIVE_RECALL_REGEX = new RegExp(_gcfg.g4ActiveRecallPattern);
const G5_TOPIC_FREEZE_WEIGHT = _gcfg.g5TopicFreezeWeight;

// ── 主闸门 ──────────────────────────────────────────────

export class FiveStageGate {
  private _stats = { calls: 0, totalFiltered: 0 };

  /** 执行全五级过滤。不可绕过。 */
  filter(
    candidates: ScoredMemory[],
    context: GateContext,
  ): GateResult {
    this._stats.calls++;
    const reasons: string[] = [];
    let degraded = false;
    let pool = [...candidates];

    const stats = {
      g1In: pool.length, g1Out: 0,
      g2In: 0, g2Out: 0, g2Suppressed: { P1: 0, P2: 0, P3: 0 },
      g3In: 0, g3Out: 0,
      g4In: 0, g4Out: 0,
      g5In: 0, g5Out: 0,
    };

    // ═══════ G1 语义初筛 ═══════
    if (pool.length > 0) {
      const threshold = G1_COSINE_THRESHOLD;

      // 如果候选自带相似度分, 直接筛选; 否则全部放行(G1依赖外部HNSW)
      const hasScores = pool.some(m => (m.cosine_score ?? m.similarity_score ?? 0) > 0);
      if (hasScores) {
        pool = pool.filter(m => {
          const score = m.cosine_score ?? m.similarity_score ?? 0;
          return score >= threshold;
        });
      }
      // 瑶光离线兼容 (白皮书 §4.3): G1 不因无向量而阻断
      stats.g1Out = pool.length;
    }

    // ═══════ G2 时空一致性 ═══════
    stats.g2In = pool.length;
    if (pool.length > 0) {
      const fingerprint = context.locationFingerprint || '';
      const isYaoguangOffline = !fingerprint || fingerprint === '0'.repeat(32) || fingerprint === '';

      const g2Filtered: ScoredMemory[] = [];
      for (const m of pool) {
        const mFingerprint = (m.location_fingerprint || '') as string;
        if (isYaoguangOffline || !mFingerprint || mFingerprint === '0'.repeat(32)) {
          // 瑶光空白期: 全PASS, 仅告警
          if (isYaoguangOffline && !reasons.includes('G2: 瑶光离线, 全PASS')) {
            reasons.push('G2: 瑶光离线, 全PASS');
          }
          g2Filtered.push(m);
          continue;
        }

        // 区位指纹距离 (简单Jaccard字符级)
        const score = this._fingerprintDistance(fingerprint, mFingerprint);
        if (score <= G2_SCORE_THRESHOLDS.PASS) {
          g2Filtered.push(m); // PASS: 直接通过
        } else if (score <= G2_SCORE_THRESHOLDS.P1) {
          stats.g2Suppressed.P1++;
          g2Filtered.push({ ...m, effective_strength: (m.effective_strength || 1) * G2_SUPPRESSION_WEIGHTS.P1 });
        } else if (score <= G2_SCORE_THRESHOLDS.P2) {
          stats.g2Suppressed.P2++;
          g2Filtered.push({ ...m, effective_strength: (m.effective_strength || 1) * G2_SUPPRESSION_WEIGHTS.P2 });
        } else {
          stats.g2Suppressed.P3++;
          g2Filtered.push({ ...m, effective_strength: (m.effective_strength || 1) * G2_SUPPRESSION_WEIGHTS.P3 });
        }
      }
      pool = g2Filtered;
      stats.g2Out = pool.length;
    }

    // ═══════ G3 仿生遗忘 ═══════
    stats.g3In = pool.length;
    if (pool.length > 0) {
      pool = pool.map(m => {
        const strength = m.effective_strength || 1;
        const calcium = m.calcium_score || 0;

        // 统一使用 math.ts 的 applyDecay 公式 (蓝皮书 §5.2)
        const ts = m.absolute_timestamp || m.timestamp_ms || Date.now();
        const daysSinceUpdate = (Date.now() - ts) / 86400000;
        const recallCount = (m as any).recall_count || 0;
        const decayed = Math.max(G3_DECAY_FLOOR, applyDecay(strength, calcium, Math.max(0.01, daysSinceUpdate), recallCount));

        // 回溯增强 (白皮书 §4.2): 每次检索 +0.2, 上限10
        const recallBoost = Math.min((m.calcium_score || 0) + 0.2, 10);

        return { ...m, effective_strength: decayed, calcium_score: recallBoost };
      });
      stats.g3Out = pool.length;
    }

    // ═══════ G4 意图区分 ═══════
    stats.g4In = pool.length;
    if (pool.length > 0) {
      const isActiveRecall = G4_ACTIVE_RECALL_REGEX.test(context.query);
      if (!isActiveRecall) {
        // 被动闲聊: 轻微降权非地标记忆
        pool = pool.map(m => {
          if (!(m as any).is_landmark || (m as any).is_landmark === 0) {
            return { ...m, effective_strength: (m.effective_strength || 1) * 0.8 };
          }
          return m;
        });
      }
      // 主动回忆: 不做降权, 直接全通过
      stats.g4Out = pool.length;
    }

    // ═══════ G5 话题壁垒 ═══════
    stats.g5In = pool.length;
    if (pool.length > 0 && context.previousTopic) {
      const prevTopic = context.previousTopic.toLowerCase();
      pool = pool.map(m => {
        const memText = ((m.content || m.raw_input || m.summary || '') as string).toLowerCase();
        // 前话题关键词不在当前记忆中 → 跨话题, 冻结
        const isCrossTopic = !memText.includes(prevTopic.substring(0, 3)); // 3字符前缀匹配
        if (isCrossTopic) {
          return { ...m, effective_strength: (m.effective_strength || 1) * G5_TOPIC_FREEZE_WEIGHT };
        }
        return m;
      });
      stats.g5Out = pool.length;
    } else {
      stats.g5Out = pool.length;
    }

    // ── 最终排序: effective_strength 高质量记忆优先 ──
    pool.sort((a, b) => (b.effective_strength || 0) - (a.effective_strength || 0));

    this._stats.totalFiltered += candidates.length - pool.length;

    return {
      passed: pool,
      stageStats: stats,
      degraded,
      degradationReasons: reasons,
    };
  }

  /** 区位指纹距离 (Jaccard字符级, 简单可计算) */
  private _fingerprintDistance(fp1: string, fp2: string): number {
    if (!fp1 || !fp2) return 0; // 任一方为空 → PASS
    if (fp1 === fp2) return 0;   // 完全匹配 → PASS
    // 按 ':' 分段后逐段比对
    const parts1 = fp1.split(':');
    const parts2 = fp2.split(':');
    let matchCount = 0;
    const maxLen = Math.max(parts1.length, parts2.length);
    for (let i = 0; i < Math.min(parts1.length, parts2.length); i++) {
      if (parts1[i] === parts2[i]) matchCount++;
    }
    return 1 - matchCount / maxLen;  // 0=完全匹配, 1=完全不匹配
  }

  /** 获取统计 */
  getStats() { return { ...this._stats }; }
}

// ── 单例 ────────────────────────────────────────────────

const _instance = new FiveStageGate();

/** 全局五级闸门实例 */
export function getFiveStageGate(): FiveStageGate { return _instance; }

/** 🔴 P071-Phase2批B: G4 主动回忆意图判定（导出供 DUAL_CHAIN 寻址先行复用同一正则，防口径漂移） */
export function isActiveRecallIntent(query: string): boolean {
  return G4_ACTIVE_RECALL_REGEX.test(query);
}
export { _instance as fiveStageGate };
