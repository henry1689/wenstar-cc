/**
 * NoveltyDetector.ts — 新颖度检测器 (V3.0)
 * ==========================================
 * 生物海马体的关键功能：判断进入的信息是"新的"还是"熟悉的"。
 *
 * 新颖（novel）→ 高钙化初始值，标记 priority=high → 优先巩固
 * 熟悉（familiar）→ 仅更新已有索引的钙化 boost → 不重复存储
 *
 * 检测策略：
 *   1. 查 hippocampal_index 是否有相近的 context_signature
 *   2. 查 memories 表是否有相似内容（entity + emotion 维度）
 *   3. 综合计算新颖度分数 [0, 1]，0=完全熟悉，1=完全新颖
 *
 * 使用（在 M1 DNA 编码后立即调用）:
 *   const nd = new NoveltyDetector(sqlite);
 *   const score = nd.assess(dna, perception);
 *   if (score.novelty > 0.6) { calcium *= 1.5; priority = 'high'; }
 */
import type { SQLiteAdapter } from '../../../m2/SQLiteAdapter.js';
import type { DNA } from '../../../m1/types/dna.js';
import type { Perception24D } from '../../../m3/types/perception.js';
import { createHash } from 'node:crypto';

export interface NoveltyAssessment {
  /** 新颖度 [0,1]，>0.6=高新颖 */
  novelty: number;
  /** 最近的相似记忆 id（如果有） */
  nearestMatchId: string | null;
  /** 相似度 [0,1] */
  similarity: number;
  /** 建议的钙化系数（1.0=不变，>1=加强初始钙化） */
  calciumMultiplier: number;
  /** 检测方法 */
  method: 'index_lookup' | 'content_similarity' | 'entity_overlap' | 'fallback';
}

export class NoveltyDetector {
  private sqlite: SQLiteAdapter;

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
  }

  /**
   * 评估一条新记忆的新颖度
   */
  assess(dna: DNA, perception?: Perception24D): NoveltyAssessment {
    // 1. 查 hippocampal_index
    const sig = this._computeRawSignature(dna, perception);
    const indexResult = this._checkIndex(sig);
    if (indexResult) return indexResult;

    // 2. 查 memories 表内容相似度
    const contentResult = this._checkContentSimilarity(dna);
    if (contentResult.novelty < 0.8) return contentResult; // 找到相似内容 → 不新颖

    // 3. 实体重叠度
    const entityResult = this._checkEntityOverlap(dna);
    if (entityResult.novelty < 0.9) return entityResult;

    // 4. 完全新颖
    return {
      novelty: 1.0,
      nearestMatchId: null,
      similarity: 0,
      calciumMultiplier: 1.5,  // 高新颖 → 加强初始钙化
      method: 'fallback',
    };
  }

  // ── 策略① 稀疏索引命中 ──
  private _checkIndex(sig: string): NoveltyAssessment | null {
    try {
      const rows = this.sqlite.queryAll(
        "SELECT context_signature, calcium_boost, memory_locations FROM hippocampal_index WHERE context_signature = ? LIMIT 1",
        [sig]
      );
      if (rows && rows.length > 0) {
        const row = rows[0] as any;
        const boost = row.calcium_boost || 0;
        // 已有相似上下文 → 熟悉
        const novelty = Math.max(0, 1 - boost * 0.2); // boost 越高越熟悉
        const locs = JSON.parse(row.memory_locations || '[]') as string[];
        return {
          novelty,
          nearestMatchId: locs[0] || null,
          similarity: Math.min(1, boost * 0.2),
          calciumMultiplier: novelty > 0.5 ? 1.2 : 0.8, // 新颖→加强，熟悉→减弱
          method: 'index_lookup',
        };
      }
    } catch (e) { console.warn(`[NoveltyDetector] 操作失败`, (e as Error)?.message || e); }
    return null;
  }

  // ── 策略② 内容相似度 ──
  private _checkContentSimilarity(dna: DNA): NoveltyAssessment {
    try {
      const text = dna.raw_input || '';
      if (text.length < 5) return { novelty: 1, nearestMatchId: null, similarity: 0, calciumMultiplier: 1.5, method: 'fallback' };

      // 用关键词查最近 50 条记忆
      const keywords = text.match(/[一-龥]{2,4}/g)?.slice(0, 3) || [];
      if (keywords.length === 0) return { novelty: 1, nearestMatchId: null, similarity: 0, calciumMultiplier: 1.5, method: 'fallback' };

      // 取第一个有区分度的关键词做 LIKE 查询
      const kw = keywords.find(k => k.length >= 2 && !'的了在是我有和就不'.includes(k));
      if (!kw) return { novelty: 1, nearestMatchId: null, similarity: 0, calciumMultiplier: 1.5, method: 'fallback' };

      const rows = this.sqlite.queryAll(
        "SELECT id, raw_input, calcium_score FROM memories WHERE raw_input LIKE ? ORDER BY created_at DESC LIMIT 3",
        [`%${kw}%`]
      );
      if (rows && rows.length > 0) {
        const row = rows[0] as any;
        // 简单 Jaccard 相似度
        const existingWords = new Set(((row.raw_input || '') as string).match(/[一-龥]{2,4}/g) || []);
        const newWords = new Set(keywords);
        const intersection = [...newWords].filter(w => existingWords.has(w)).length;
        const union = new Set([...newWords, ...existingWords]).size;
        const similarity = union > 0 ? intersection / union : 0;

        const novelty = 1 - similarity;
        return {
          novelty,
          nearestMatchId: row.id as string,
          similarity,
          calciumMultiplier: novelty > 0.6 ? 1.3 : novelty > 0.3 ? 1.0 : 0.7,
          method: 'content_similarity',
        };
      }
    } catch (e) { console.warn(`[NoveltyDetector] 操作失败`, (e as Error)?.message || e); }
    return { novelty: 1, nearestMatchId: null, similarity: 0, calciumMultiplier: 1.5, method: 'fallback' };
  }

  // ── 策略③ 实体重叠度 ──
  private _checkEntityOverlap(dna: DNA): NoveltyAssessment {
    try {
      const names = (dna.entity_genes || [])
        .filter(e => e.type === 'person' && e.name !== '我')
        .map(e => e.name);
      if (names.length === 0) return { novelty: 1, nearestMatchId: null, similarity: 0, calciumMultiplier: 1.5, method: 'fallback' };

      // 查最近 10 条记忆中有多少包含同名实体
      const like = names.map(n => `entity_names LIKE '%${n}%'`).join(' OR ');
      const rows = this.sqlite.queryAll(
        `SELECT id FROM memories WHERE (${like}) ORDER BY created_at DESC LIMIT 5`
      );
      if (rows && rows.length >= 3) {
        // 很多记忆包含相同实体 → 熟悉话题
        const novelty = Math.max(0.2, 1 - rows.length * 0.2);
        return {
          novelty,
          nearestMatchId: (rows[0] as any).id as string,
          similarity: Math.min(0.8, rows.length * 0.2),
          calciumMultiplier: novelty > 0.5 ? 1.1 : 0.9,
          method: 'entity_overlap',
        };
      }
    } catch (e) { console.warn(`[NoveltyDetector] 操作失败`, (e as Error)?.message || e); }
    return { novelty: 1, nearestMatchId: null, similarity: 0, calciumMultiplier: 1.5, method: 'fallback' };
  }

  // ── 上下文签名 ──
  private _computeRawSignature(dna: DNA, perception?: Perception24D): string {
    const domain = dna.locus_path?.split('.').slice(0, 2).join('.') || 'root';
    const persons = (dna.entity_genes || [])
      .filter(e => e.type === 'person' && e.name !== '我')
      .map(e => e.name).sort().join('|');
    const emo = perception
      ? `${(perception.pleasure ?? 0) > 0.2 ? 'pos' : (perception.pleasure ?? 0) < -0.2 ? 'neg' : 'neu'}`
      : 'neu';
    const raw = `${domain}|${emo}|${persons}`;
    return createHash('sha256').update(raw).digest('hex').substring(0, 16);
  }
}
