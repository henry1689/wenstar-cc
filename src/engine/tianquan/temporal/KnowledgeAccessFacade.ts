/**
 * KnowledgeAccessFacade.ts — 海马域统一只读查询门面 (V1.0 / BIONIC-002 Phase 3)
 * ============================================================================
 * 封装对 KnowledgeBase、SQLiteAdapter、HippocampalIndex 的只读查询，
 * 提供统一接口供 SceneSnapshotBuilder 使用。
 *
 * 设计目标（WS-TIANQUAN-BIONIC-001 §整改项③）:
 *   chat.ts 不再直接 import knowledgeBase / storage 做查询，
 *   统一通过此 facade 获取，所有结果经过 temporal 封装后再传递给 prefrontal。
 *
 * 使用:
 *   const facade = new KnowledgeAccessFacade(knowledgeBase, sqlite);
 *   const { knowledgeItems, memoryItems, experienceSummary } =
 *     await facade.queryByContext({ message, entities, perception });
 */
import type { KnowledgeBase } from '../../../m2/KnowledgeBase.js';
import type { SQLiteAdapter } from '../../../m2/SQLiteAdapter.js';
import { HippocampalIndex } from './HippocampalIndex.js';

export interface QueryContext {
  message: string;
  entities: string[];
  perception?: { pleasure: number; arousal: number; intimacy: number };
  sceneTags?: string[];
  topK?: number;
}

export interface KnowledgeAccessResult {
  /** 知识库检索结果（摘要仅含 title + 首100字） */
  knowledgeItems: Array<{ id: string; title: string; summary: string; tags: string[] }>;
  /** 记忆表检索结果（仅含事件摘要，不含原文） */
  memoryItems: Array<{ id: string; summary: string; calciumScore: number }>;
  /** 海马体已有经验摘要（来自 hippocampal_index） */
  experienceSummary: string | null;
  /** 情绪安抚建议（来自当前感知偏离基线的程度） */
  emotionRegulation: string | null;
}

export class KnowledgeAccessFacade {
  private knowledgeBase: KnowledgeBase;
  private sqlite: SQLiteAdapter;
  private hippocampalIndex: HippocampalIndex;

  constructor(knowledgeBase: KnowledgeBase, sqlite: SQLiteAdapter) {
    this.knowledgeBase = knowledgeBase;
    this.sqlite = sqlite;
    this.hippocampalIndex = new HippocampalIndex(sqlite);
  }

  /**
   * 按对话上下文执行多源联合查询
   * 替代 chat.ts 中分散的 knowledgeBase.search / storage.queryAll 调用
   */
  async queryByContext(ctx: QueryContext): Promise<KnowledgeAccessResult> {
    const topK = ctx.topK ?? 5;

    // ① 知识库加权检索
    const knowledgeItems = await this._queryKnowledge(ctx, topK);

    // ② 记忆表检索（实体重叠）
    const memoryItems = this._queryMemories(ctx, topK);

    // ③ 海马体已有经验摘要
    const experienceSummary = this._queryExperience(ctx.message);

    // ④ 情绪安抚建议
    const emotionRegulation = this._queryEmotionRegulation(ctx);

    return { knowledgeItems, memoryItems, experienceSummary, emotionRegulation };
  }

  /**
   * 事实回忆查询 — 从 memories 表中 LIKE 搜索历史事实
   * (从 chat.ts L1675-1686 迁移)
   */
  queryFactMemory(keyword: string, limit: number = 5): Array<{ rawInput: string }> {
    try {
      const rows = this.sqlite.queryAll(
        "SELECT raw_input FROM memories WHERE raw_input LIKE ? AND lifecycle_state != 'suppressed' ORDER BY created_at DESC LIMIT ?",
        [`%${keyword}%`, limit]
      );
      return (rows as any[]).map(r => ({ rawInput: (r as any).raw_input || '' }));
    } catch {
      return [];
    }
  }

  /**
   * 砂金库补充 — M4 检索不足时从 conversations 表兜底
   * (从 chat.ts L938-942 迁移)
   */
  queryConversationFallback(keyword: string, limit: number = 3): Array<{ content: string; timestamp: string }> {
    try {
      const rows = this.sqlite.queryAll(
        "SELECT content, timestamp FROM conversations WHERE content LIKE ? ORDER BY timestamp DESC LIMIT ?",
        [`%${keyword}%`, limit]
      );
      return (rows as any[]).map(r => ({
        content: ((r as any).content || '').substring(0, 60),
        timestamp: (r as any).timestamp || '',
      }));
    } catch {
      return [];
    }
  }

  /** 获取 HippocampalIndex 实例（供 SceneSnapshotBuilder 复用） */
  getHippocampalIndex(): HippocampalIndex {
    return this.hippocampalIndex;
  }

  // ═══════════════════════════════════════════════════════
  //  内部查询
  // ═══════════════════════════════════════════════════════

  private async _queryKnowledge(
    ctx: QueryContext, topK: number,
  ): Promise<KnowledgeAccessResult['knowledgeItems']> {
    try {
      const results = await this.knowledgeBase.weightedSearch(
        ctx.message,
        ctx.sceneTags || [],
        ctx.perception || { pleasure: 0, arousal: 0, intimacy: 0 },
        topK,
      );
      return results.slice(0, topK).map(r => ({
        id: (r as any).id || '',
        title: (r as any).title || '',
        summary: ((r as any).content || '').substring(0, 100),
        tags: Array.isArray((r as any).tags) ? (r as any).tags : [],
      }));
    } catch {
      return [];
    }
  }

  private _queryMemories(
    ctx: QueryContext, topK: number,
  ): KnowledgeAccessResult['memoryItems'] {
    try {
      const entityNames = ctx.entities.filter(
        n => n && n.length > 1 && n !== '我'
      );
      if (entityNames.length === 0) return [];

      // 🔴 修复(2026-09-11): memories 表**只有 fg_entity_names 列**，无 entity_names ——
      //   原 SQL 必然抛 "no such column: entity_names"，被 catch 吞掉 → 知识访问的记忆检索恒空。
      const likeClauses = entityNames.map(() => "fg_entity_names LIKE '%' || ? || '%'").join(' OR ');
      const rows = this.sqlite.queryAll(
        `SELECT id, raw_input, calcium_score FROM memories
         WHERE (${likeClauses}) AND lifecycle_state != 'suppressed'
         ORDER BY calcium_score DESC LIMIT ?`,
        [...entityNames, topK],
      );
      return (rows as any[]).map(r => ({
        id: (r as any).id || '',
        summary: ((r as any).raw_input || '').substring(0, 120),
        calciumScore: (r as any).calcium_score || 0.5,
      }));
    } catch {
      return [];
    }
  }

  private _queryExperience(message: string): string | null {
    try {
      const words = message.match(/[一-龥]{2,4}/g) || [];
      const word = words.find(
        (w: string) => w.length >= 2 && !'的了在是我有和就不人会也把被让从对跟说'.split('').some(c => w.includes(c))
      );
      if (!word) return null;
      return this.hippocampalIndex.lookupExperienceByKeyword(word);
    } catch {
      return null;
    }
  }

  private _queryEmotionRegulation(ctx: QueryContext): string | null {
    // Phase 3 骨架: 返回 null（Phase 4+ 接入 EmotionRegulator）
    return null;
  }
}
