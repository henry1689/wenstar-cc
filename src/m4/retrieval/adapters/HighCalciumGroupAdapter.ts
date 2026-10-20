/**
 * HighCalciumGroupAdapter — 会晤高钙对话组通道（Phase 2.2 / B1 · T004）
 * ================================================================
 * A 链路「块级钙化召回」的检索端。与 DialogGroupAdapter（B 链路，**字面命中驱动**）互补：
 *
 * | 维度 | DialogGroupAdapter（B 链路） | 本适配器（A 链路） |
 * |---|---|---|
 * | 候选来源 | 原文命中 ∪ 摘要命中（n-gram） | `block_calcium_score >= floor` + 沉淀窗 |
 * | 是否需要字面命中 | 必须 | **不需要**（这正是"不遗忘"的意义） |
 * | 排序 | 命中密度为主、钙分为辅 | 时间近因为主、钙分为辅 |
 * | 路 | `dialog_group` | `high_calcium_group`（**独立 RRF 权重 = 独立配额**） |
 *
 * 🔴 为什么必须是独立 route 而不是给 dialog_group 加权：
 *   RRFFusion 是「按 route 取权重 + 按 dedupeKey 折叠」。把高钙通道并进 `dialog_group`，
 *   会让它与"字面命中的块"抢同一个名额 ⇒ 高钙组在无字面命中时仍然结构性不可达（等于没做）。
 *   独立 route 才有独立的 `weights[route]` 贡献。
 *   ⚠️ 该映射必须同时出现在 `fusion.ts` 的 FOUNDATION_DEFAULT_WEIGHTS 里，
 *      否则 `weights[route] ?? 0.05` 会把它静默压到最低档 —— 与 dialog_group 当年同一个坑。
 *
 * 数据源是**唯一真源** `meeting-recall.highCalciumGroups`（与会晤五路召回同文件），
 * 本适配器只负责「包成 SearchHit」，不写第二份 SQL —— 防同构漂移（P0-1 教训）。
 */

import type { RetrievalAdapter } from '../adapter.js';
import type { RetrievalContext, SearchHit } from '../types.js';
import { highCalciumGroups, type HighCalciumGroupRow, type RecallSource } from '../meeting-recall.js';
import { getRetrievalFusionConfig } from '../../../config/retrieval-fusion-config.js';

/** hit.text 上限（与 DialogGroupAdapter 的 TEXT_MAX 同量级） */
const TEXT_MAX = 300;
/** 分数公式：钙分归一 × 0.6 + 时间近因 × 0.4（与近期槽 recentSlotScore 同一套设计语言） */
const CALCIUM_W = 0.6;
const RECENCY_W = 0.4;
/** 近因归一窗口：7 天线性衰减（与 fusion.recencyRatio 同口径） */
const RECENCY_WINDOW_DAYS = 7;

export class HighCalciumGroupAdapter implements RetrievalAdapter {
  // 🔴 Phase 2.3 (E1/T005): 本路已以**独立 domain** 注册进 AdapterRegistry。
  //    Phase 2.2 时因一域一适配器限制暂不注册（同 domain 会覆盖块路）；E1 落地后
  //    注册键 = 'high_calcium_group'（存储仍 dialog_groups 表），与块路互不覆盖；
  //    跨路去重靠显式 `dedupeKey: dialog_group:<id>`（与块路 domain:id 同串，融合层折叠）。
  readonly domain = 'high_calcium_group' as const;
  readonly routes = ['high_calcium_group'] as const;

  constructor(private sqlite: RecallSource) {}

  async search(ctx: RetrievalContext): Promise<SearchHit[]> {
    // 仅会晤场景生效：无会晤实体就没有"组级归属"可依（组级 UUID 隔离是硬约束）
    const entityUuids = ctx.entityUuids ?? [];
    if (entityUuids.length === 0) return [];

    const cfg = getRetrievalFusionConfig();
    const cfgLimit = Math.max(1, Math.floor(Number(cfg.budget.high_calcium_group_limit) || 3));
    // 调用方给的 ctx.limit 更小 ⇒ 尊重它（配额是上限，不是下限）；不给或更大 ⇒ 用配置值
    const ctxLimit = Number(ctx.limit) > 0 ? Math.floor(Number(ctx.limit)) : cfgLimit;
    const limit = Math.min(cfgLimit, ctxLimit);
    const floor = Number(cfg.budget.high_calcium_floor) || 5;
    const nowMs = Number.isFinite(ctx.nowMs) ? Number(ctx.nowMs) : Date.now();
    const query = String(ctx.query || '');

    let rows: HighCalciumGroupRow[];
    try {
      rows = highCalciumGroups(this.sqlite, entityUuids[0], limit, { query, nowMs });
    } catch (e) {
      // 单路异常不得阻塞其他检索路（与其余适配器同策略；orchestrator 另有兜底 catch）
      console.error('[HighCalciumGroupAdapter]', (e as Error)?.message);
      return [];
    }
    if (rows.length === 0) return [];

    return rows.map((r) => {
      const calciumNorm = Math.min(1, Math.max(0, r.calcium / floor));
      const ts = r.last_ts ? Date.parse(r.last_ts) : NaN;
      const recency = Number.isFinite(ts)
        ? Math.max(0, 1 - Math.max(0, nowMs - ts) / (RECENCY_WINDOW_DAYS * 86400000))
        : 0;
      const score = Math.round((calciumNorm * CALCIUM_W + recency * RECENCY_W) * 1000) / 1000;

      const hit: SearchHit = {
        id: r.dg_id,
        domain: 'high_calcium_group',
        // 摘要前置、与 DialogGroupAdapter 同形（`【摘要】`），便于下游统一去重与注入
        text: `【摘要】${String(r.summary || '').trim()}`.substring(0, TEXT_MAX),
        score,
        route: 'high_calcium_group',
        entityUuid: r.uuid ?? entityUuids[0],
        calciumScore: r.calcium,
        createdAt: String(r.last_ts || ''),
        timeMs: Number.isFinite(ts) ? ts : undefined,
        // 与块路共用 domain 级去重键：同一组若两条路都命中，融合层只保留一条（不重复注入）
        dedupeKey: `dialog_group:${r.dg_id}`,
        payload: {
          source: 'high_calcium_group',
          calciumFloor: floor,
          relevant: r.relevant,
          matchedTerms: r.matched_terms,
          turnCount: r.turns,
          blockCloseReason: r.reason,
          lastTs: r.last_ts,
        },
        backref: { table: 'dialog_groups', id: r.dg_id },
      };
      return hit;
    });
  }
}
