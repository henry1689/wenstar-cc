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
import { FamilyGraph } from './FamilyGraph.js';
import { rerank } from './Reranker.js';
import { decompose } from './QueryDecomposer.js';

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
  private _familyGraphOverride: any = null;
  /** P0-3: 记忆检索回调（激活新引擎再巩固） */
  public _onMemoriesRetrieved: ((memories: Array<{ memoryId: string; dnaRootId: string; calciumScore: number; perception: any }>) => void) | null = null;

  constructor(storage: FusionStorageAdapter, familyGraph?: FamilyGraph, knowledgeBase?: any) {
    this.memoryRetriever = new MemoryRetriever(storage, knowledgeBase);
    this.familyGraph = familyGraph ?? new FamilyGraph();
  }

  async initialize(): Promise<void> {
    await this.familyGraph.initialize();
  }

  setFamilyGraphOverride(override: any): void {
    this._familyGraphOverride = override;
    // 切换 FG 分支时清除缓存
    _fgCache = null;
    console.log(`[M4] ${override ? '🎭 启用FG分支覆盖' : '✅ 清除FG分支覆盖'}`);
  }

  getFamilyGraph(): any {
    return this._familyGraphOverride || this.familyGraph;
  }

  /** 📜 信息权威铁律: 获取真实FG（绕过override，用于全局查询如getRelatedPersonsN） */
  getRealFamilyGraph(): any {
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

    const memorySummary = this.memoryRetriever.compressMemories(memories);

    // ── 2. 家族图谱 ──
    const activeFG = this.getFamilyGraph();

    // P0-4: 无新增实体短路
    const currentEntitySet = new Set(entities.filter(e => e.name !== '我' && e.name.length > 1).map(e => e.name));
    const hasNewEntities = [...currentEntitySet].some(e => !_lastEntitySet.has(e));
    if (hasNewEntities || !_fgCache) {
      await activeFG.integrateFromEntity(
        decision.enhanced.entity_genes,
        decision.enhanced.raw_input
      );
      _lastEntitySet = currentEntitySet;
    } else {
      console.log('[M4] FG 无新增实体，跳过推断');
    }

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

    const familyContext = familySummary.members.map((m: any) => ({
      entity: m.name,
      relation: m.relation_to_user,
      related_entity: '我',
      ...enrichProfile(m.name),
    }));
    const socialContext = socialSummary.connections.map((c: any) => ({
      entity: c.name,
      relation: c.relation_to_user,
      related_entity: '我',
      ...enrichProfile(c.name),
    }));

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
}
