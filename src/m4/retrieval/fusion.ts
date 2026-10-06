/**
 * fusion.ts — 多路检索统一融合阶段（Foundation V1.0）
 * ====================================================
 * 纯函数融合：输入多路召回命中，输出融合后命中。
 *
 * 复用已测模块（不改动）：
 *   - RRFFusion.weightedRRF      — 多路排名融合
 *   - MMRDiversifier.mmrDiversify — 多样性去重
 *
 * 与 V13 现有实现（UnifiedSearchEngine.searchV13 L6）的关键差异：
 *   - V13 MMR 用合成分数 `1.0 - i*0.02`（纯排名、与真实相关度无关）
 *     本实现用真实 `rrfScore + recencyFactor * recencyRatio` 做 MMR 相关性项。
 *   - 时间近因从"RRF 排序里的临时 _timeBonus 闭包"抽成可注入 nowMs 的纯函数。
 *
 * 设计原则：
 *   - 注入 nowMs → 完全可测（无 Date.now 内部调用）
 *   - 只认 route 做融合，只认 domain+dedupeKey 做去重 → route/domain 语义分离
 */

import { weightedRRF, DEFAULT_RRF_CONFIG, type RRFConfig } from '../RRFFusion.js';
import { getRetrievalFusionConfig } from '../../config/retrieval-fusion-config.js';
import { mmrDiversify, type MMRConfig } from '../MMRDiversifier.js';
import type { RankedItem, RankedList } from '../types/retrieval.js';
import type { SearchHit, RouteHitList, FuseOptions, FuseResult } from './types.js';
import { dedupeKeyOf } from './types.js';

/** 默认融合权重 = 现有 6 路权重 + 新增域路由权重
 *  🔴 P1 配置化: Foundation 域权重从 yaml 读取（retrieval-fusion.config.yaml） */
export const FOUNDATION_DEFAULT_WEIGHTS: Record<string, number> = (() => {
  const fw = getRetrievalFusionConfig().foundation_rrf_domain_weight;
  return {
    ...DEFAULT_RRF_CONFIG.weights,
    diamond: fw.black_diamond ?? 0.25,   // 黑钻固化记忆（高价值）
    knowledge: fw.knowledge ?? 0.15,     // 知识库
    vault: fw.vault ?? 0.10,             // 金库 promote 记录
    note: 0.08,                          // 玉瑶记事
    profile: 0.08,                       // FG 人物档案
    conversation: 0.05,                  // 对话直取
    // 🔴 ADR-010 P1-C1: 对话块（一段连贯场景，多轮聚合）。
    //   必须在此显式映射 —— RRFFusion 是 `config.weights[route] ?? 0.05`，
    //   缺映射**不报错**，但块路会被静默压到最低档 0.05（比 conversation 还低），
    //   几乎永远排不上来 ⇒ P1-C1 白做，且失败完全静默。
    //   取值从 yaml foundation_rrf_domain_weight.dialog_group 读（与既有 5 个域同源，不硬编码）。
    //   0.28 的定位：高于单条对话/记事（块是中期记忆的主要承载者），
    //   低于黑钻（块是原始素材，黑钻是已提炼的结论）。
    dialog_group: fw.dialog_group ?? 0.28,
  };
})();

/**
 * 时间近因比率（复刻 UnifiedSearchEngine P3-B2 的 7 天线性衰减，参数化纯函数）。
 * 值域 [0, 1]，1 = 今天，0 = 7 天前及更早。
 * 注入 nowMs 保证确定性可测。
 */
export function recencyRatio(hit: SearchHit, nowMs: number): number {
  const ts = hit.timeMs ?? (hit.createdAt ? new Date(hit.createdAt).getTime() : NaN);
  if (isNaN(ts)) return 0;
  const daysAgo = (nowMs - ts) / 86400000;
  if (daysAgo < 0) return 1.0;                  // 未来/异常时间戳 → 微弱加分上限（对齐 P3-B2 语义）
  if (daysAgo <= 7) return 1 - daysAgo / 7;     // 近 7 天线性衰减
  return 0;
}

/**
 * 融合多路召回 → 融合结果。
 *
 * @param routeHits 多路命中（路内已按 score 降序）
 * @param opts      融合选项（可注入 nowMs / 权重 / topK）
 * @returns         融合后命中（按最终分排序，MMR 去重）+ 真实融合分
 */
export function fuseHits(routeHits: RouteHitList[], opts: FuseOptions = {}): FuseResult {
  const nowMs = opts.nowMs ?? Date.now();
  const k = opts.k ?? DEFAULT_RRF_CONFIG.k;
  const weights = { ...FOUNDATION_DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const bonus = opts.multiHitBonus ?? DEFAULT_RRF_CONFIG.multiHitBonus;
  const recencyFactor = opts.recencyFactor ?? 0.10;

  // 空输入 → 空结果
  if (routeHits.length === 0) return { hits: [], scoreMap: new Map() };

  // 1. 构造 RankedList[]（用 dedupeKey 作为 RRF 的 id，跨域折叠）
  const keyToHit = new Map<string, SearchHit>();
  const lists: RankedList[] = [];
  for (const { route, hits } of routeHits) {
    if (!hits || hits.length === 0) continue;
    const items: RankedItem[] = hits.map(h => {
      const key = dedupeKeyOf(h);
      // 同 key 后出现的命中覆盖先出现的（保留 text/score 更完整的）
      keyToHit.set(key, h);
      return {
        id: key,
        text: h.text,
        score: h.score,
        source: route as RankedItem['source'],
        entityUuid: h.entityUuid,
        calciumScore: h.calciumScore ?? 0,
        createdAt: h.createdAt,
      };
    });
    lists.push({ source: route as RankedItem['source'], items });
  }
  if (lists.length === 0) return { hits: [], scoreMap: new Map() };

  // 2. L3 · Weighted RRF（按 route 权重，跨域去重靠 dedupeKey）
  const rrfConfig: RRFConfig = { k, weights, multiHitBonus: bonus };
  const fused = weightedRRF(lists, rrfConfig, opts.rrfTopK ?? 50);

  // 3. L3.5 · 时间近因叠加（真实分，非合成）
  const scoreMap = new Map<string, number>();
  for (const f of fused) {
    const hit = keyToHit.get(f.id);
    scoreMap.set(f.id, f.rrfScore + (hit ? recencyFactor * recencyRatio(hit, nowMs) : 0));
  }

  // 4. L6 · MMR 多样性（用真实 RRF+近因分做相关性项）
  const candidates = fused
    .map(f => keyToHit.get(f.id))
    .filter((h): h is SearchHit => !!h);
  const slim: RankedItem[] = candidates.map(h => ({
    id: dedupeKeyOf(h),
    text: h.text,
    score: h.score,
    source: (h.route ?? 'default') as RankedItem['source'],
    entityUuid: h.entityUuid,
    calciumScore: h.calciumScore ?? 0,
    createdAt: h.createdAt,
  }));
  const mmrConfig: MMRConfig = { lambda: opts.lambda ?? 0.7, topK: opts.topK ?? 10 };
  const selected = mmrDiversify(slim, scoreMap, mmrConfig);

  const hits = selected
    .map(s => keyToHit.get(s.id))
    .filter((h): h is SearchHit => !!h);

  return { hits, scoreMap };
}
