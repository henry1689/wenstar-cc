/**
 * adapter.ts — 多路检索统一适配器接口 + 注册表 + 并行执行（Foundation V1.0）
 * =========================================================================
 * 每个存储域实现一个 RetrievalAdapter，编排层统一注册 + 统一执行。
 *
 * 设计原则：
 *   - 适配器天然 async → 可被 Promise.all 并行调度（未来 SearchOrchestrator 的入口）
 *   - 过滤统一：编排层构造 PolicePolicy 随 ctx 下发，runAdapter 统一兜底 policeFilterHits
 *     （deny-by-default），适配器漏过滤也不漏网
 *   - 并行基础：runAllAdapters 用 Promise.all 并发 + 按 route 分组，返回结构直接喂 fuseHits
 */

import type { SearchDomain, RetrievalRoute, RetrievalContext, RouteHitList, SearchHit } from './types.js';
import type { PolicePolicy } from '../../governance/police/UUIDPoliceFilter.js';
import { passes } from '../../governance/police/UUIDPoliceFilter.js';

/**
 * 检索适配器 — 每个存储域实现一个。
 * search(ctx) 天然 async，内部必须做行级过滤；编排层 runAdapter 再兜底。
 */
export interface RetrievalAdapter {
  /** 唯一域标识 */
  readonly domain: SearchDomain;
  /** 该适配器可产出的召回路（命中自带 route，此列表用于权重注册/调试） */
  readonly routes: readonly RetrievalRoute[];
  /**
   * 过滤模式（默认 'deny'）：
   *   - 'deny'         — deny-by-default：不在白名单拒绝，无归属记录仅 allowUnowned=true 可见
   *   - 'allow-common' — 知识库语义：无归属（通用知识）放行 + 白名单内当事人知识放行，白名单外拒绝
   */
  readonly filterMode?: 'deny' | 'allow-common';
  /** 执行检索 */
  search(ctx: RetrievalContext): Promise<SearchHit[]>;
}

/** 适配器注册表 */
export class AdapterRegistry {
  private map = new Map<SearchDomain, RetrievalAdapter>();

  register(adapter: RetrievalAdapter): void {
    this.map.set(adapter.domain, adapter);
  }

  get(domain: SearchDomain): RetrievalAdapter | undefined {
    return this.map.get(domain);
  }

  all(): RetrievalAdapter[] {
    return [...this.map.values()];
  }
}

/**
 * 行级兜底过滤。
 * 适配器漏过滤也不漏网：
 *   - 'deny'（默认）— deny-by-default：不在白名单 = 拒绝；无归属记录仅在 allowUnowned=true 可见
 *   - 'allow-common' — 知识库语义：无归属（通用知识）放行 + 白名单内当事人知识放行，白名单外拒绝
 */
export function policeFilterHits(
  hits: SearchHit[],
  policy: PolicePolicy,
  filterMode: 'deny' | 'allow-common' = 'deny',
): SearchHit[] {
  if (policy.enforce === false) return hits;
  return hits.filter(h => {
    if (filterMode === 'allow-common') {
      // 无归属（通用知识）放行；有归属必须过白名单（deny-by-default）
      return !h.entityUuid || passes(h.entityUuid, policy);
    }
    return passes(h.entityUuid, policy);
  });
}

/**
 * 单适配器执行：search + 统一兜底过滤 + timeMs 补全。
 */
export async function runAdapter(
  adapter: RetrievalAdapter,
  ctx: RetrievalContext,
): Promise<SearchHit[]> {
  const t0 = Date.now();
  let hits: SearchHit[] = [];
  try {
    hits = await adapter.search(ctx);
  } catch (e) {
    console.error(`[RetrievalAdapter] ${adapter.domain} 检索异常:`, (e as Error)?.message);
    return [];
  }
  hits = policeFilterHits(hits, ctx.policy, adapter.filterMode ?? 'deny');
  const now = ctx.nowMs ?? Date.now();
  for (const h of hits) {
    if (h.timeMs == null && h.createdAt) {
      const ts = new Date(h.createdAt).getTime();
      h.timeMs = isNaN(ts) ? undefined : ts;
    }
  }
  const ms = Date.now() - t0;
  if (hits.length > 0) console.log(`[RetrievalAdapter] ${adapter.domain} → ${hits.length} 命中 (${ms}ms)`);
  return hits;
}

/**
 * 全适配器并行执行（未来 SearchOrchestrator 的入口）。
 * Promise.all 并发，按 route 分组返回，直接喂 fuseHits。
 *
 * 并行安全性：各适配器无共享可变状态（只读 db + 独立返回数组），Promise.all 安全。
 */
export async function runAllAdapters(
  registry: AdapterRegistry,
  ctx: RetrievalContext,
): Promise<RouteHitList[]> {
  const adapters = registry.all();
  if (adapters.length === 0) return [];

  const groups = new Map<RetrievalRoute, SearchHit[]>();
  await Promise.all(adapters.map(async (ad) => {
    const hits = await runAdapter(ad, ctx);
    for (const h of hits) {
      const r = h.route ?? 'default';
      const arr = groups.get(r);
      if (arr) arr.push(h);
      else groups.set(r, [h]);
    }
  }));

  return [...groups.entries()].map(([route, hits]) => ({ route, hits }));
}

/** buildPolicePolicy 入参（gatekeeper 可选；缺省视为户主钥匙场景） */
export interface PoliceSource {
  /** 当前请求的 gatekeeper（提供三层合并白名单） */
  gatekeeper?: { getEffectiveWhitelist(): Set<string> } | null;
  /** 活跃实体 UUID（会晤白名单 / 户主活跃实体） */
  activeEntityUuids?: string[];
  /** 是否处于会晤隔离墙场景（deny-by-default，无归属记录 deny） */
  meetingMode?: boolean;
  /** 🔴 2026-09-16: 本体白名单（玉瑶 UUID + 用户本人 UUID）。
   *  普通模式（非会晤）下作为可见集合基底，使所有会晤角色的记录被排除。 */
  householdUuids?: string[];
}

/**
 * 构造 PolicePolicy — 镜像 retrieval-stage 现状语义。
 *   - 会晤模式（meetingMode=true）：白名单 = gatekeeper 有效白名单 ∪ activeEntityUuids，allowUnowned=false
 *   - 户主钥匙：有白名单 → allowUnowned=true；无白名单（无 gatekeeper 且无活跃实体）→ enforce:false（最高权限）
 */
export function buildPolicePolicy(src: PoliceSource): PolicePolicy {
  const uuids = new Set<string>();
  if (src.gatekeeper) {
    for (const u of src.gatekeeper.getEffectiveWhitelist()) uuids.add(u);
  }
  for (const u of src.activeEntityUuids ?? []) if (u) uuids.add(u);

  if (src.meetingMode) {
    return { visibleUuids: uuids, allowUnowned: false };
  }

  // 🔴 2026-09-16 数据卫生: 普通模式（非会晤）排除所有会晤角色的记录。
  //    原实现无白名单时 enforce:false（完全不限）→ 会晤实体的记忆被普通对话召回。
  //    现改为：可见集 = 本体白名单（玉瑶 + 用户本人）；无归属记录仍放行（allowUnowned:true，
  //    避免误伤历史无归属数据）；其余实体（A/B/G/X 等会晤角色）的记录一律拒绝 ——
  //    与会晤模式的严格隔离互为对称。
  if (src.householdUuids && src.householdUuids.length > 0) {
    const own = new Set<string>(uuids);
    for (const u of src.householdUuids) if (u) own.add(u);
    return { visibleUuids: own, allowUnowned: true, enforce: true };
  }

  // 户主钥匙：无任何白名单 → 最高权限（enforce:false，不限制）；有白名单 → allowUnowned=true
  if (uuids.size === 0) {
    return { visibleUuids: uuids, allowUnowned: true, enforce: false };
  }
  return { visibleUuids: uuids, allowUnowned: true };
}
