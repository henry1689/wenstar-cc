/**
 * VectorReranker — 自有40D向量精排引擎 (V11.0；🔴 P072批2起 40D-only)
 * ==================================================
 * 对n-gram初筛后的候选记忆集合，用自有32维仿生心智向量做精细化重排。
 *
 * 核心能力：
 *   - 24维全维度余弦相似度（复用 memories.perception_json）
 *   - 情绪维度优先加权（00~05维外源情绪频谱）
 *   - 记忆衰减系数距离修正（新鲜高确信记忆前置）
 *   - 三档检索力度开关（内敛/均衡/全开）
 *
 * 设计原则（蓝皮书级硬约束）：
 *   - 零外部API，全量本地计算
 *   - n-gram不参与最终排序，排序权完全交给自有40D向量
 *   - 加权规则可配置
 */

import type { PerceptionState24 } from '../m3/types/perception.js';
import type { PerceptionV40 } from '../m3/types/perception-40d.js';
import { PERCEPTION_40D_KEYS } from '../m3/types/perception-40d.js';
import { decodePerceptionV40, cosineSimilarity40D, arrayToPerceptionV40 } from '../m2/PerceptionVector40DCodec.js';
import { isPerception40DEnabled } from '../config/perception-40d-config.js';

// ── 可配置加权参数 ──
export interface RerankerConfig {
  /** 情绪频谱权重 (00-05维) */
  emotionWeight: number;
  /** 全维度语义权重 */
  fullDimWeight: number;
  /** 钙化分权重 */
  calciumWeight: number;
  /** 衰减惩罚系数 λ */
  decayLambda: number;
  /** 置信度增益系数 β */
  confidenceBeta: number;
  /** 检索力度: 内敛(20) | 均衡(50) | 全开(100) */
  ef: number;
  /** 钙化分最低门槛 */
  minCalciumLevel: number;
}

export type SearchMode = 'introvert' | 'balanced' | 'full';

const MODE_CONFIGS: Record<SearchMode, RerankerConfig> = {
  introvert: {
    emotionWeight: 0.40, fullDimWeight: 0.20, calciumWeight: 0.25,
    decayLambda: 0.03, confidenceBeta: 0.10,
    ef: 20, minCalciumLevel: 1,
  },
  balanced: {
    emotionWeight: 0.35, fullDimWeight: 0.25, calciumWeight: 0.20,
    decayLambda: 0.02, confidenceBeta: 0.10,
    ef: 50, minCalciumLevel: 0,
  },
  full: {
    emotionWeight: 0.30, fullDimWeight: 0.30, calciumWeight: 0.15,
    decayLambda: 0.01, confidenceBeta: 0.15,
    ef: 100, minCalciumLevel: 0,
  },
};

/** 候选记忆条目（统一接口） */
export interface MemoryCandidate {
  id: string;
  text: string;                               // 记忆文本
  source: 'conversation' | 'memory' | 'black_diamond' | 'knowledge_base';
  // 🔴 P072 批2: 原 perceptionJson(24D) 字段已删——向量字段唯一 = perception40d
  perception40d?: string | null;              // V20: JSON: PerceptionV40（40D 数组，唯一合法向量字段）
  calciumScore?: number;
  calciumLevel?: number;
  confidenceScore?: number;
  effectiveStrength?: number;
  createdAt?: string;
  entityUuid?: string | null;
}

/** 排序后的记忆条目 */
export interface RankedMemory {
  item: MemoryCandidate;
  score: number;          // 综合得分 0~1
  emotionSim: number;     // 情绪维度相似度
  fullSim: number;        // 全维度相似度
  decay: number;          // 衰减系数
}

/**
 * 🔴 P072 批2（2026-10-24）：原 cosineSimilarity(24维)、perceptionToArray(24D→数组)、
 * REVERSE_40_TO_24 反解、parseStoredVector(24兼容解析)、perceptionV40ObjectTo24DArray
 * 已全部删除——精排唯一合法输入 = 40D（《40D 量纲统一法令》）。
 */

/** 🔴 P072 批2 墓碑：原 REVERSE_40_TO_24 反解映射、perceptionV40ArrayTo24DArray、
 * perceptionV40ObjectTo24DArray、parseStoredVector(24兼容解析) 已全部删除——
 * 禁止 40D→24D 反解链（40D 量纲统一法令）。Offline 图改直用 40D（full-pipeline 测试已同步）。 */

/**
 * 对候选记忆集合做 40D 向量精排（🔴 P072 批2: 原 24 维 queryVec 参数已删——查询向量唯一合法形态 = queryVec40D 原生40D）
 *
 * @param candidates  n-gram初筛后的候选集
 * @param mode        检索力度模式
 * @param queryVec40D M3 原生 40D 查询向量
 * @returns 按综合得分降序排列的排序结果
 */
export function rankByVector(
  candidates: MemoryCandidate[],
  mode: SearchMode = 'balanced',
  queryVec40D?: number[] | null,
): RankedMemory[] {
  if (candidates.length === 0) return [];

  const cfg = MODE_CONFIGS[mode];
  const results: RankedMemory[] = [];

  for (const item of candidates) {
    // 1. 钙化门槛过滤
    if ((item.calciumLevel ?? 1) < cfg.minCalciumLevel) continue;

    // V20: 检索 — 有 40D 感知向量则走 40D 扇区加权余弦，无则按钙化基础分（P072批2: 24D回退已删）
    const p40 = isPerception40DEnabled() ? decodePerceptionV40(item.perception40d) : null;
    const q40 = p40 && queryVec40D && queryVec40D.length === 40 ? arrayToPerceptionV40(queryVec40D) : null;
    if (p40 && q40) {
      const sim40 = cosineSimilarity40D(q40, p40);
      const decay = item.createdAt
        ? Math.exp(-cfg.decayLambda * ((Date.now() - new Date(item.createdAt).getTime()) / 86_400_000))
        : 1;
      const confidence = 1 + ((item.confidenceScore ?? 0.5) - 0.5) * cfg.confidenceBeta;
      const calcium = (item.calciumScore ?? 1) / 10;
      let score = cfg.emotionWeight * sim40
                + cfg.fullDimWeight * sim40
                + cfg.calciumWeight * calcium
                + cfg.confidenceBeta * confidence
                + 0.10 * decay;
      if ((item.effectiveStrength ?? 1) < 0.3) score *= 0.7;
      results.push({ item, score: Math.min(score, 1), emotionSim: sim40, fullSim: sim40, decay });
      continue;
    }

    // 🔴 P072 批2（2026-10-24）：原「无 40D → 回退 24D 路径」（24 维解析+6维情绪余弦+24维全维余弦合成）
    //  已整体删除——禁止任何 24 维量纲参与精排（40D 量纲统一法令）。无 40D 向量 → 钙化基础分。
    const score = (item.calciumScore ?? 0.5) / 10 * cfg.calciumWeight;
    results.push({
      item, score: Math.min(score, 1),
      emotionSim: 0, fullSim: 0, decay: 1,
    });
  }

  // 排序
  results.sort((a, b) => b.score - a.score);

  // ef 截断
  const capped = results.slice(0, cfg.ef);
  return capped;
}

export function getModeConfig(mode: SearchMode): RerankerConfig {
  return MODE_CONFIGS[mode];
}

export default { rankByVector, getModeConfig };
