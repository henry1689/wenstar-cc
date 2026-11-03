/**
 * ConversationAdapter — 砂金库（对话）存储域适配器（Foundation V1.0）
 * =================================================================
 * 原始对话（conversations 表，is_compacted=0）检索。
 *
 * ⚠️ 默认不注册：对话域已由 V11 search 的 conversation 源 + V13 keyword/locus 路 +
 *   时间导航检索覆盖。独立接入会与主链重复注入。供未来 SearchOrchestrator 显式启用。
 */

import type { RetrievalAdapter } from '../adapter.js';
import type { RetrievalContext, SearchHit } from '../types.js';
import { buildSqlClause } from '../../../governance/police/UUIDPoliceFilter.js';

/** 对话行 */
export interface ConversationRow {
  id: number;
  role: string;
  content: string;
  timestamp: string;
  belong_entity_uuid?: string | null;
}

/** 数据源接口（兼容 SQLiteAdapter） */
export interface ConversationSqlSource {
  queryAll<T = unknown>(sql: string, params?: unknown[]): T[];
}

export class ConversationAdapter implements RetrievalAdapter {
  readonly domain = 'conversation' as const;
  readonly routes = ['conversation'] as const;

  constructor(private sqlite: ConversationSqlSource) {}

  search(ctx: RetrievalContext): Promise<SearchHit[]> {
    const query = ctx.query.trim();
    if (query.length < 2) return Promise.resolve([]);
    try {
      const police = buildSqlClause(ctx.policy);
      const limit = ctx.limit ?? 5;
      const rows = this.sqlite.queryAll<ConversationRow>(
        `SELECT id, role, content, timestamp, belong_entity_uuid
         FROM conversations
         WHERE content LIKE ? AND is_compacted = 0 AND COALESCE(is_summary, 0) = 0${police.clause}
         ORDER BY timestamp DESC LIMIT ?`,
        [`%${query}%`, ...police.params, limit],
      );
      const hits: SearchHit[] = rows.map((r) => ({
        id: String(r.id),
        domain: 'conversation' as const,
        text: (r.content || '').substring(0, 150),
        score: 1.0,
        route: 'conversation' as const,
        entityUuid: r.belong_entity_uuid ?? null,
        createdAt: r.timestamp ?? '',
        payload: { role: r.role },
        backref: { table: 'conversations', id: r.id },
      }));
      return Promise.resolve(hits);
    } catch (e) {
      console.error('[ConversationAdapter]', (e as Error)?.message);
      return Promise.resolve([]);
    }
  }
}
