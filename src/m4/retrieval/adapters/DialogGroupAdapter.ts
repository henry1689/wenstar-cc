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
/**
 * 摘要通道命中归一化基准（T002 Phase 1）。
 * 摘要命中数的是 n-gram 条数（一个几十字的摘要可命中十几条），与原文通道的「命中轮数」量纲不同。
 * 命中 10 条即视为满分相关 —— 取 10 的依据：摘要约 80~150 字，buildNgrams 去重后通常 60~120 条，
 * 查询词能命中 10 条已属强相关。
 */
const SUMMARY_HIT_NORM = 10;

/** 块候选行（内层聚合结果） */
export interface DialogGroupCandidateRow {
  dg_id: string;
  uuid: string | null;
  matched_rows: number;
  /** 摘要通道命中的 n-gram 条数（0 = 原文通道命中 / 无摘要） */
  summary_matched: number | null;
  last_ts: string | null;
  calcium: number | null;
  tag: string | null;
  hash: string | null;
  turns: number | null;
  reason: string | null;
  /** block_summary（三层摘要），可能为 NULL（未生成/跳过/失败） */
  summary: string | null;
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

      // ── ① 块候选：双通道 = 原文命中 ∪ 摘要命中（T002 Phase 1）──
      //   通道① conversations 原文命中（police 在此作用，无歧义）。
      //   通道② search_index 里 source_type='dialog_group' 的摘要命中。
      //   🔴 这是 B 链路的核心价值：原文没有字面命中、只有摘要能命中时，该组也必须进候选；
      //      否则「上次聊过想去哪玩」这类问法永远召不回那一组。
      //   police 在通道②作用于 dialog_groups（别名 g2）—— search_index 本身也有同名列
      //   belong_entity_uuid，故先把 search_index 投影成只含 (term, source_id) 的子查询，
      //   避免 ambiguous column 错误（与文件头「户籍过滤放在子查询」同一姿势）。
      const cands = this.sqlite.queryAll<DialogGroupCandidateRow>(
        `SELECT u.dg_id AS dg_id, MAX(u.uuid) AS uuid,
                SUM(u.matched_rows) AS matched_rows,
                SUM(u.summary_matched) AS summary_matched,
                MAX(u.last_ts) AS last_ts,
                g.block_calcium_score AS calcium, g.narrative_tag AS tag,
                g.scene_anchor_hash AS hash, g.turn_count AS turns,
                g.block_close_reason AS reason, g.block_summary AS summary
         FROM (
           SELECT dialog_group_id AS dg_id,
                  MAX(belong_entity_uuid) AS uuid,
                  COUNT(*) AS matched_rows,
                  0 AS summary_matched,
                  MAX(timestamp) AS last_ts
           FROM conversations
           WHERE dialog_group_id IS NOT NULL
             AND (is_test IS NULL OR is_test = 0)
             AND id IN (
               SELECT CAST(source_id AS INTEGER) FROM search_index
               WHERE source_type = 'conversation' AND term IN (${phs})
             )${police.clause}
           GROUP BY dialog_group_id
           UNION ALL
           SELECT g2.dialog_group_id AS dg_id,
                  g2.belong_entity_uuid AS uuid,
                  0 AS matched_rows,
                  COUNT(*) AS summary_matched,
                  g2.last_ts AS last_ts
           FROM dialog_groups g2
           JOIN (
             SELECT term, source_id FROM search_index
             WHERE source_type = 'dialog_group'
           ) s ON s.source_id = g2.dialog_group_id
           WHERE s.term IN (${phs})${police.clause}
           GROUP BY g2.dialog_group_id
         ) u
         LEFT JOIN dialog_groups g ON g.dialog_group_id = u.dg_id
         GROUP BY u.dg_id
         ORDER BY SUM(u.matched_rows) DESC, SUM(u.summary_matched) DESC,
                  COALESCE(g.block_calcium_score, 0) DESC
         LIMIT ?`,
        [...terms, ...police.params, ...terms, ...police.params, limit],
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
        const summary = String(c.summary || '').trim();
        const bodyRaw = (textMap.get(dgId) || []).join(' ').replace(/\s+/g, ' ').trim();
        // 注入：摘要前置到正文，模型先看到「这段对话讲什么」，再看原文细节
        const body = (summary ? `【摘要】${summary} ${bodyRaw}` : bodyRaw).substring(0, TEXT_MAX);

        const matched = Number(c.matched_rows) || 0;
        const summaryMatched = Number(c.summary_matched) || 0;
        const turns = Number(c.turns) || 0;

        // 双通道打分（业主 2026-10-18 确认）：
        //   原文密度 0.40 / 摘要密度 0.30 / 双通道共振 0.15 / 钙分 0.15 = 1.00（天然归一化）。
        //   单通道时：纯原文最高 0.55，纯摘要最高 0.45 —— 摘要命中略低于原文命中，
        //   但足以让「只有摘要能命中」的组进入候选集（这正是 B 链路存在的意义）。
        //   RRF 只看排名，此分数用于路内排序的可解释性。
        const convDensity = turns > 0 ? Math.min(1, matched / turns) : 0;
        const summaryDensity = Math.min(1, summaryMatched / SUMMARY_HIT_NORM);
        const bothChannels = matched > 0 && summaryMatched > 0 ? 1 : 0;
        const calcium = Math.min(1, (Number(c.calcium) || 0) / 10);
        const score =
          Math.round(
            (convDensity * 0.40 + summaryDensity * 0.30 + bothChannels * 0.15 + calcium * 0.15) * 1000,
          ) / 1000;

        return {
          id: dgId,
          domain: 'dialog_group' as const,
          text: body,
          score,
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
            summaryMatchedRows: summaryMatched,
            summary: summary || null,
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
