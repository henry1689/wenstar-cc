/**
 * DialogGroupAdapter — 对话块存储域适配器（2026-11-02 由 v11 结构化召回接管）
 * =====================================================================
 * 「对话块」= 一段自闭合的连贯场景（`dialog_groups` 表一行 + 其名下 conversations 聚合）。
 * 与 ConversationAdapter 的区别是**聚合粒度**：对话适配器返回单条消息，本适配器返回整块。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 🔴 2026-11-02 改造背景（业主裁决：彻底拆除 n-gram / V11 彻底完成 / 绝对不用旧方案兜底）
 *
 *   原实现：自写双通道 SQL ——
 *     通道① `search_index(source_type='conversation')` 取原文命中
 *     通道② `search_index(source_type='dialog_group')` 取摘要命中
 *   实测出的四个问题：
 *     ① 通道①是**死代码**：conversation 分区已于 2026-10-27 按 v11 §S1 判废停建，现在 0 行；
 *     ② 通道②维护 769,131 行 / 110.4 MB 索引，而它索引的摘要全文只有 0.48 MB —— **230 倍**；
 *     ③ 排序键 `COUNT(DISTINCT term)` 让每块都有的摘要模板套话（`标签`/`叙事`/`情感`
 *        各命中 2,585 块）拿到最高分，**区分度为零**；
 *     ④ 实测召回耗时 258.4 ms，而 v11 围栏+精排仅 27.4 ms（同一批 40 条真实查询，
 *        召回率均 40/40，质量相当）。
 *
 *   现实现：走 `recallByStructured(domain='dialog_group')` + `scoreAndRank`，
 *   与**记忆召回共用同一套** UUID 闸门、分片 LIKE 围栏与四权重精排
 *   （hit 0.45 / calcium 0.30 / recency 0.15 / semantic 0.10）。
 *   单一实现，杜绝「同规则两份实现」的判据漂移（P0-1 教训）。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 🔴 户籍过滤
 *   UUID 闸门由 `StructuredRecall` 内部 `buildSqlClause` 产出，**第一个拼进 SQL**
 *   （蓝皮书 §3.1 第 4 条：不得先查后过滤 —— 后者会把他人的行读进内存）。
 *   本适配器只负责把 `ctx.policy.visibleUuids` 传下去，不自行拼任何 UUID 条件。
 *
 * 🔴 deny-by-default
 *   白名单为空 ⇒ 直接返回空（与 recallByStructured 红线 14 同一语义）。
 *   ⚠️ 行为收紧说明：旧实现会尊重 `policy.enforce === false`（离线巡检全库搜），
 *      新实现一律走 UUID 闸门。离线巡检的主要目标是记忆/知识域，对话块不参与。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 🔴 语义向量
 *   组级 40D 快照列 `perception_40d_snapshot` 由 `BlockArchiveService` 后台写入；
 *   无快照的组该列为 NULL ⇒ `cosine` 为 undefined ⇒ scoreAndRank 按语义权重 0 重归一
 *   （《40D 量纲统一法令》第四条：无向量只能跳过，不得填 0 冒充）。
 */

import type { RetrievalAdapter } from '../adapter.js';
import type { RetrievalContext, SearchHit } from '../types.js';
import { recallByStructured, scoreAndRank } from '../StructuredRecall.js';
import { ENCLOSURE_DEFAULT_LIMIT } from '../Flags.js';

/** 单块取多少轮正文拼 hit.text（够判断相关性即可，不追求完整） */
const TEXT_ROUNDS = 6;
/** hit.text 截断长度（与 ConversationAdapter 的 150 对齐） */
const TEXT_MAX = 300;
/**
 * 候选池倍数 —— 精排结果多取若干，供 lifecycle 降权后重排裁回 limit。
 *
 * 为什么需要：archived 组只降权不排除（只增不减铁律），若直接按精排取满 limit
 * 再降权，降权后的 archived 仍占名额。多取几倍后统一按最终分重排，语义与旧实现一致。
 */
const POOL_FACTOR = 5;
/**
 * 🔴 Phase 2.3 (E2/T005): archived 组排序降权系数。
 * 归档组**不排除**（仍可关键词命中），但排序权重乘此系数使其低于 active/consolidating。
 * 取 0.5：够低以让同命中数的 active 组稳定排前，又不至于把 archived 挤到完全不可见。
 */
const ARCHIVED_DECAY = 0.5;

/** 块正文行 */
export interface DialogGroupTextRow {
  dialog_group_id: string;
  role: string;
  content: string;
}

/** 块元信息行（精排结果不含 lifecycle 等字段，按 top-K id 回表取） */
export interface DialogGroupMetaRow {
  dialog_group_id: string;
  lifecycle_state: string | null;
  narrative_tag: string | null;
  scene_anchor_hash: string | null;
  turn_count: number | null;
  block_close_reason: string | null;
  last_ts: string | null;
}

/** 数据源接口（兼容 SQLiteAdapter.queryAll，同时也是 StructuredRecallDb 的形状） */
export interface DialogGroupSqlSource {
  queryAll<T = unknown>(sql: string, params?: unknown[]): T[];
}

export class DialogGroupAdapter implements RetrievalAdapter {
  readonly domain = 'dialog_group' as const;
  readonly routes = ['dialog_group'] as const;

  constructor(private sqlite: DialogGroupSqlSource) {}

  async search(ctx: RetrievalContext): Promise<SearchHit[]> {
    const query = (ctx.query || '').trim();
    if (query.length < 2) return [];

    try {
      const limit = Number(ctx.limit) > 0 ? Math.floor(Number(ctx.limit)) : 3;
      const uuids = Array.from(ctx.policy?.visibleUuids ?? []).filter(Boolean);
      // deny-by-default：无白名单不检索（与 recallByStructured 红线 14 同语义）
      if (uuids.length === 0) return [];

      // 切词口径复用 v11 唯一实现（buildNgrams 同源），本适配器不自行滑窗
      const { buildKeywordShards } = await import('../StructuredRecall.js');

      // ── ①a 摘要通道（v11 围栏 + 精排，与记忆召回同一套实现）──
      const summaryHits = await recallByStructured(
        this.sqlite,
        {
          domain: 'dialog_group',
          entityUuids: uuids,
          keywords: [query],
          limit: ENCLOSURE_DEFAULT_LIMIT,
        },
        ctx.perception40d ?? undefined,
      );

      // ── ①b 原文通道（ADR-010 §12.2 要求的另一半）──
      //   🔴 为什么必须有：`dialog_group` 域的 textCol 定死为 block_summary 且 extraWhere
      //      强制非空 ⇒ 只有摘要能召回。后果是 ① 摘要没覆盖到的会话段永远召不回
      //      （实测段级命中仅 20.8%）；② 无摘要的组整组进不了候选池（实测 479 组 / 15.7%）。
      //   本路直接对 conversations 按组聚合，**不经过** `extraWhere`，两路候选最后合并。
      let rawRows: Array<{ gid: string; hit_rows: number }> = [];
      try {
        const shard = buildKeywordShards('content', [query]);
        if (shard.sql) {
          const uuidPhs = uuids.map(() => '?').join(',');
          rawRows = this.sqlite.queryAll<{ gid: string; hit_rows: number }>(
            `SELECT c.dialog_group_id AS gid, COUNT(*) AS hit_rows
               FROM conversations c
              WHERE c.dialog_group_id IS NOT NULL
                AND (c.is_test IS NULL OR c.is_test = 0)
                AND c.belong_entity_uuid IN (${uuidPhs})${shard.sql}
              GROUP BY c.dialog_group_id
              ORDER BY hit_rows DESC
              LIMIT ?`,
            [...uuids, ...shard.params, ENCLOSURE_DEFAULT_LIMIT],
          ) || [];
        }
      } catch (e) {
        // 原文通道不可用 ⇒ 退回纯摘要路，不阻塞检索（与 D002 兜底同策略）
        console.warn('[DialogGroupAdapter] 原文通道不可用，仅用摘要通道:', (e as Error)?.message);
      }

      // ── ①c 候选合并（摘要命中 ∪ 原文命中，ADR-010 §12.2）──
      const merged = new Map<string, (typeof summaryHits)[number]>();
      for (const h of summaryHits) merged.set(String(h.id), h);

      const rawOnlyGids: string[] = [];
      for (const r of rawRows) {
        const gid = String(r.gid || '');
        if (!gid) continue;
        const hitRows = Number(r.hit_rows) || 0;
        const exist = merged.get(gid);
        if (exist) {
          // 双通道共振：两路都命中 ⇒ 累加分片命中数（同一分片口径，累加即共振强度）
          exist.hitShards += hitRows;
        } else {
          rawOnlyGids.push(gid);
          // 占位，钙分与时间戳在下面回表补齐（精排要靠这两个分量）
          merged.set(gid, {
            id: gid,
            domain: 'dialog_group',
            text: '',                  // 无摘要 ⇒ 组装时正文直接用原文，不会出现空【摘要】标签
            calciumScore: 0,
            createdAt: '',
            hitShards: hitRows,        // 原文命中行数（与摘要路的分片命中同一量纲）
            semanticSource: 'none',
          } as (typeof summaryHits)[number]);
        }
      }

      // 原文独有候选：补齐钙分与时间戳，否则精排的 calcium / recency 分量恒为 0
      if (rawOnlyGids.length > 0) {
        try {
          const phs = rawOnlyGids.map(() => '?').join(',');
          const rows = this.sqlite.queryAll<{ dialog_group_id: string; block_calcium_score: number | null; last_ts: string | null }>(
            `SELECT dialog_group_id, block_calcium_score, last_ts
               FROM dialog_groups WHERE dialog_group_id IN (${phs})`,
            rawOnlyGids,
          ) || [];
          for (const r of rows) {
            const h = merged.get(String(r.dialog_group_id));
            if (!h) continue;
            h.calciumScore = Number(r.block_calcium_score) || 0;
            h.createdAt = String(r.last_ts || '');
          }
        } catch (e) {
          console.warn('[DialogGroupAdapter] 原文候选补钙分失败（按 0 分精排）:', (e as Error)?.message);
        }
      }

      const hits = [...merged.values()];
      if (hits.length === 0) return [];

      const ranked = scoreAndRank(hits, Date.now());
      const pool = ranked.slice(0, Math.max(limit, Math.floor(limit * POOL_FACTOR)));
      if (pool.length === 0) return [];

      // ── ② 回表：块元信息（lifecycle / tag / hash / turns / reason / last_ts）──
      const ids = pool.map((h) => h.id);
      const idPhs = ids.map(() => '?').join(',');
      const metas = this.sqlite.queryAll<DialogGroupMetaRow>(
        `SELECT dialog_group_id, lifecycle_state, narrative_tag, scene_anchor_hash,
                turn_count, block_close_reason, last_ts
         FROM dialog_groups WHERE dialog_group_id IN (${idPhs})`,
        ids,
      );
      const metaMap = new Map(metas.map((m) => [String(m.dialog_group_id), m]));

      // ── ③ 块正文：只为已选中的块取，查询量有界 ──
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

      // ── ④ lifecycle 降权 + 组装 ──
      //   注入形态与原实现逐字一致：摘要前置到正文，模型先看到「这段对话讲什么」，
      //   再看原文细节。
      const scored = pool.map((h) => {
        const dgId = String(h.id);
        const meta = metaMap.get(dgId);
        const summary = String(h.text || '').trim();
        const bodyRaw = (textMap.get(dgId) || []).join(' ').replace(/\s+/g, ' ').trim();
        const body = (summary ? `【摘要】${summary} ${bodyRaw}` : bodyRaw).substring(0, TEXT_MAX);

        // archived 组不排除（只增不减），仅排序降权
        const decay = String(meta?.lifecycle_state || 'active') === 'archived' ? ARCHIVED_DECAY : 1;
        const rawScore = h.score * decay;
        const score = Number.isFinite(rawScore) ? Math.round(rawScore * 1000) / 1000 : 0;

        const hitObj: SearchHit = {
          id: dgId,
          domain: 'dialog_group' as const,
          text: body,
          score,
          route: 'dialog_group' as const,
          entityUuid: h.belongEntityUuid ?? null,
          calciumScore: h.calciumScore,
          createdAt: String(meta?.last_ts || h.createdAt || ''),
          payload: {
            narrativeTag: meta?.narrative_tag ?? null,
            sceneAnchorHash: meta?.scene_anchor_hash ?? null,
            turnCount: Number(meta?.turn_count) || 0,
            blockCloseReason: meta?.block_close_reason ?? null,
            lifecycleState: meta?.lifecycle_state ?? null,
            summary: summary || null,
            // v11 精排明细（可解释性；旧实现透传的是 matchedRows/summaryMatchedRows）
            hitShards: h.hitShards,
            cosine: typeof h.cosine === 'number' ? h.cosine : null,
            semanticSource: h.semanticSource,
          },
          backref: { table: 'dialog_groups', id: dgId },
        };
        return { hit: hitObj, score, ts: Date.parse(String(meta?.last_ts || '')) || 0 };
      });

      // 🔴 唯一排序点：按最终分降序，同分按时间降序保证确定性
      scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
      return scored.slice(0, limit).map((s) => s.hit);
    } catch (e) {
      // 单域异常不得阻塞其他检索路（与其余适配器同策略；runAdapter 另有兜底 catch）
      console.error('[DialogGroupAdapter]', (e as Error)?.message);
      return [];
    }
  }
}
