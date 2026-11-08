/**
 * BlackDiamondAdapter — 黑钻库存储域适配器（Foundation V1.0）
 * ===========================================================
 * 黑钻库（black_diamond 表）固化记忆检索。
 *
 * 设计说明（为何不用 VaultManager.searchBlackDiamonds）：
 *   VaultManager.rowToBlackDiamond（src/app/vault/VaultManager.ts L656-668）映射时
 *   **丢弃了 belong_entity_uuid 列** → 无法做实体隔离。本适配器直接 SQL（对齐其
 *   emotion_tag 精确命中 + summary/tags LIKE 兜底逻辑），SELECT 全列保留 UUID。
 *
 * 收编痛点：searchBlackDiamonds 原本未接 UUIDPoliceFilter。本适配器查询层用
 *   buildSqlClause 收编（deny-by-default），runAdapter 再兜底。
 */

import type { RetrievalAdapter } from '../adapter.js';
import type { RetrievalContext, SearchHit } from '../types.js';
import { buildSqlClause } from '../../../governance/police/UUIDPoliceFilter.js';
import {
  decodePerceptionV40,
  cosineSimilarity40D,
} from '../../../m2/PerceptionVector40DCodec.js';

/** 黑钻行（SQL 全列，含 belong_entity_uuid / emotion_vector） */
export interface BlackDiamondRow {
  id: string;
  summary: string;
  emotion_tag: string | null;
  source_id: string | null;
  calcium_level: number;
  created_at: string;
  belong_entity_uuid?: string | null;
  emotion_vector?: string | null;
}

/** 数据源接口（兼容 SQLiteAdapter） */
export interface BlackDiamondSqlSource {
  queryAll<T = unknown>(sql: string, params?: unknown[]): T[];
}

/**
 * 🔴 MEM-UNIFY-V1 批2A: 黑钻查询分片。
 * 旧实现用整句 LIKE（"你还记得我们那次去海边吗" 几乎不可能整句子串命中）；
 * 现改为标点切词 + CJK 2-gram，最多 12 片，再按关键词命中/钙化/40D 精排。
 */
export function buildDiamondShards(query: string): string[] {
  const s = String(query || '').trim();
  if (s.length < 2) return [];
  const shards = new Set<string>();
  for (const p of s.split(/[\s，。！？、,.!?;；:："'“”‘’（）()\[\]【】<>《》]+/)) {
    if (p.length >= 2) shards.add(p);
  }
  const cjk = s.replace(/[^一-龥]/g, '');
  // 重叠 2-gram：步长 1（步长 2 会漏掉「海边」这类跨步词）
  for (let i = 0; i + 2 <= cjk.length && shards.size < 18; i++) {
    shards.add(cjk.slice(i, i + 2));
  }
  return [...shards].slice(0, 12);
}

export class BlackDiamondAdapter implements RetrievalAdapter {
  readonly domain = 'black_diamond' as const;
  readonly routes = ['diamond'] as const;

  constructor(private sqlite: BlackDiamondSqlSource) {}

  search(ctx: RetrievalContext): Promise<SearchHit[]> {
    const query = (ctx.query || '').trim();
    if (query.length < 2) return Promise.resolve([]);
    try {
      const limit = Math.max(1, ctx.limit ?? 5);
      const shards = buildDiamondShards(query);
      const terms = shards.length > 0 ? shards : [query];
      // 查询层收编 police：直接用 ctx.policy（enforce:false 户主最高权限 → 无过滤；
      // 会晤白名单 → belong_entity_uuid IN (...)；户主有白名单 → IN + OR IS NULL），deny-by-default
      const police = buildSqlClause(ctx.policy);
      const where = terms
        .map(() => '(summary LIKE ? OR emotion_tag LIKE ? OR tags LIKE ?)')
        .join(' OR ');
      const whereParams: unknown[] = [];
      for (const t of terms) whereParams.push(`%${t}%`, `%${t}%`, `%${t}%`);
      // 多取 4 倍候选供精排；上限 20 防止长句分片后把库扫穿
      const fetchLimit = Math.min(40, Math.max(limit * 4, 20));

      const run = (withVector: boolean): BlackDiamondRow[] => this.sqlite.queryAll<BlackDiamondRow>(
        `SELECT id, summary, emotion_tag, source_id, calcium_level, created_at, belong_entity_uuid${withVector ? ', emotion_vector' : ''}
         FROM black_diamond
         WHERE (${where})${police.clause}
         ORDER BY created_at DESC LIMIT ?`,
        [...whereParams, ...police.params, fetchLimit],
      );

      let rows: BlackDiamondRow[];
      try {
        rows = run(true);
      } catch {
        // 旧库/测试库可能无 emotion_vector 列 —— 回退不带该列，不阻塞召回
        rows = run(false);
      }

      const q40 = ctx.perception40d ?? null;
      const scored = rows.map((r) => {
        const hay = `${r.summary || ''} ${r.emotion_tag || ''}`;
        const hitCount = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
        const keyword = terms.length > 0 ? hitCount / terms.length : 0;
        const calcium = Math.min(1, Math.max(0, (r.calcium_level ?? 0) / 5));
        let cosine = 0;
        if (q40 && r.emotion_vector) {
          try {
            const v = decodePerceptionV40(r.emotion_vector);
            if (v) cosine = Math.max(0, cosineSimilarity40D(q40, v));
          } catch { /* 坏向量按 0 处理 */ }
        }
        // 关键词 60% + 钙化 25% + 40D 15%（与 fusion 的“语义不独大”原则一致）
        const score = 0.6 * keyword + 0.25 * calcium + 0.15 * cosine;
        return { r, score };
      })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const hits: SearchHit[] = scored.map(({ r, score }) => ({
        id: String(r.id),
        domain: 'black_diamond' as const,
        text: (r.summary || '').substring(0, 200),
        score,
        route: 'diamond' as const,
        entityUuid: r.belong_entity_uuid ?? null,
        calciumScore: r.calcium_level ?? 0,
        calciumLevel: r.calcium_level ?? 0,
        createdAt: r.created_at ?? '',
        payload: { emotion_tag: r.emotion_tag, source_id: r.source_id },
        backref: { table: 'black_diamond', id: String(r.id) },
      }));
      return Promise.resolve(hits);
    } catch (e) {
      console.error('[BlackDiamondAdapter]', (e as Error)?.message);
      return Promise.resolve([]);
    }
  }
}
