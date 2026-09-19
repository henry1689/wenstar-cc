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
// C3(2026-09-11): 实体名解析收口到 m2/EntityNameCodec（唯一事实源；兼容 JSON 历史格式）
import { parseNames } from '../m2/EntityNameCodec.js';
import type { M4Context, MemorySummary } from './types/index.js';
import type { DNA } from "../m1/types/dna.js";
import type { ScoredMemory } from '../m2/types/index.js';
import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';
import type { MultiRankResult } from './types/retrieval.js';
import { getCorrectedRelation } from './household/shared/RelationLabels.js';
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
  async orchestrate(decision: M3Decision, emotionalSummaries?: ScoredMemory[], extraPersonUuids?: string[]): Promise<M4Context> {
    // 🔴 V27批7（PAS v1）: 分段计时 —— m4 常态耗时 4.7~7.7s（占 assemble 的 60~80%），
    //   但 retrieval_log 显示 retrieveMemories 仅 457~802ms → 大头在 orchestrate 其他阶段。
    //   仅在总耗时 >800ms 时输出，避免高频噪音。
    const _t0 = Date.now();
    let _tPrev = _t0;
    const _stageLog: string[] = [];
    const _mark = (name: string): void => { const _t = Date.now(); _stageLog.push(name + "=" + (_t - _tPrev)); _tPrev = _t; };
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
    // 🆕 V10.7: 解析 person 实体的 FG UUID，供实体归属检索通道使用
    // V12.7(批2): 合并 extraPersonUuids（会晤模式由 chat.ts 注入会晤实体 UUID，
    // 保证 retrieveMemories 内 findByLocus 至少按会晤实体过滤，堵会晤绕过）。
    const basePersonUuids = entities
      .filter(e => e.type === 'person' && e.name !== '我')
      .map(e => this.familyGraph.getUUIDByName(e.name))
      .filter(Boolean) as string[];
    const personUuids = [...new Set([...basePersonUuids, ...(extraPersonUuids ?? [])])];

    _mark("decompose+uuid");
    let memories = await this.memoryRetriever.retrieveMemories(locusPath, enhancedEntities, {
      perception: decision.enhanced.perception,
      entityUuids: personUuids.length > 0 ? personUuids : undefined,
      // 🔴 2026-09-12 召回窗口修复: 显式抬升检索窗口（原为默认 5 条）。
      //   会晤实体记忆量大（实测徐诗雨 570 条），默认窗口下实体通道候选被挤出 merged
      //   → 表现为"聊过的内容再聊就不记得"。窗口随实体规模抬升，配合分层召回。
      limit: 15,
      // 🔴 2026-09-12 B1 关键词倒排召回: 透传用户当前消息，供检索层派生查询词。
      //   旧实现查询词只取「实体名 + locus 末段」，消息正文里的词（如"中秋"）根本不进集合。
      rawQuery: rawInput,
    });
    _mark("retrieve");

    // ── V3.2 门阀过滤: 必须先过滤，再进入任何压缩、缓存、回调或快照链路 ──
    if (this._gatekeeper?.isActive?.()) {
      try {
        memories = this._gatekeeper.filterMemories(memories);
      } catch {
        // 隐私门阀异常时 deny-by-default，绝不降级为未过滤记忆。
        memories = [];
        console.warn('[M4] UUID 门阀异常，已阻断本轮记忆注入');
      }
    }

    // Phase B: 只缓存通过门阀的记忆（供 retrieveAsSnapshot 使用）
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

    // 🆕 V10.0 P0-10: FG 热力加成 — 从单行拆分为可读代码块
    try {
      const fg = this.familyGraph;
      if (fg && memories.length > 1) {
        for (const mem of memories) {
          const names = parseNames((mem as any).fg_entity_names);
          let maxHeat = 0;
          for (let i = 0; i < names.length; i++) {
            try {
              const rows = (fg as any).query(
                "SELECT properties FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE name = ?) OR target_id IN (SELECT id FROM nodes WHERE name = ?) LIMIT 1",
                [names[i], names[i]]
              );
              if (rows && rows[0]) {
                const ep = JSON.parse(rows[0].properties || '{}');
                const heat = ep._heat_score || 0;
                if (heat > maxHeat) maxHeat = heat;
              }
            } catch (e) {
              // 单条边查询失败不阻塞其他
            }
          }
          if (maxHeat > 0) {
            (mem as any)._heat_boost = Math.min(0.3, maxHeat * 0.3);
          }
        }
      }
    } catch (e) {
      console.warn('[M4·FG热力] 加成计算失败:', (e as Error)?.message || e);
    }

    const memorySummary = this.memoryRetriever.compressMemories(memories);

    // ── 2. 家族图谱 ──
    const activeFG = this.getFamilyGraph();

    // 即使实体集合不变，也要继续让 FG 吸收重复观察，避免档案提取/待确认累积被短路。
    const currentEntitySet = new Set(entities.filter(e => e.name !== '我' && e.name.length > 1).map(e => e.name));
    const hasNewEntities = [...currentEntitySet].some(e => !_lastEntitySet.has(e));
    await activeFG.integrateFromEntity(
      decision.enhanced.entity_genes,
      decision.enhanced.raw_input
    );
    _mark("integrateFG");
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
    _mark("fgSummary");
    }

    // ── 3. 批量加载人物档案（替代 N+1） ──
    const batchProfile = (names: string[]) => {
      const result: Record<string, any> = {};
      if (names.length === 0) return result;
      const _slow: string[] = [];
      for (const name of names) {
        const _tP = Date.now();
        // 🔴 V27批7: 一次节点查询同时产出 profile + bio ——
        //   原实现此处调 getPersonProfile，enrichProfile 内又调 getPersonBio，
        //   两者各走一次 findPersonNodeByNameOrAlias（含 aliases LIKE 全表扫描），
        //   使档案加载变成 2N 次查询。
    //   ⚠️ 归因修正（独立评审 P2-2）：实测每档案均耗时不变（13~20ms），
    //   本批的真实增益来自**限量加载**（339→60），合并读取的贡献未获数据证实。
        const r = (activeFG as any).getPersonProfileWithBio?.(name);
        if (r?.profile) {
          result[name] = { ...r.profile, __bio: r.bio };
        } else {
          const profile = activeFG.getPersonProfile(name);
          if (profile) result[name] = profile;
        }
        const _dtP = Date.now() - _tP;
        if (_dtP > 30) _slow.push(name + ":" + _dtP + "ms");
      }
      if (_slow.length > 0) console.log("[M4·profile] " + names.length + "个档案，慢项: " + _slow.slice(0, 8).join(" "));
      return result;
    };

    const familyProfileNames = (familySummary.members || []).map((m: any) => m.name);
    const socialProfileNames = (socialSummary.connections || []).map((c: any) => c.name);
    const allProfileNames = [...new Set([...familyProfileNames, ...socialProfileNames])];
    // 🔴 V27批7: **限量加载档案** —— 实测 allProfileNames 达 **339 个**，且含大量
    //   实体识别噪音碎片（"马上/干净/后我/段时间/家子"等），逐个节点查询使
    //   batchProfile 耗时 4551~6660ms（占 m4 的 50~85%，是常态最大头）。
    //   同时 339 份档案全量注入 prompt 本身也超出任何 token 预算。
    //   策略：保序截断（家人先于熟人），被截断者的档案细节省略但不影响实体/关系字段。
    const MAX_PROFILE_LOAD = 60;
    // 🔴 V27批7（评审 P1-1）: **家人块永不截断** ——
    //   家人块内混有被误挂家族边的噪音碎片（实测「马上」「秋节快」确有家族边），
    //   单纯「保序截断」会让噪音占名额、把真家人挤到 60 之后 →
    //   chat.ts 只渲染 family_context 的档案字段，缺字段时 LLM 被要求答「不知道」
    //   = 不残缺回归。故：家人全量加载，只截断熟人块；家人超限时告警（P-13）。
    const _familyNames = [...new Set(familyProfileNames)];
    const _socialOnly = socialProfileNames.filter((n: string) => !_familyNames.includes(n));
    const _socialCap = Math.max(0, MAX_PROFILE_LOAD - _familyNames.length);
    const _namesToLoad = [..._familyNames, ..._socialOnly.slice(0, _socialCap)];
    if (_familyNames.length > MAX_PROFILE_LOAD) {
      console.warn("[M4·profile] 🔴 家人数(" + _familyNames.length + ") 超加载上限 " + MAX_PROFILE_LOAD
        + "，已全量加载家人（需人工核查 FG 噪音实体）");
    } else if (_socialOnly.length > _socialCap) {
      console.log("[M4·profile] 档案加载限量: 家人 " + _familyNames.length + " 全量 + 熟人 "
        + _socialCap + "/" + _socialOnly.length);
    }
    const profiles = batchProfile(_namesToLoad);
    _mark("batchProfile");

    const enrichProfile = (name: string) => {
      const profile = profiles[name];
      if (!profile) return {};
      // 🔴 补 birthYear/age：此前 enrichProfile 拿到完整 profile 却不含出生年，
      //     导致普通模式 familyConstraint / cognition.family 全链路无年龄。
      //     用归一化读取器 getPersonBio（dossier 优先+顶层兜底），occupation 也从 bio 取。
      // 🔴 V27批7: 复用 batchProfile 已取到的 bio（不再重复查库）
      const bio = (profile as any).__bio ?? activeFG.getPersonBio?.(name);
      return {
        appearance: profile.appearance,
        body_features: profile.body_features,
        traits: profile.traits,
        occupation: bio?.occupation ?? profile.occupation,
        description: profile.description,
        style: profile.style,
        personality: profile.personality,
        interests: profile.interests,
        birthYear: bio?.birthYear ?? null,
        age: bio?.age ?? null,
      };
    };

    let familyContext = familySummary.members.map((m: any) => ({
      entity: m.name,
      relation: getCorrectedRelation(m.name, m.relation_to_user),
      related_entity: '我',
      ...enrichProfile(m.name),
    }));
    let socialContext = socialSummary.connections.map((c: any) => ({
      entity: c.name,
      relation: getCorrectedRelation(c.name, c.relation_to_user),
      related_entity: '我',
      ...enrichProfile(c.name),
    }));
    _mark("socialCtx");

    // ── V3.2 门阀过滤: FG 家族/社交成员按白名单 UUID 过滤 ──
    if (this._gatekeeper?.isActive?.()) {
      try {
        // 🔴 V27批8: 先批量预填 name→UUID 缓存，再过滤 —— filterFGMembers 处理的是
        //   **全量**成员（不像 batchProfile 限 60），首次逐名查询实测 1964~3305ms。
        //   预填只填缓存、不做判定，隐私语义不变。
        try {
          const _allNames = [...new Set([...familyContext.map((x: any) => x.entity), ...socialContext.map((x: any) => x.entity)])];
          (this._gatekeeper as any).prefillNameToUUID?.(_allNames);
        } catch { /* 预填失败回退逐名 */ }
        _mark("prefill");
        familyContext = this._gatekeeper.filterFGMembers(familyContext);
        _mark("filterFamily");
        socialContext = this._gatekeeper.filterFGMembers(socialContext);
      } catch {
        // FG 隐私过滤同样 fail-closed，避免异常时回填未过滤成员。
        familyContext = [];
        socialContext = [];
        console.warn('[M4] FG 门阀异常，已阻断本轮人物上下文注入');
      }
    }
    _mark("filterFG");

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
    _mark("rest");
    const _m4Total = Date.now() - _t0;
    if (_m4Total > 800) console.log("[M4·timing] total=" + _m4Total + "ms | " + _stageLog.join(" "));

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

  /** V13: 为七层检索管线提供五路独立排名结果 */
  async retrieveMultiRankForSearch(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    opts?: { perception?: Perception24D; entityUuids?: string[]; sessionId?: string },
  ): Promise<MultiRankResult> {
    return this.memoryRetriever.retrieveMultiRank(locusPath, entities, opts);
  }

  /** V13: 获取底层 SQLite 实例供 DAG 闭包检索使用 */
  getSQLite(): any {
    return (this.memoryRetriever as any).storage?.getSQLite?.();
  }
}
