/**
 * UnifiedSearchEngine — 七层仿生检索管线 (V13.0)
 * ================================================
 * L0 时序围栏 → L1 情绪预筛 → L2 n-gram 粗筛 → L3 Weighted RRF
 * → L4 DAG 闭包 → L5 Cross-Encoder → L6 Foresight+MMR → L7 叙事组装
 *
 * 全部检索请求的唯一入口。每层独立 feature-flag、独立降级。
 */

import { buildNgrams } from './SearchIndexBuilder.js';
import { rankByVector, type MemoryCandidate, type RankedMemory, type SearchMode } from './VectorReranker.js';
import type { PerceptionState24 } from '../m3/types/perception.js';
import { decodePerceptionV40, cosineSimilarity40D } from '../m2/PerceptionVector40DCodec.js';
import { isPerception40DEnabled } from '../config/perception-40d-config.js';
import { PERCEPTION_40D_KEYS, type PerceptionV40 } from '../m3/types/perception-40d.js';
import { buildSqlClause, passes as policePasses, policyFor } from '../governance/police/UUIDPoliceFilter.js';

// ── V12.0 新管线模块 ──
import { weightedRRF, buildIdToItem, DEFAULT_RRF_CONFIG, type RRFConfig } from './RRFFusion.js';
import { mmrDiversify, getMMRConfig } from './MMRDiversifier.js';
import type { MultiRankResult, RankedItem } from './types/retrieval.js';
import type { CrossEncoderReranker } from './rerank/CrossEncoderReranker.js';
import { NoopCrossEncoderReranker } from './rerank/NoopCrossEncoderReranker.js';
import { AlgorithmicCrossEncoder } from './rerank/AlgorithmicCrossEncoder.js';

// ── V13.0 全链路模块 ──
import { DEFAULT_FULL_PIPELINE_CONFIG, type FullSearchPipelineConfig, DEGRADATION_RULES } from './SearchConfig.js';
import type { MemoryAssociationRepository } from './graph/MemoryAssociationRepository.js';
import { MemoryClosureRetriever, type ClosureRetrieveInput } from './graph/MemoryClosureRetriever.js';
import { CausalSkeletonPruner } from './graph/CausalSkeletonPruner.js';
import { MemoryNarrativeAssembler, type MemoryNarrative } from './narrative/MemoryNarrativeAssembler.js';
import { filterExpiredForesight, annotateForesightWarnings, type ForesightAwareItem } from './filters/ForesightValidityFilter.js';

/** 检索结果扩展 V13 */
export interface SearchResultV13 extends SearchResult {
  /** DAG 闭包子图信息（L4 开启时填充） */
  closure?: { nodeCount: number; edgeCount: number; seedCount: number };
  /** Foresight 警告（L6 开启时填充） */
  foresightWarnings?: string[];
  /** 叙事组装输出（L7 开启时填充） */
  narrative?: MemoryNarrative;
  /** 每层延迟 (ms) */
  layerLatency?: Record<string, number>;
  /** 降级记录 */
  degradations?: string[];
}

// ── 搜索选项 ──
export interface SearchOptions {
  /** 检索力度模式 */
  mode?: SearchMode;
  /** 🔴 P072 批2: M3 原生 40D 查询向量（唯一合法查询量纲，禁 24D 投影——法令第四条） */
  p40?: PerceptionV40 | null;
  /** 实体UUID过滤（可选，传入当前对话的实体UUID列表） */
  entityUuids?: string[];
  /** 时间范围过滤（可选，ISO 8601 起止时间） */
  timeRange?: { start: string; end?: string };
  /** 最大返回条数 */
  limit?: number;
  /** 是否包含知识库 */
  includeKnowledgeBase?: boolean;
}

/** 搜索结果 */
export interface SearchResult {
  items: string[];                // 格式化后的记忆文本（可直接注入 memoryFragments）
  raw: RankedMemory[];            // 原始排序结果
  hitsBySource: Record<string, number>;
  totalCandidates: number;
}

/**
 * 搜索入口
 *
 * @param db     sql.js Database 实例
 * @param query  用户消息原文
 * @param perception 当前感知向量（🔴 中间层 P074 待废；精排用 p40 原生40D）
 * @param opts   搜索选项
 * @returns 搜索结果
 */
export function search(
  db: any,
  query: string,
  perception?: PerceptionState24 | null,
  opts: SearchOptions = {},
): SearchResult {
  // 🔴 2026-11-02 业主裁决「彻底拆除 n-gram」：本函数原为 V11 旧搜索引擎，
  //   其唯一候选来源是 search_index 的 n-gram 初筛；而该索引的四个分区在
  //   v11 之后均已无写入方（0 行），初筛恒为空 —— 保留即为「假兜底」。
  //   V13 主链走 retrieveMultiRank 六路 + searchV13，不经过本函数；
  //   V13 失败时的降级由 B4 接线到 recallByStructured（同一套 UUID 闸门 /
  //   分片围栏 / 四权重精排），不存在第二套倒排实现。
  return { items: [], raw: [], hitsBySource: {}, totalCandidates: 0 };
}

/**
 * 批量搜索（对同一查询、不同实体UUID并行）
 */
export function searchByEntity(
  db: any,
  query: string,
  entityUuids: string[],
  perception?: PerceptionState24 | null,
  opts: SearchOptions = {},
): Map<string, SearchResult> {
  const results = new Map<string, SearchResult>();
  for (const uuid of entityUuids) {
    results.set(uuid, search(db, query, perception, { ...opts, entityUuids: [uuid] }));
  }
  return results;
}

// ───────────────────────────────────────────────────────────
//  V12.0 新检索管线: 四路召回 → Weighted RRF → MMR 多样性
// ───────────────────────────────────────────────────────────

/** 按检索模式获取 RRF 配置 */
function getRRFConfig(mode?: SearchMode): RRFConfig {
  if (mode === 'full') {
    return { ...DEFAULT_RRF_CONFIG, k: 50 };  // 全开模式: k 减小, 排名影响更大
  }
  if (mode === 'introvert') {
    return { ...DEFAULT_RRF_CONFIG, k: 80 };   // 内敛模式: k 增大, 强相关优先
  }
  return DEFAULT_RRF_CONFIG;
}

/** 延迟创建 Cross-Encoder 实例（V13.0: Algorithmic 精排, 后台尝试 ONNX 升级） */
let _crossEncoder: CrossEncoderReranker | null = null;
let _ceUpgradeStarted = false;
function getCrossEncoder(): CrossEncoderReranker {
  if (!_crossEncoder) {
    // 默认：轻量算法精排（比 Noop 好，零网络依赖）
    _crossEncoder = new AlgorithmicCrossEncoder();
  }
  // 后台异步尝试升级到 ONNX（如果模型文件存在且网络可达）
  if (!_ceUpgradeStarted && process.env.WS_CROSS_ENCODER_ENABLED === 'true') {
    _ceUpgradeStarted = true;
    import('./rerank/OnnxCrossEncoderReranker.js').then(({ OnnxCrossEncoderReranker }) => {
      const onnx = new OnnxCrossEncoderReranker();
      onnx.warmup().then((ok: boolean) => {
        if (ok) {
          _crossEncoder = onnx;
          console.log('[CrossEncoder] ✅ 升级到 ONNX 精排');
        } else {
          console.log('[CrossEncoder] ⚠️ ONNX 模型未就绪, 保持算法精排');
          setTimeout(() => { _ceUpgradeStarted = false; }, 60_000);
        }
      });
    }).catch(() => {
      console.log('[CrossEncoder] ℹ️ ONNX 模块不可用, 保持算法精排');
    });
  }
  return _crossEncoder;
}

/**
 * V12.0 四路独立召回 + Weighted RRF 融合 + MMR 多样性
 * ===================================================
 * 入口: 调用方先通过 MemoryRetriever.retrieveMultiRank() 获取四路排名,
 *       然后传入本函数做融合。
 *
 * 设计原则:
 *   - 不删旧 search()，通过 feature flag (WS_SEARCH_V12) 切换
 *   - 输出 SearchResult 格式与旧管线兼容
 *   - Cross-Encoder 预留接口（Phase 3 切换）
 *
 * @param db         sql.js Database 实例
 * @param multiRank  来自 MemoryRetriever.retrieveMultiRank() 的四路排名
 * @param query      用户查询原文（供 Cross-Encoder 使用）
 * @param perception 当前感知向量（旧管线兼容参数，V12 暂不直接使用；🔴 中间层 P074 待废）
 * @param opts       搜索选项
 * @returns 搜索结果（格式与旧 search() 兼容）
 */
export function searchV12(
  db: any,
  multiRank: MultiRankResult,
  query: string,
  perception?: PerceptionState24 | null,
  opts: SearchOptions = {},
): SearchResult {
  const mode = opts.mode || 'balanced';
  const limit = opts.limit || 8;
  const entityUuids = opts.entityUuids || [];

  // 空召回 → 直接返回
  if (multiRank.lists.length === 0 || multiRank.totalCandidates === 0) {
    return { items: [], raw: [], hitsBySource: {}, totalCandidates: 0 };
  }

  // ═══════════ L3 · Weighted RRF 融合 ═══════════
  const rrfConfig = getRRFConfig(mode);
  const fused = weightedRRF(multiRank.lists, rrfConfig, 50);

  // ═══════════ 从多路排名中 enrichment ═══════════
  const idToItem = buildIdToItem(multiRank.lists);

  // 按 entityUuid 过滤
  // 🔴 P0-A3 修复: 原 `!item.entityUuid || uuidSet.has(...)` 放行无归属记录（会晤场景也放行），
  //   违反 UUID 法 deny-by-default。改用 policePasses。
  let enriched: RankedItem[] = fused.map(f => idToItem.get(f.id)).filter(Boolean) as RankedItem[];
  if (entityUuids.length > 0) {
    const uuidSet = new Set(entityUuids);
    enriched = enriched.filter(item => policePasses(item.entityUuid, policyFor('private', uuidSet)));
  }

  // ═══════════ L6 · MMR 多样性去重（L4/L5 预留给 Phase 2/3） ═══════════
  const relevanceMap = new Map<string, number>();
  for (const f of fused) relevanceMap.set(f.id, f.rrfScore);

  const mmrConfig = getMMRConfig(mode);
  const diverse = mmrDiversify(enriched, relevanceMap, mmrConfig);

  // ═══════════ 格式化输出（保持向后兼容） ═══════════
  const items: string[] = [];
  const rawRanked: RankedMemory[] = [];

  for (let i = 0; i < Math.min(diverse.length, limit); i++) {
    const d = diverse[i];
    const prefix = d.source === 'spine' ? '💎'
      : d.source === 'entity' ? '👤' : '💭';
    items.push(`${prefix} ${d.text || '(无文本)'}`);
    rawRanked.push({
      item: {
        id: d.id,
        text: d.text,
        source: d.source === 'spine' ? 'black_diamond'
          : d.source === 'keyword' || d.source === 'locus' ? 'conversation'
          : 'memory',
        calciumScore: d.calciumScore,
        entityUuid: d.entityUuid,
        createdAt: d.createdAt,
      },
      score: d.mmrScore,
      emotionSim: 0,
      fullSim: 0,
      decay: 1,
    });
  }

  // 统计各来源命中数
  const hitsBySource: Record<string, number> = {};
  for (const d of diverse) {
    const key = d.source;
    hitsBySource[key] = (hitsBySource[key] ?? 0) + 1;
  }

  return {
    items,
    raw: rawRanked,
    hitsBySource,
    totalCandidates: multiRank.totalCandidates,
  };
}

export default { search, searchByEntity, searchV12, searchV13 };

// ───────────────────────────────────────────────────────────
//  V13.0 七层仿生检索管线 (全链路)
// ───────────────────────────────────────────────────────────

/** L0 时序围栏：按时间范围过滤记忆候选 */
function _temporalFence(
  items: RankedItem[],
  timeRange?: { start: string; end?: string },
): RankedItem[] {
  if (!timeRange) return items;
  const startMs = new Date(timeRange.start).getTime();
  const endMs = timeRange.end ? new Date(timeRange.end).getTime() : Date.now();
  return items.filter(item => {
    if (!item.createdAt) return true;
    const ts = new Date(item.createdAt).getTime();
    return ts >= startMs && ts <= endMs;
  });
}

/** L1 情绪共振预筛选：海马体索引命中优先排序 */
function _emotionPreselect(
  items: RankedItem[],
  multiRank: MultiRankResult,
): RankedItem[] {
  if (!multiRank.indexHit || multiRank.indexedIds.length === 0) return items;
  const idSet = new Set(multiRank.indexedIds);
  const indexed = items.filter(i => idSet.has(i.id));
  const others = items.filter(i => !idSet.has(i.id));
  return [...indexed, ...others];
}

/**
 * V13.0 七层仿生检索管线
 * =======================
 * L0 时序围栏 → L1 情绪预筛 → L3 RRF → L4 DAG 闭包
 * → L5 Cross-Encoder → L6 Foresight+MMR → L7 叙事组装
 *
 * 每层独立 feature-flag、独立降级。失败不阻塞后续层。
 */
export async function searchV13(
  db: any,
  multiRank: MultiRankResult,
  query: string,
  perception?: PerceptionState24 | null,
  opts: SearchOptions = {},
  pipelineConfig?: Partial<FullSearchPipelineConfig>,
  dagRepo?: MemoryAssociationRepository | null,
  /** V3: M3 产出的 40D 感知向量 — 40D 查询向量（唯一合法查询量纲） */
  perceptionV40?: PerceptionV40 | null,
): Promise<SearchResultV13> {
  const t0 = Date.now();
  const cfg = { ...DEFAULT_FULL_PIPELINE_CONFIG, ...pipelineConfig };
  const mode = opts.mode || 'balanced';
  const limit = opts.limit || 8;
  const entityUuids = opts.entityUuids || [];
  const layerLatency: Record<string, number> = {};
  const degradations: string[] = [];
  let lastT = t0;

  const _mark = (layer: string) => {
    layerLatency[layer] = Date.now() - lastT;
    lastT = Date.now();
  };

  // 空召回 → 直接返回
  if (multiRank.lists.length === 0 || multiRank.totalCandidates === 0) {
    return { items: [], raw: [], hitsBySource: {}, totalCandidates: 0, layerLatency };
  }

  // ═══════════ L0 · 时序围栏 ═══════════
  const idToItem = buildIdToItem(multiRank.lists);
  let candidates: RankedItem[] = [...idToItem.values()];
  if (opts.timeRange) {
    candidates = _temporalFence(candidates, opts.timeRange);
  }
  _mark('L0_temporal');

  // ═══════════ L1 · 情绪共振预筛选 ═══════════
  candidates = _emotionPreselect(candidates, multiRank);
  _mark('L1_emotion');

  // ═══════════ L3 · Weighted RRF 融合 ═══════════
  try {
    const rrfConfig = getRRFConfig(mode);
    const fused = weightedRRF(multiRank.lists, rrfConfig, cfg.rrfTopK);
    const fusedIds = new Set(fused.map(f => f.id));
    candidates = candidates.filter(c => fusedIds.has(c.id));
    // 按 RRF 排序
    const rrfMap = new Map(fused.map(f => [f.id, f.rrfScore]));
    // 🔴 P3-B2 修复: RRF 基础上叠加时间近因因子（时空系统进入检索）
    // 近期（7天内）候选小幅加分，远期衰减——符合"人脑近因效应"，
    // 且不破坏 RRF 相关性主排序（时间仅作次级信号，权重 10%）。
    const _nowB2 = Date.now();
    const _timeBonus = (c: RankedItem): number => {
      if (!c.createdAt) return 0;
      const ts = new Date(c.createdAt).getTime();
      if (isNaN(ts)) return 0;
      const daysAgo = (_nowB2 - ts) / 86400000;
      if (daysAgo < 0) return 0.1;          // 未来/异常时间戳 → 微弱加分
      if (daysAgo <= 7) return 0.10 * (1 - daysAgo / 7);  // 近7天线性衰减
      return 0;
    };
    candidates.sort((a, b) =>
      ((rrfMap.get(b.id) ?? 0) + _timeBonus(b)) - ((rrfMap.get(a.id) ?? 0) + _timeBonus(a))
    );
    _mark('L3_RRF');
  } catch {
    degradations.push(DEGRADATION_RULES.RRF);
    _mark('L3_RRF_fallback');
  }

  // ═══════════ L4 · DAG 闭包展开 ═══════════
  // 🔴 P2-A12 修复: 户主场景（entityUuids 空）跳过 DAG 闭包——原 belongEntityUuid=''
  //   导致 getEdges 查 `belong_entity_uuid = ''` 无结果，闭包恒空。
  //   多实体会晤: 遍历每个实体各跑闭包，合并节点（不局限于第一个实体）。
  let closureResult: any = null;
  if (cfg.enableDAGClosure && dagRepo && candidates.length > 0 && entityUuids.length > 0) {
    try {
      const seedUids = candidates.slice(0, 15).map(c => c.id);
      const retriever = new MemoryClosureRetriever(dagRepo);
      const pruner = new CausalSkeletonPruner();
      const existingIds = new Set(candidates.map(c => c.id));
      const mergedNodes: any[] = [];
      // 多实体遍历：每个实体的 DAG 边独立展开，节点合并（避免跨实体边泄漏）
      for (const eu of entityUuids.slice(0, 3)) {
        try {
          const rawClosure = retriever.retrieve({
            namespace: 'default',
            belongEntityUuid: eu,
            seedGlobalUids: seedUids,
            maxDepth: cfg.closureMaxDepth,
            maxNodes: cfg.closureMaxNodes,
          });
          const pruned = pruner.prune(rawClosure, {
            maxNodes: cfg.skeletonMaxNodes,
            maxEdges: cfg.skeletonMaxEdges,
          });
          for (const node of pruned.nodes) {
            mergedNodes.push({ ...node, entityUuid: eu });
          }
        } catch { /* 单实体闭包失败不阻塞 */ }
      }
      closureResult = { nodes: mergedNodes, edges: [], seedGlobalUids: seedUids };
      // 将闭包节点追加到候选列表（不重复）
      for (const node of mergedNodes) {
        if (!existingIds.has(node.globalUid)) {
          candidates.push({
            id: node.globalUid, text: '', source: 'entity',
            score: 0.3, entityUuid: node.entityUuid ?? null,
            calciumScore: 0, createdAt: '',
          });
        }
      }
      _mark('L4_DAG');
    } catch {
      degradations.push(DEGRADATION_RULES.DAGClosure);
      _mark('L4_DAG_fallback');
    }
  } else {
    _mark('L4_DAG_skip');
  }

  // ═══════════ L5 · Cross-Encoder 终判 ═══════════
  if (cfg.enableCrossEncoder && candidates.length > 0) {
    try {
      const crossEnc = getCrossEncoder();
      const topForRerank = candidates.slice(0, cfg.rrfTopK);
      const crossCands = topForRerank.map(c => ({
        globalUid: c.id, content: c.text, sourceType: c.source, score: c.score,
      }));
      const reranked = await crossEnc.rerank(query, crossCands, {
        topK: cfg.crossEncoderTopK,
        batchSize: cfg.crossEncoderBatchSize,
        timeoutMs: cfg.crossEncoderTimeoutMs,
      });
      const rerankMap = new Map(reranked.map(r => [r.globalUid, r.crossScore]));
      candidates.sort((a, b) => (rerankMap.get(b.id) ?? 0) - (rerankMap.get(a.id) ?? 0));
      _mark('L5_CrossEncoder');
    } catch {
      degradations.push(DEGRADATION_RULES.CrossEncoder);
      _mark('L5_CrossEncoder_fallback');
    }
  } else {
    _mark('L5_CrossEncoder_skip');
  }

  // ═══════════ L6 · Foresight 时效过滤 + MMR 多样性 ═══════════
  let foresightWarnings: string[] = [];
  if (cfg.enableForesightFilter) {
    try {
      // 🔴 candidates 本身就满足 ForesightAwareItem（isForesight 为 undefined → filter 全放行）
      candidates = filterExpiredForesight(candidates as any, {
        nowMs: Date.now(),
        includeExpired: cfg.foresightIncludeExpired,
      }) as any;
      foresightWarnings = annotateForesightWarnings(candidates as any);
      _mark('L6_Foresight');
    } catch {
      degradations.push(DEGRADATION_RULES.Foresight);
      _mark('L6_Foresight_fallback');
    }
  } else {
    _mark('L6_Foresight_skip');
  }

  // ═══════════ L6.5 · 40D 情感重排（V20 混合检索）═══════════
  // 在 MMR/最终排序前，用 40D 扇区加权相似度重排候选，让 40D 记忆优先。
  // 候选 id 匹配 memories.id（emotion/keyword/locus/entity 路）或 global_uid（spine 路）。
  if (isPerception40DEnabled() && (perceptionV40 || perception) && candidates.length > 1) {
    try {
      // 🔴 P072 批2: 24D 投影回退已删——查询向量唯一来源 = M3 原生 perceptionV40，缺失即跳过精排
      const q40 = perceptionV40;
      if (!q40) throw new Error('无 40D 查询向量');
      const ids = candidates.map(c => c.id).slice(0, 100);
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.exec(
        `SELECT id, perception_40d FROM memories WHERE id IN (${placeholders}) OR global_uid IN (${placeholders})`,
        [...ids, ...ids],
      );
      const p40Map = new Map<string, number>(); // id → sim40
      if (rows.length && rows[0].values) {
        for (const [id, p40d] of rows[0].values) {
          const mem40 = decodePerceptionV40(p40d ? String(p40d) : null);
          if (mem40) {
            const sim40 = cosineSimilarity40D(q40, mem40);
            const key = String(id);
            p40Map.set(key, Math.max(p40Map.get(key) ?? 0, sim40));
          }
        }
      }
      if (p40Map.size > 0) {
        // 🔴 S2-R5: P40_FLOOR 地板 — sim40<0.15 的记忆不置顶于无 40D 记忆之上（避免弱相关记忆抢占）
        const P40_FLOOR = 0.15;
        const with40 = candidates.filter(c => (p40Map.get(String(c.id)) ?? -1) >= P40_FLOOR);
        const without40 = candidates.filter(c => !with40.includes(c));
        with40.sort((a, b) => (p40Map.get(String(b.id)) ?? 0) - (p40Map.get(String(a.id)) ?? 0));
        candidates = [...with40, ...without40];
      }
    } catch { /* 40D 重排失败不阻塞 */ }
    _mark('L6_5_40d');
  }

  if (cfg.enableMMR) {
    try {
      const relevanceMap = new Map<string, number>();
      candidates.forEach((c, i) => relevanceMap.set(c.id, 1.0 - i * 0.02));
      candidates = mmrDiversify(candidates, relevanceMap, cfg.mmrConfig) as any;
      _mark('L6_MMR');
    } catch {
      degradations.push(DEGRADATION_RULES.MMR);
      candidates = candidates.slice(0, cfg.mmrConfig.topK);
      _mark('L6_MMR_fallback');
    }
  } else {
    candidates = candidates.slice(0, cfg.mmrConfig.topK);
    _mark('L6_MMR_skip');
  }

  // ═══════════ 实体隔离：按 entityUuid 过滤候选（V12 有此逻辑，V13 丢失） ═══════════
  // 🔴 P0-A3 修复: 原 `!c.entityUuid || uuidSet.has(...)` 放行无归属记录（会晤场景也放行），
  //   违反 UUID 法 deny-by-default。改用 policePasses（无归属仅在 allowUnowned=true 放行）。
  if (entityUuids.length > 0) {
    const uuidSet = new Set(entityUuids);
    candidates = candidates.filter(c => policePasses(c.entityUuid, policyFor('private', uuidSet)));
    _mark('L6_EntityFilter');
  }

  // ═══════════ L7 · 叙事组装 ═══════════
  let narrative: MemoryNarrative | undefined;
  if (cfg.enableNarrativeAssembler && closureResult) {
    try {
      const textMap = new Map<string, { rawInput: string; calciumScore?: number; emotion?: string; createdAt?: string; foresightStatus?: string }>();
      for (const c of candidates) {
        textMap.set(c.id, { rawInput: c.text, calciumScore: c.calciumScore, createdAt: c.createdAt });
      }
      const assembler = new MemoryNarrativeAssembler();
      narrative = assembler.assemble(closureResult, textMap, cfg.narrativeMaxTokens);
      _mark('L7_Narrative');
    } catch {
      degradations.push(DEGRADATION_RULES.Narrative);
      _mark('L7_Narrative_fallback');
    }
  } else {
    _mark('L7_Narrative_skip');
  }

  // ═══════════ 最终输出 ═══════════
  const items: string[] = [];
  const rawRanked: RankedMemory[] = [];

  for (let i = 0; i < Math.min(candidates.length, limit); i++) {
    const d = candidates[i];
    const prefix = d.source === 'spine' ? '💎' : d.source === 'entity' ? '👤' : '💭';
    items.push(`${prefix} ${d.text || '(无文本)'}`);
    rawRanked.push({
      item: {
        id: d.id, text: d.text,
        source: d.source === 'spine' ? 'black_diamond'
          : d.source === 'keyword' || d.source === 'locus' ? 'conversation' : 'memory',
        calciumScore: d.calciumScore,
        entityUuid: d.entityUuid, createdAt: d.createdAt,
      },
      score: (d as any).mmrScore ?? d.score,
      emotionSim: 0, fullSim: 0, decay: 1,
    });
  }

  const hitsBySource: Record<string, number> = {};
  for (const d of candidates.slice(0, limit)) {
    hitsBySource[d.source] = (hitsBySource[d.source] ?? 0) + 1;
  }

  _mark('L_output');

  // 如果叙事文本可用，追加到 items
  if (narrative && narrative.compactText && narrative.compactText.length > 0) {
    items.push(`📖 ${narrative.compactText.substring(0, 500)}`);
  }

  return {
    items,
    raw: rawRanked,
    hitsBySource,
    totalCandidates: multiRank.totalCandidates,
    closure: closureResult ? {
      nodeCount: closureResult.nodes.length,
      edgeCount: closureResult.edges.length,
      seedCount: closureResult.seedGlobalUids.length,
    } : undefined,
    foresightWarnings: foresightWarnings.length > 0 ? foresightWarnings : undefined,
    narrative,
    layerLatency,
    degradations: degradations.length > 0 ? degradations : undefined,
  };
}
