/**
 * orchestrate.ts — 多路检索底座统一接线入口（Foundation V1.0）
 * ============================================================
 * runFoundationRoutes：从检索编排层（retrieval-stage）调用的单一入口。
 *
 * 流程：构造 ctx → runAllAdapters（Promise.all 并行）→ fuseHits（RRF+近因+MMR）
 *       → formatHit（前缀文本）→ 返回 fragments。
 *
 * 设计约束：
 *   - 只处理"额外域"适配器（knowledge/black_diamond/work/vault/note）——S4/S5 接线范围
 *   - 不触碰 V13/V11 主链（searchV13/searchV11/retrieveMultiRank 原样执行）
 *   - 每个适配器异常独立隔离（runAdapter catch），失败不阻塞其他路
 */

import { createDefaultRegistry, type FoundationDeps } from './index.js';
import { runAllAdapters, buildPolicePolicy, type PoliceSource } from './adapter.js';
import { fuseHits } from './fusion.js';
import { formatHit } from './format.js';
import type { SearchHit, RetrievalContext } from './types.js';

/** 接线入口选项 */
export interface FoundationRouteOptions {
  /** 是否处于会晤隔离墙场景（deny-by-default） */
  meetingMode: boolean;
  /** 活跃实体 UUID（会晤白名单 / 户主活跃实体） */
  activeEntityUuids: string[];
  /** 话题切换（full 模式） */
  isTopicShift?: boolean;
  /** 感知向量（24D + 40D） */
  perception?: RetrievalContext['perception'];
  perception40d?: RetrievalContext['perception40d'];
  /** 时间导航参数 */
  timeRange?: RetrievalContext['timeRange'];
  /** 注入 now（融合近因因子） */
  nowMs?: number;
  /** 当前话题路径（显式传入优先；缺省回退 ctx._dna.locus_path）。修复 TS2353：接口曾不收该字段导致调用方传参被忽略 */
  locusPath?: string;
  /** DNA 实体（显式传入优先；缺省回退 ctx._dna.entity_genes）。形状与 RetrievalContext.entities 一致 */
  entities?: Array<{ name: string; type: string }>;
}

/** 结果 */
export interface FoundationRouteResult {
  /** 格式化后的注入片段（memoryFragments 追加用） */
  fragments: string[];
  /** 融合后命中（含 backref，供 recall_count 等下游） */
  hits: SearchHit[];
  /** 各阶段耗时（ms） */
  latency: Record<string, number>;
  /** 是否实际执行（deps 缺失时 false） */
  executed: boolean;
}

/**
 * 统一接线入口。
 *
 * @param ctx    ChatContext（含 storage/knowledgeBase/m4 等）或最小依赖对象
 * @param query  用户消息
 * @param opts   接线选项
 */
export async function runFoundationRoutes(
  ctx: any,
  query: string,
  opts: FoundationRouteOptions,
): Promise<FoundationRouteResult> {
  const t0 = Date.now();

  // 依赖收集：优先 ctx.foundationRegistry（server 注入），否则按需构造
  const deps: FoundationDeps = {
    sqlite: ctx?.storage?.getSQLite?.() ?? null,
    knowledgeBase: ctx?.knowledgeBase ?? null,
  };
  const registry = ctx?.foundationRegistry ?? createDefaultRegistry(deps);
  if (registry.all().length === 0) {
    return { fragments: [], hits: [], latency: { skipped: Date.now() - t0 }, executed: false };
  }

  // Police 构造（镜像 retrieval-stage 语义：会晤 deny / 户主最高权限）
  const policeSrc: PoliceSource = {
    gatekeeper: ctx?._gatekeeper ?? null,
    activeEntityUuids: opts.activeEntityUuids,
    meetingMode: opts.meetingMode,
  };
  const policy = buildPolicePolicy(policeSrc);

  const rctx: RetrievalContext = {
    query,
    policy,
    perception: opts.perception,
    perception40d: opts.perception40d,
    entityUuids: opts.activeEntityUuids,
    mode: opts.isTopicShift ? 'full' : 'balanced',
    // opts 显式传入优先（retrieval-stage 提供当前轮 DNA），缺省回退 ctx._dna（旧隐式路径）。
    // 修复契约漂移：此前忽略 opts 传入值从 ctx._dna 隐式取，ctx._dna 若滞后于当前轮 DNA 则检索域选错。
    locusPath: opts.locusPath ?? ((ctx?._dna as any)?.locus_path || 'default'),
    // S6: 供 MemoryAdapter 的 retrieveMultiRank 使用（M1 entity_genes 形状）
    entities: opts.entities ?? ((ctx?._dna as any)?.entity_genes ?? []).map((g: any) => ({ name: g.name, type: g.type })),
    limit: opts.isTopicShift ? 5 : 3,
    sessionId: ctx?.sessionId,
    timeRange: opts.timeRange,
    nowMs: opts.nowMs ?? Date.now(),
  };

  // 并行执行 + 融合 + 格式化
  const routeHits = await runAllAdapters(registry, rctx);
  const { hits } = fuseHits(routeHits, {
    nowMs: rctx.nowMs,
    topK: opts.isTopicShift ? 6 : 3,
    recencyFactor: 0.10,
  });

  const fragments = hits.map(h => formatHit(h, { preserveLabels: opts.meetingMode }));

  return {
    fragments,
    hits,
    latency: { adaptersMs: Date.now() - t0 },
    executed: true,
  };
}
