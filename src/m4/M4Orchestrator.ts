/**
 * M4Orchestrator — M4 知识融合层主控制器
 *
 * v2:
 * - 接入 Reranker 重排序（激活闲置能力）
 * - 全链路透传 DNA 根码
 * - 批量人物档案加载替代 N+1
 * - FG 摘要 30s 缓存 + 无新增实体短路
 * - QueryDecomposer 轻量化集成到检索前置
 * - 检索质量指标增强
 */
import type { M3Decision } from '../m3/types/perception.js';
import type { M4Context, MemorySummary } from './types/index.js';
import type { DNA } from "../m1/types/dna.js";
import type { ScoredMemory } from '../m2/types/index.js';
import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';
import { MemoryRetriever } from './MemoryRetriever.js';
import { FamilyGraph } from './household/FamilyGraph.js';
import { rerank } from './Reranker.js';
import { decompose } from './QueryDecomposer.js';

// 海马体三突触回路组件
import { PatternSeparator } from '../engine/tianquan/temporal/PatternSeparator.js';
import { PatternCompleter } from '../engine/tianquan/temporal/PatternCompleter.js';
import { HippocampalIndex } from '../engine/tianquan/temporal/HippocampalIndex.js';
import { SceneSnapshotBuilder } from '../engine/tianquan/temporal/SceneSnapshotBuilder.js';
import type { SceneSnapshot, SceneSnapshotMaterials, EmotionTrend, NoveltyLevel } from '../engine/tianquan/temporal/types.js';
import type { Perception24D } from '../m3/types/perception.js';

// P0-4: FG 摘要 30s 缓存
interface FGCacheEntry {
  familySummary: any;
  socialSummary: any;
  timestamp: number;
}
const FG_CACHE_TTL = 30_000;
let _fgCache: FGCacheEntry | null = null;
let _lastEntitySet: Set<string> = new Set();

export class M4Orchestrator {
  private memoryRetriever: MemoryRetriever;
  private familyGraph: FamilyGraph;
  /** V3.2: 户籍门阀过滤器 */
  private _gatekeeper: any = null;
  /** P0-3: 记忆检索回调（激活新引擎再巩固） */
  public _onMemoriesRetrieved: ((memories: Array<{ memoryId: string; dnaRootId: string; calciumScore: number; perception: any }>) => void) | null = null;
  /** Phase B: 最近一次检索的原始记忆（供 retrieveAsSnapshot 使用） */
  private _lastRetrieveMemories: DNA[] = [];
  /** Phase B: 最近一次检索的材料（供 retrieveAsSnapshot 使用） */
  private _lastRetrieveMaterials: { locusPath: string; entities: Array<{ name: string; type: string }>; rawInput: string } | null = null;

  constructor(storage: FusionStorageAdapter, familyGraph: FamilyGraph, knowledgeBase?: any) {
    this.memoryRetriever = new MemoryRetriever(storage, knowledgeBase);
    this.familyGraph = familyGraph;
  }

  async initialize(): Promise<void> {
    await this.familyGraph.initialize();
  }

  /** V3.2: 设置户籍门阀过滤器 */
  setGatekeeper(gatekeeper: any): void {
    this._gatekeeper = gatekeeper;
  }

  getGatekeeper(): any {
    return this._gatekeeper;
  }

  getFamilyGraph(): any {
    return this.familyGraph;
  }

  /**
   * 对 M3 决策执行完整的 M4 知识融合流程
   */
  async orchestrate(decision: M3Decision, emotionalSummaries?: ScoredMemory[]): Promise<M4Context> {
    const entities = decision.enhanced.entity_genes.map((g) => ({
      name: g.name,
      type: g.type,
    }));
    const locusPath = decision.enhanced.locus_path;

    // ── P0-3: QueryDecomposer 检索前置（分解复杂查询） ──
    const rawInput = decision.enhanced.raw_input;
    const decomposed = decompose(rawInput);
    if (decomposed.subQueries.length > 0 && decomposed.intent !== 'simple') {
      console.log(`[M4] 查询分解: ${decomposed.intent} → ${decomposed.subQueries.join(', ')}`);
    }

    // ── 1. 记忆检索 + 重排序 ──
    // 如果有分解出的子查询，作为额外实体名传入以提升关键词命中
    const enhancedEntities = decomposed.subQueries.length > 0 && decomposed.intent !== 'simple'
      ? [...entities, ...decomposed.subQueries.map(sq => ({ name: sq, type: 'event' as const }))]
      : entities;
    let memories = await this.memoryRetriever.retrieveMemories(locusPath, enhancedEntities, {
      perception: decision.enhanced.perception,
    });

    // Phase B: 缓存原始记忆（供 retrieveAsSnapshot 使用）
    this._lastRetrieveMemories = [...memories];
    this._lastRetrieveMaterials = { locusPath, entities: enhancedEntities, rawInput };

    // P0-3: 回调通知（激活新引擎记忆再巩固机制）
    if (memories.length > 0 && this._onMemoriesRetrieved) {
      try {
        this._onMemoriesRetrieved(memories.map(m => ({
          memoryId: m.branch_id,
          dnaRootId: (m as any).dna_root_id || '',
          calciumScore: m.calcium_score ?? 0,
          perception: decision.enhanced.perception,
        })));
      } catch (_) { /* 回调不阻塞主流程 */ }
    }

    // P0-2: 接入 Reranker
    if (memories.length > 1) {
      try {
        const scoredMemories: ScoredMemory[] = memories.map(m => ({
          record: {
            id: m.branch_id,
            seq_pos: m.seq_pos,
            created_at: m.created_at || '',
            raw_input: m.raw_input || '',
            calcium_score: m.calcium_score,
            calcium_level: (m.calcium_level ?? 1) as 0|1|2|3,
            effective_strength: (m as any).effective_strength ?? 1.0,
            recall_count: (m as any).recall_count ?? 0,
          } as any,
          scores: { emotional: 0, topic: 0, entity: 0, calcium: 0 },
          composite: 0,
        }));
        const reranked = rerank(scoredMemories, rawInput);
        memories = reranked.map((s: ScoredMemory) => ({
          ...memories.find(m => m.branch_id === s.record.id),
          _rerank_score: s.composite,
        } as DNA)).filter(Boolean);
      } catch (err) {
        console.warn('[M4] Reranker 失败，使用原顺序:', err);
      }
    }

    // ── 🧠 海马体三突触回路: DG → CA3 → CA1 ──
    // DG（齿状回）：模式分离 — 去重相似记忆，选出最具区分度的
    // CA3：模式补全 — 从片段线索补全缺失的上下文维度
    // CA1：输出整合 — 排优先级，返回最终记忆列表
    let hippocampalResult: {
      indexHit: boolean; dgDeduped: number; ca3CompletedDimensions: string[];
      ca3EnhancedQuery: string; finalIds: string[];
    } = { indexHit: false, dgDeduped: 0, ca3CompletedDimensions: [], ca3EnhancedQuery: '', finalIds: [] };

    if (memories.length > 0) {
      try {
        const sqlite = (this.memoryRetriever as any).storage?.getSQLite?.();
        if (sqlite) {
          const hIndex = new HippocampalIndex(sqlite);
          const separator = new PatternSeparator();
          const completer = new PatternCompleter();

          // DG: 模式分离
          const dgResult = separator.separate(memories, 5);

          // CA3: 模式补全
          const ca3Result = completer.complete(rawInput, dgResult.distinct);

          // CA1: 输出整合
          const ca1Result = hIndex.integrate(dgResult, ca3Result, false);

          hippocampalResult = {
            indexHit: ca1Result.indexHit,
            dgDeduped: ca1Result.dgDeduped,
            ca3CompletedDimensions: ca1Result.ca3CompletedDimensions,
            ca3EnhancedQuery: ca1Result.ca3EnhancedQuery,
            finalIds: ca1Result.finalIds,
          };

          // 按 CA1 输出重新排序 memories
          if (ca1Result.finalIds.length > 0) {
            const idSet = new Set(ca1Result.finalIds);
            const reordered = ca1Result.finalIds
              .map(id => memories.find(m => (m.branch_id || m.seq_pos?.toString()) === id))
              .filter(Boolean) as DNA[];
            // 追加未被 CA1 选中的但仍有价值的
            for (const m of memories) {
              if (!idSet.has(m.branch_id || m.seq_pos?.toString() || '')) {
                reordered.push(m);
              }
            }
            memories = reordered;
          }

          if (hippocampalResult.dgDeduped > 0) {
            console.log(`[M4·海马体] DG 去重 ${hippocampalResult.dgDeduped} 条 | CA3 补全 ${hippocampalResult.ca3CompletedDimensions.length} 维 | CA1 输出 ${hippocampalResult.finalIds.length} 条`);
          }
        }
      } catch (err) {
        console.warn('[M4·海马体] 三突触回路异常，降级使用 Reranker 输出:', err);
      }
    }

    try { const fg = this.familyGraph; if (fg && memories.length > 1) { for (const mem of memories) { const names = ((mem as any).fg_entity_names || "").split(",").map(function(s: string) { return s.trim(); }).filter(Boolean); let maxHeat = 0; for (var i = 0; i < names.length; i++) { try { var rows = (fg as any).query("SELECT properties FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE name = ?) OR target_id IN (SELECT id FROM nodes WHERE name = ?) LIMIT 1", [names[i], names[i]]); if (rows && rows[0]) { var ep = JSON.parse(rows[0].properties || "{}"); if ((ep._heat_score || 0) > maxHeat) maxHeat = ep._heat_score; } } catch(e) {} } if (maxHeat > 0) (mem as any)._heat_boost = Math.min(0.3, maxHeat * 0.3); } } } catch(e) {}

    const memorySummary = this.memoryRetriever.compressMemories(memories);

    // ── V3.2 门阀过滤: 记忆检索结果按白名单 UUID 过滤 ──
    if (this._gatekeeper?.isActive?.()) {
      try {
        const before = memories.length;
        memories = this._gatekeeper.filterMemories(memories);
        if (before !== memories.length) {
          // 门阀过滤了部分记忆（静默，隐私保护不打印细节）
        }
      } catch { /* 门阀失败不影响检索 */ }
    }

    // ── 2. 家族图谱 ──
    const activeFG = this.getFamilyGraph();

    // 即使实体集合不变，也要继续让 FG 吸收重复观察，避免档案提取/待确认累积被短路。
    const currentEntitySet = new Set(entities.filter(e => e.name !== '我' && e.name.length > 1).map(e => e.name));
    const hasNewEntities = [...currentEntitySet].some(e => !_lastEntitySet.has(e));
    await activeFG.integrateFromEntity(
      decision.enhanced.entity_genes,
      decision.enhanced.raw_input
    );
    _lastEntitySet = currentEntitySet;

    // P0-4b: FG 摘要 30s 缓存
    let familySummary: any, socialSummary: any;
    const now = Date.now();
    if (_fgCache && (now - _fgCache.timestamp) < FG_CACHE_TTL && !hasNewEntities) {
      familySummary = _fgCache.familySummary;
      socialSummary = _fgCache.socialSummary;
      console.log('[M4] FG 摘要缓存命中');
    } else {
      familySummary = await activeFG.getFamilySummary();
      socialSummary = await activeFG.getSocialSummary();
      _fgCache = { familySummary, socialSummary, timestamp: now };
    }

    // ── 3. 批量加载人物档案（替代 N+1） ──
    const batchProfile = (names: string[]) => {
      const result: Record<string, any> = {};
      if (names.length === 0) return result;
      for (const name of names) {
        const profile = activeFG.getPersonProfile(name);
        if (profile) result[name] = profile;
      }
      return result;
    };

    const familyProfileNames = (familySummary.members || []).map((m: any) => m.name);
    const socialProfileNames = (socialSummary.connections || []).map((c: any) => c.name);
    const allProfileNames = [...new Set([...familyProfileNames, ...socialProfileNames])];
    const profiles = batchProfile(allProfileNames);

    const enrichProfile = (name: string) => {
      const profile = profiles[name];
      return profile ? {
        appearance: profile.appearance,
        body_features: profile.body_features,
        traits: profile.traits,
        occupation: profile.occupation,
        description: profile.description,
        style: profile.style,
        personality: profile.personality,
        interests: profile.interests,
      } : {};
    };

    let familyContext = familySummary.members.map((m: any) => ({
      entity: m.name,
      relation: m.relation_to_user,
      related_entity: '我',
      ...enrichProfile(m.name),
    }));
    let socialContext = socialSummary.connections.map((c: any) => ({
      entity: c.name,
      relation: c.relation_to_user,
      related_entity: '我',
      ...enrichProfile(c.name),
    }));

    // ── V3.2 门阀过滤: FG 家族/社交成员按白名单 UUID 过滤 ──
    if (this._gatekeeper?.isActive?.()) {
      try {
        familyContext = this._gatekeeper.filterFGMembers(familyContext);
        socialContext = this._gatekeeper.filterFGMembers(socialContext);
      } catch { /* 门阀失败不阻断 */ }
    }

    // ── 4. 情感检索结果注入 ──
    if (emotionalSummaries && emotionalSummaries.length > 0) {
      const emotionalEntries = emotionalSummaries
        .map(em => ({
          time: em.record.created_at,
          summary: em.record.raw_input.substring(0, 60),
          calcium_level: em.record.calcium_level,
          dna_root_id: (em.record as any).dna_root_id || undefined,
        }))
        .sort((a, b) => a.time.localeCompare(b.time));
      memorySummary.timeline = [...emotionalEntries, ...memorySummary.timeline];
    }

    // ── 5. 检索质量指标（增强） ──
    const rerankScore = memories.length > 0
      ? Math.round(memories.reduce((s: any, m: any) => Math.max(s, m._rerank_score || 0), 0) * 100) / 100
      : 0;

    // ── 6. 输出 ──
    return {
      decision,
      memory_summary: memorySummary,
      family_context: familyContext.length > 0 ? familyContext : undefined,
      social_context: socialContext.length > 0 ? socialContext : [],
      current_time: new Date().toISOString(),
      meta: {
        has_history: memories.length > 0,
        has_family_context: familySummary.members.length > 0,
        calcium_level: decision.enhanced.calcium_level,
        dominant_action: decision.actions[0] ?? 'memorize',
      },
      retrieval_quality: {
        total_candidates: memories.length,
        avg_match_score: memories.length > 0
          ? Math.round(memories.reduce((s: number, m: DNA) => Math.max(s, m.calcium_score ?? 0), 0) / memories.length * 100) / 100
          : 0,
        strategies_used: ["locus", "keyword", "emotion", "rerank"].filter(s => s !== ""),
        rerank_top_score: rerankScore,
        has_decomposed: decomposed.subQueries.length > 0,
      },
    };
  }

  /**
   * Phase B: 场景快照封装 — 以 SceneSnapshot 格式返回检索结果。
   *
   * 在 retrieve() 之后调用，将碎片化的 M4Context + 原始记忆封装为
   * 海马体→前额叶的标准数据契约。
   *
   * 使用:
   *   const ctx = await orchestrator.retrieve(decision, entities, emotionalSummaries, locusPath);
   *   const snapshot = orchestrator.retrieveAsSnapshot(ctx, {
   *     perception: decision.enhanced.perception,
   *     sessionId,
   *     rawInput: decision.enhanced.raw_input,
   *   });
   */
  retrieveAsSnapshot(
    m4Context: M4Context,
    extra: {
      perception: Perception24D;
      sessionId: string;
      rawInput?: string;
      locationFingerprint?: string;
    },
  ): SceneSnapshot | null {
    const materials = this._lastRetrieveMaterials;
    if (!materials || this._lastRetrieveMemories.length === 0) {
      return null;
    }

    try {
      const sqlite = (this.memoryRetriever as any).storage?.getSQLite?.();
      if (!sqlite) return null;

      const builder = new SceneSnapshotBuilder(sqlite);
      const rawInput = extra.rawInput ?? materials.rawInput;

      const snapshotMaterials: SceneSnapshotMaterials = {
        memories: this._lastRetrieveMemories,
        m4Context,
        perception: extra.perception,
        sessionId: extra.sessionId,
        rawInput,
        entities: materials.entities,
        locationFingerprint: extra.locationFingerprint,
      };

      return builder.build(snapshotMaterials);
    } catch (err) {
      console.warn('[M4] retrieveAsSnapshot 失败:', err);
      return null;
    }
  }
}
