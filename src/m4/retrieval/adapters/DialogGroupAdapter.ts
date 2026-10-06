/**
 * DialogGroupAdapter — 对话块存储域适配器（ADR-010 P1-C1）
 * =========================================================
 * 「对话块」= 一段自闭合的连贯场景（`dialog_groups` 表一行 + 其名下 conversations 聚合）。
 * 与 ConversationAdapter 的区别是**聚合粒度**：对话适配器返回单条消息，本适配器返回整块。
 *
 * ──────────────────────────────────────────────────────────────
 * 🔴 为什么不另建索引（ADR-010 P1-C1 细化 4）
 *
 *   原方案要求 `SearchIndexBuilder` 加 `source_type='dialog_group'` 并做块内 800 字切块。
 *   勘察后撤销，理由三条：
 *     ① `search_index` 已占全库约 **80% 体积**（V34 专门治理过：319.9MB → 216.5MB，
 *        删掉 3 个冗余索引），不宜再增；
 *     ② `conversations` 已**全量索引**（V34 撤除了 `is_compacted = 0` 过滤）；
 *     ③ 块 = 它那些 conversations 的聚合 ⇒ **同一份索引换个 GROUP BY 即可**。
 *   所以本适配器**复用既有 conversation 索引**，零新增索引体积、零新增写入路径。
 *   检索单元从「单条消息」变为「块」，本质是聚合粒度的变化，不是新建一层索引。
 *
 * ──────────────────────────────────────────────────────────────
 * 🔴 户籍过滤为什么必须放在子查询里
 *
 *   `buildSqlClause` 产出的是**裸列名**（` AND belong_entity_uuid IN (...)`，见
 *   governance/police/UUIDPoliceFilter.ts）。而本查询天然涉及三张表 ——
 *   `conversations` / `search_index` / `dialog_groups` —— **三张都有 belong_entity_uuid**
 *   ⇒ 直接拼进 JOIN 会触发 ambiguous column 错误。故 police 只拼在**仅 conversations
 *   可见的内层子查询**里，外层再 JOIN 块表。这是「查询层收编 police」的正确姿势，
 *   而不是绕开政务（户籍管理法铁律 0.4 第 4 条：新代码必须走 UUIDPoliceFilter，禁止手写 UUID SQL）。
 *
 * 🔴 deny-by-default：`buildSqlClause` 在无白名单时返回 ` AND 1=0`（拒绝一切）；
 *   `strict` 模式**不走** `OR belong_entity_uuid IS NULL` 逃生口。
 *   本适配器不做任何放宽 —— 无归属的块检索不到，宁缺勿泄。
 */

import type { RetrievalAdapter } from '../adapter.js';
import type { RetrievalContext, SearchHit } from '../types.js';
import { buildSqlClause } from '../../../governance/police/UUIDPoliceFilter.js';
import { buildNgrams } from '../../SearchIndexBuilder.js';

/** 倒排查询最大词数（与 meeting-recall 同量级，控制单次 SQL 的 IN 规模） */
const MAX_TERMS = 40;
/** 单块取多少轮正文拼 hit.text（够判断相关性即可，不追求完整） */
const TEXT_ROUNDS = 6;
/** hit.text 截断长度（与 ConversationAdapter 的 150 对齐） */
const TEXT_MAX = 300;

/** 块候选行（内层聚合结果） */
export interface DialogGroupCandidateRow {
  dg_id: string;
  uuid: string | null;
  matched_rows: number;
  last_ts: string | null;
  calcium: number | null;
  tag: string | null;
  hash: string | null;
  turns: number | null;
  reason: string | null;
}

/** 块正文行 */
export interface DialogGroupTextRow {
  dialog_group_id: string;
  role: string;
  content: string;
}

/** 数据源接口（兼容 SQLiteAdapter.queryAll） */
export interface DialogGroupSqlSource {
  queryAll<T = unknown>(sql: string, params?: unknown[]): T[];
}

export class DialogGroupAdapter implements RetrievalAdapter {
  readonly domain = 'dialog_group' as const;
  readonly routes = ['dialog_group'] as const;

  constructor(private sqlite: DialogGroupSqlSource) {}

  search(ctx: RetrievalContext): Promise<SearchHit[]> {
    const query = (ctx.query || '').trim();
    if (query.length < 2) return Promise.resolve([]);
    try {
      const terms = buildNgrams(query).slice(0, MAX_TERMS);
      if (terms.length === 0) return Promise.resolve([]);

      const police = buildSqlClause(ctx.policy);
      const limit = Number(ctx.limit) > 0 ? Math.floor(Number(ctx.limit)) : 3;
      const phs = terms.map(() => '?').join(',');

      // ── ① 块候选：内层只暴露 conversations（police 在此作用，无歧义）──
      const cands = this.sqlite.queryAll<DialogGroupCandidateRow>(
        `SELECT sub.dg_id AS dg_id, sub.uuid AS uuid, sub.matched_rows AS matched_rows,
                sub.last_ts AS last_ts, g.block_calcium_score AS calcium,
                g.narrative_tag AS tag, g.scene_anchor_hash AS hash,
                g.turn_count AS turns, g.block_close_reason AS reason
         FROM (
           SELECT dialog_group_id AS dg_id,
                  MAX(belong_entity_uuid) AS uuid,
                  COUNT(*) AS matched_rows,
                  MAX(timestamp) AS last_ts
           FROM conversations
           WHERE dialog_group_id IS NOT NULL
             AND (is_test IS NULL OR is_test = 0)
             AND id IN (
               SELECT CAST(source_id AS INTEGER) FROM search_index
               WHERE source_type = 'conversation' AND term IN (${phs})
             )${police.clause}
           GROUP BY dialog_group_id
         ) sub
         LEFT JOIN dialog_groups g ON g.dialog_group_id = sub.dg_id
         ORDER BY sub.matched_rows DESC, COALESCE(g.block_calcium_score, 0) DESC
         LIMIT ?`,
        [...terms, ...police.params, limit],
      );
      if (cands.length === 0) return Promise.resolve([]);

      // ── ② 块正文：只为已选中的 ≤limit 个块取，查询量有界 ──
      const ids = cands.map((c) => String(c.dg_id));
      const idPhs = ids.map(() => '?').join(',');
      const texts = this.sqlite.queryAll<DialogGroupTextRow>(
        `SELECT dialog_group_id, role, content FROM conversations
         WHERE dialog_group_id IN (${idPhs}) AND (is_test IS NULL OR is_test = 0)
         ORDER BY timestamp ASC`,
        ids,
      );
      const textMap = new Map<string, string[]>();
      for (const t of texts) {
        const k = String(t.dialog_group_id);
        const arr = textMap.get(k) || [];
        if (arr.length < TEXT_ROUNDS) arr.push(`${t.role === 'user' ? '用户' : ''}${t.content || ''}`);
        textMap.set(k, arr);
      }

      const hits: SearchHit[] = cands.map((c) => {
        const dgId = String(c.dg_id);
        const body = (textMap.get(dgId) || []).join(' ').replace(/\s+/g, ' ').trim().substring(0, TEXT_MAX);
        const matched = Number(c.matched_rows) || 0;
        const turns = Number(c.turns) || 0;
        // 路内分：命中轮次占比（块内多少轮与查询相关）× 块钙分归一。
        // RRF 只看排名，此处分数只用于路内排序的可解释性。
        const density = turns > 0 ? Math.min(1, matched / turns) : 0;
        const calcium = Math.min(1, (Number(c.calcium) || 0) / 10);
        return {
          id: dgId,
          domain: 'dialog_group' as const,
          text: body,
          score: Math.round((density * 0.6 + calcium * 0.4) * 1000) / 1000,
          route: 'dialog_group' as const,
          entityUuid: c.uuid ?? null,
          calciumScore: Number(c.calcium) || 0,
          createdAt: String(c.last_ts || ''),
          payload: {
            narrativeTag: c.tag ?? null,
            sceneAnchorHash: c.hash ?? null,
            turnCount: turns,
            blockCloseReason: c.reason ?? null,
            matchedRows: matched,
          },
          backref: { table: 'dialog_groups', id: dgId },
        };
      });
      return Promise.resolve(hits);
    } catch (e) {
      // 单域异常不得阻塞其他检索路（与既有 5 个适配器同策略；runAdapter 另有兜底 catch）
      console.error('[DialogGroupAdapter]', (e as Error)?.message);
      return Promise.resolve([]);
    }
  }
}
