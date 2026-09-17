/**
 * MemoryAdapter — 记忆召回复合适配器（Foundation V1.0）
 * ====================================================
 * 包装 `retrieveMultiRank`（M4Orchestrator.retrieveMultiRankForSearch →
 *   MemoryRetriever.retrieveMultiRank 6 路：emotion/keyword/spine/locus/entity/work）。
 *
 * ⚠️ 默认不注册：retrieveMultiRank 是 V13 七层管线的召回输入（retrieval-stage L470 已调）。
 *   接入本适配器 = 主召回也走统一链，会与 V13 主链重复。供未来 SearchOrchestrator
 *   重建主链时启用（届时 V13 主链由底座替代）。**本适配器不改 retrieveMultiRank 本身。**
 *
 * 输出映射：用 rankedItemToHit 把 RankedItem → SearchHit（spine global_uid 视为 memory 域，
 *   work_id 归 work 域），route 保留召回路供 RRF 权重路由。
 */

import type { RetrievalAdapter } from '../adapter.js';
import type { RetrievalContext, SearchHit } from '../types.js';
import { rankedItemToHit } from '../types.js';

/** retrieveMultiRank 最小返回形状 */
export interface MultiRankLike {
  lists: Array<{
    source: string;
    items: Array<{
      id: string;
      text: string;
      score: number;
      source: string;
      entityUuid?: string | null;
      calciumScore?: number;
      createdAt?: string;
      isForesight?: boolean;
      validStartMs?: number | null;
      validUntilMs?: number | null;
      foresightStatus?: string | null;
    }>;
  }>;
}

/** 🔴 Foundation V2.0: 搜索范围限定 */
export type SearchScope = 'strict' | 'allow-unowned' | 'full';

/** 记忆召回数据源（M4Orchestrator.retrieveMultiRankForSearch 形状） */
export interface MemoryRetrieverSource {
  retrieveMultiRank(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    options?: { perception?: unknown; entityUuids?: string[]; sessionId?: string; searchScope?: SearchScope },
  ): Promise<MultiRankLike>;
}

export class MemoryAdapter implements RetrievalAdapter {
  readonly domain = 'memory' as const;
  readonly routes = ['emotion', 'keyword', 'spine', 'locus', 'entity', 'work'] as const;

  constructor(private retriever: MemoryRetrieverSource) {}

  async search(ctx: RetrievalContext): Promise<SearchHit[]> {
    const locusPath = ctx.locusPath || 'default';
    const entities = ctx.entities ?? [];
    try {
      // 🔴 Foundation V2.0: 透传搜索范围限定
      const result = await this.retriever.retrieveMultiRank(locusPath, entities, {
        perception: ctx.perception,
        entityUuids: ctx.entityUuids,
        sessionId: ctx.sessionId,
        searchScope: ctx.searchScope,
      });
      const hits: SearchHit[] = [];
      for (const list of result.lists) {
        for (const item of list.items) {
          const hit = rankedItemToHit(item);
          hits.push(hit);
        }
      }
      return hits;
    } catch (e) {
      console.error('[MemoryAdapter]', (e as Error)?.message);
      return [];
    }
  }
}
