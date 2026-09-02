/**
 * SearchOrchestrator — 多路检索统一调度中枢（会晤场景接入）
 * =========================================================
 * 把会晤隔离墙 + 六路记忆召回 + Foundation 额外域统一纳入
 * 同一调度体系：Promise.all 并行 + weightedRRF 融合。
 *
 * 设计原则：
 *   - 统一入口：runSearch(registry, ctx) 一步完成多路并行 + 融合
 *   - 会晤场景 = MeetingWallAdapter（meeting route）+ 其他域适配器
 *   - 户主场景 = 原有六路（V13 主链保留，不重复接入）
 *   - 并行安全：各适配器无共享可变状态
 *   - 融合输出：SearchHit[]（已按最终分排序 + MMR 去重）
 *
 * 与 runAllAdapters 的关系：
 *   - runAllAdapters 只做"并行 + 按 route 分组"（既有功能）
 *   - SearchOrchestrator 在其上叠加"融合"层，作为统一入口
 */

import type { RetrievalContext, SearchHit, RouteHitList, FuseOptions } from './types.js';
import { runAllAdapters, type AdapterRegistry } from './adapter.js';
import { fuseHits } from './fusion.js';

/** 统一检索结果 */
export interface OrchestratedSearchResult {
  /** 融合后命中（已排序 + MMR 去重） */
  hits: SearchHit[];
  /** 各召回路命中数（诊断用） */
  routeStats: Record<string, number>;
  /** 融合分数映射（dedupeKey → score） */
  scoreMap: Map<string, number>;
}

/**
 * 统一检索调度中枢
 */
export class SearchOrchestrator {
  /**
   * 执行多路并行检索 + 统一融合。
   *
   * @param registry 已注册的适配器注册表（会晤=MeetingWall+额外域；户主=额外域）
   * @param ctx      统一检索上下文
   * @param fuseOpts 融合选项（可注入权重/nowMs）
   */
  async runSearch(
    registry: AdapterRegistry,
    ctx: RetrievalContext,
    fuseOpts: FuseOptions = {},
  ): Promise<OrchestratedSearchResult> {
    const t0 = Date.now();

    // 1. 多路并行召回（Promise.all）
    const routeHits: RouteHitList[] = await runAllAdapters(registry, ctx);

    // 2. 统一融合（weightedRRF + 近因 + MMR）
    const fused = fuseHits(routeHits, fuseOpts);

    // 3. 统计 + 日志
    const routeStats: Record<string, number> = {};
    for (const { route, hits } of routeHits) {
      routeStats[route] = (routeStats[route] ?? 0) + hits.length;
    }
    const ms = Date.now() - t0;
    if (routeHits.length > 0) {
      console.log(`[SearchOrchestrator] ${routeHits.length}路并行 → ${fused.hits.length}条融合 (${ms}ms) | routes=${JSON.stringify(routeStats)}`);
    }

    return { hits: fused.hits, routeStats, scoreMap: fused.scoreMap };
  }
}

// 导出单例
export const searchOrchestrator = new SearchOrchestrator();
