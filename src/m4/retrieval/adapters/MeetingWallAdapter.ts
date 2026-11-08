/**
 * MeetingWallAdapter — 会晤隔离墙检索适配器（Foundation V1.0 扩展）
 * ================================================================
 * 把 retrieval-stage V5.2 会晤隔离墙的"三槽位"检索逻辑封装为统一适配器，
 * 纳入 SearchOrchestrator 多路并行 + RRF 融合体系。
 *
 * 检索槽位（对齐原隔离墙逻辑，不改召回语义）：
 *   - 近期槽（当日 <1天）：保底命中当天对话记忆（钙化排序 LIMIT 8）
 *   - 历史槽（>=1天）：保留重要历史地标（钙化排序 LIMIT 6）
 *   - 回忆问句 → 追加最早槽（时间轴兜底 LIMIT 6）
 *
 * 设计原则：
 *   - route = 'meeting'，权重独立可配（retrieval-fusion.config.yaml）
 *   - 只查 belong_entity_uuid = 当前会晤实体（隐私隔离核心）
 *   - 只做结构去重与条数上限，不按正文内容过滤（MEM-UNIFY-V1 批1：删除静态编造黑名单）
 *   - 输出 SearchHit 形状，供 fuseHits 融合
 */

import type { RetrievalContext, SearchHit } from '../types.js';
import type { RetrievalAdapter } from '../adapter.js';
// 🔴 2026-09-09 会晤失忆修复: 与 retrieval-stage 隔离墙共用共享召回模块（消灭同构漂移）。
//   统一触发正则/关键词内容相关召回/钙化槽/去重均取自 m4/retrieval/meeting-recall.ts（零 import 模块）。
import {
  RECALL_TRIGGER_RE,
  extractTopicKeywords,
  keywordRecallMemories,
  recentCalciumRows,
  historyCalciumRows,
  dedupeRowsById,
  earliestMemoriesByTime,
} from '../meeting-recall.js';
import type { RecallMemoryRow } from '../meeting-recall.js';

/** 隔离墙数据源（SQLiteAdapter.queryAll 兼容最小形状） */
export interface MeetingWallSource {
  queryAll<T = unknown>(sql: string, params?: unknown[]): T[];
}

/** 输出条数上限 */
const MAX_MEMORIES = 15;

export class MeetingWallAdapter implements RetrievalAdapter {
  readonly domain = 'memory' as const;
  readonly routes = ['meeting'] as const;

  constructor(private source: MeetingWallSource) {}

  async search(ctx: RetrievalContext): Promise<SearchHit[]> {
    // 仅会晤场景（有 entityUuids）生效
    const entityUuids = ctx.entityUuids ?? [];
    if (entityUuids.length === 0) return [];

    const hits: SearchHit[] = [];
    const now = new Date().toISOString();

    // ── 近期槽（当日 <1天）+ 历史槽（>=1天）—— 共享工具（meeting-recall.ts），与隔离墙同源 ──
    let entityMems: RecallMemoryRow[] = [
      ...recentCalciumRows(this.source, entityUuids[0], 8),
      ...historyCalciumRows(this.source, entityUuids[0], 6),
    ];

    // 🔴 2026-09-09 会晤失忆修复(A): 内容相关召回优先 — 关键词命中的当日记忆排到钙化序之前。
    //   续聊"还是X的事"抽词命中 6:05《蒹葭》等低钙化关键记忆，防高钙 ANCHOR 占满近期槽 TOP8。
    const kwHits: RecallMemoryRow[] = keywordRecallMemories(this.source, entityUuids[0], extractTopicKeywords(ctx.query), 4);
    if (kwHits.length > 0) {
      entityMems = dedupeRowsById([...kwHits, ...entityMems]);
      console.log(`[MeetingWallAdapter] 内容相关召回: ${kwHits.length} 条前置 (query=${ctx.query.substring(0, 20)})`);
    }

    // ── 回忆/续聊触发 → 最早槽（共享统一触发正则，含续聊引导） ──
    // 🔴 2026-10-18 修正：原内联 `ORDER BY seq_pos ASC` 取到的是本轮讨论锚点
    //   （锚点 seq 为负排最前 = 自我污染回声）；收编到真源 earliestMemoriesByTime。
    if (RECALL_TRIGGER_RE.test(ctx.query)) {
      const earlyRows = earliestMemoriesByTime(this.source, entityUuids[0], 6) || [];
      entityMems = [...entityMems, ...earlyRows];
    }

    // ── 结构去重（不按正文内容过滤）──
    const seen = new Set<string>();
    for (const m of entityMems) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const body = String(m.raw_input || '');
      hits.push({
        id: String(m.id),
        domain: 'memory',
        text: body.substring(0, 250),
        score: Number(m.calcium_score || 0.5),
        route: 'meeting',
        entityUuid: entityUuids[0],
        calciumScore: Number(m.calcium_score || 0),
        createdAt: m.created_at || now,
        timeMs: m.created_at ? new Date(m.created_at).getTime() : Date.now(),
        dedupeKey: `meeting:${entityUuids[0]}:${m.id}`,
      });
      if (hits.length >= MAX_MEMORIES) break;
    }

    return hits;
  }
}
