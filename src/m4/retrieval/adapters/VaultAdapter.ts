/**
 * VaultAdapter — 金库存储域适配器（Foundation V1.0）
 * ====================================================
 * 金库（vault_log 表 promote 记录）检索。
 *
 * 逻辑对齐 retrieval-stage 金库块（L601-632）：
 *   - 有 person 实体时按实体名 LIKE detail/content_md 定向检索
 *   - 无命中时回退近期 promote 记录
 *   - 查询层带 belong_entity_uuid 白名单过滤（buildSqlClause，deny-by-default）
 */

import type { RetrievalAdapter } from '../adapter.js';
import type { RetrievalContext, SearchHit } from '../types.js';
import { buildSqlClause } from '../../../governance/police/UUIDPoliceFilter.js';

/** vault_log 行 */
export interface VaultLogRow {
  id: string;
  detail: string | null;
  content_md: string | null;
  operation: string;
  created_at: string;
  belong_entity_uuid?: string | null;
}

/** 数据源接口（兼容 SQLiteAdapter） */
export interface VaultSqlSource {
  queryAll<T = unknown>(sql: string, params?: unknown[]): T[];
}

export class VaultAdapter implements RetrievalAdapter {
  readonly domain = 'vault' as const;
  readonly routes = ['vault'] as const;

  constructor(private sqlite: VaultSqlSource) {}

  search(ctx: RetrievalContext): Promise<SearchHit[]> {
    const query = ctx.query.trim();
    if (query.length < 2) return Promise.resolve([]);
    try {
      const sqlite = this.sqlite;
      // 查询层收编 police：直接用 ctx.policy（enforce:false 户主最高权限 → 无过滤；
      // 会晤白名单 → belong_entity_uuid IN (...)；户主有白名单 → IN + OR IS NULL），deny-by-default
      const police = buildSqlClause(ctx.policy);
      const limit = ctx.limit ?? 3;

      let rows: VaultLogRow[] = [];
      // 定向：按 query 中疑似实体名 LIKE detail/content_md
      const names = (query.match(/[一-鿿]{2,3}/g) ?? []).slice(0, 3);
      if (names.length > 0) {
        const nameClauses = names.map(() => '(detail LIKE ? OR content_md LIKE ?)').join(' OR ');
        const nameParams: unknown[] = [];
        for (const n of names) nameParams.push(`%${n}%`, `%${n}%`);
        rows = sqlite.queryAll<VaultLogRow>(
          `SELECT id, detail, content_md, operation, created_at, belong_entity_uuid
           FROM vault_log WHERE ${nameClauses} AND operation='auto_induct'${police.clause}
           ORDER BY created_at DESC LIMIT ?`,
          [...nameParams, ...police.params, 2],
        );
      }
      // 回退：近期 promote 记录
      if (rows.length === 0) {
        rows = sqlite.queryAll<VaultLogRow>(
          `SELECT id, detail, content_md, operation, created_at, belong_entity_uuid
           FROM vault_log WHERE operation='auto_induct' AND (content_md IS NOT NULL OR detail IS NOT NULL)${police.clause}
           ORDER BY created_at DESC LIMIT ?`,
          [...police.params, limit],
        );
      }

      const hits: SearchHit[] = rows.slice(0, limit).map((r) => ({
        id: String(r.id),
        domain: 'vault' as const,
        text: (r.content_md || r.detail || '').substring(0, 100),
        score: 1.0,
        route: 'vault' as const,
        entityUuid: r.belong_entity_uuid ?? null,
        createdAt: r.created_at ?? '',
        backref: { table: 'vault_log', id: String(r.id) },
      }));
      return Promise.resolve(hits);
    } catch (e) {
      console.error('[VaultAdapter]', (e as Error)?.message);
      return Promise.resolve([]);
    }
  }
}
