// MemoryRetriever — 从 M2 检索历史记忆 + 上下文压缩
// Ref: M4-design-v1.md §4
//
// v2: 新增会话级缓存（P1-2）+ 双输出接口（P2-3）

import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';
import type { KnowledgeBase } from '../m2/KnowledgeBase.js';
import type { DNA } from '../m1/types/dna.js';
import type { Perception24D } from '../m3/types/perception.js';
import type { MemorySummary } from './types/index.js';
import { RETRIEVAL_THRESHOLDS, BATCH_SIZES, MIN_MATCHED_FOR_BREAK } from '../m2/retrieval-constants.js';
import { LocalCache } from '../app/tools/LocalCache.js';
import { HippocampalIndex } from '../engine/tianquan/temporal/HippocampalIndex.js';
import { SURNAME_CHARS } from '../config/app-identity.js';
import type { MultiRankResult, RankedList, RankedItem } from './types/retrieval.js';

// 关键词检索缓存：相同关键词 30 秒内复用结果
const keywordCache = new LocalCache<string, DNA[]>({ ttlMs: 30_000, namespace: 'm4_keyword' });

// P1-2: 会话级缓存 — 同一会话相同 locus 复用检索结果
const sessionCache = new LocalCache<string, DNA[]>({ ttlMs: 300_000, namespace: 'm4_session' });

// P2-3: 结构化记忆条目（含完整的时空/关系/情感元数据）
export interface StructuredMemoryItem {
  id: string;
  seq_pos: number;
  created_at: string;
  raw_input: string;
  calcium_score: number;
  calcium_level: number;
  effective_strength: number;
  recall_count: number;
  primary_emotion?: string;
  entity_names: string[];
  fg_entity_names?: string;
  time_period?: string;
  season?: string;
  lunar_term?: string;
  score: number;
}

export class MemoryRetriever {
  private storage: FusionStorageAdapter;
  private knowledgeBase: KnowledgeBase | null = null;
  // P1-2: 当前会话ID，由上层每轮注入
  private _sessionId: string = '';

  constructor(storage: FusionStorageAdapter, knowledgeBase?: KnowledgeBase) {
    this.knowledgeBase = knowledgeBase ?? null;
    this.storage = storage;
  }

  /** P1-2: 由上层（chat.ts/orchestrator）每轮注入当前会话ID */
  setSessionId(sessionId: string): void {
    this._sessionId = sessionId;
  }

  /** P1-2: 会话结束时调用，清理缓存 */
  clearSessionCache(): void {
    this._sessionId = '';
    // 不清除全局 keywordCache，只清除对话级别的 sessionCache 条目
    // 由 LocalCache 的 TTL 自动过期
  }

  /**
   * 根据 M3 决策检索相关历史记忆
   *
   * v2: 新增会话级缓存（P1-2），同一会话中相同 locus_path 复用检索结果
   */
  async retrieveMemories(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    options?: { limit?: number; perception?: Perception24D; sessionId?: string; entityUuids?: string[]; isBackgroundTask?: boolean }
  ): Promise<DNA[]> {
    const limit = options?.limit ?? 5;
    const startTs = Date.now();
    const sessionId = options?.sessionId ?? this._sessionId;

    // P1-2: 会话级缓存检查
    if (sessionId && locusPath) {
      const cacheKey = `session:${sessionId}:${locusPath}`;
      const cached = await sessionCache.get(cacheKey);
      if (cached && cached.length > 0) {
        return cached.slice(0, limit);
      }
    }

    // ─── 🧠 0. 海马体稀疏索引查询（先查索引，再扫库）───
    let indexHit = false;
    let indexedIds: string[] = [];
    try {
      const sqlite = (this.storage as any).getSQLite?.();
      if (sqlite && options?.perception) {
        const hIndex = new HippocampalIndex(sqlite);
        const sig = hIndex.computeSignature(locusPath, entities, options.perception);
        const locs = hIndex.lookup(sig);
        if (locs && locs.length > 0) {
          indexHit = true;
          indexedIds = locs;
          // 如果经验摘要已存在（δ 节律归纳后回写），直接注入上下文
          // 此处仅记录命中状态，经验摘要由 M4Orchestrator 处理
        }
      }
    } catch { /* 索引查询失败不阻塞 */ }

    // ─── 1. 按话题前缀检索（基于分类树路由） ───
    // V12.7(批2): 补 entityUuids 透传 — 会晤模式下 M4Orchestrator 已传 entityUuids，
    // 此处未透传 → findByLocus 跨实体全库扫描，他人同话题记忆经 timeline 注入 LLM（会晤绕过）。
    const byLocus = await this.storage.findByLocus(locusPath, { limit: 20, entityUuids: options?.entityUuids });

    // ─── 2. 关键词全文搜索 ───
    const byKeyword: DNA[] = [];
    const keywords = new Set<string>();

    for (const e of entities) {
      if (e.name && e.name.length > 0) keywords.add(e.name);
    }
    if (locusPath) {
      const segments = locusPath.split('.');
      const last = segments[segments.length - 1];
      if (last && last !== 'default' && last !== 'general') keywords.add(last);
    }

    // 🆕 P1-4 检索兜底: entity_genes 为空时，从 entities 提取人名作为关键词
    // 根因：历史记忆在滑窗检测修复前创建，entity_genes=[] 导致关键词检索失效
    if (keywords.size === 0) {
      for (const e of entities) {
        if (e.name) keywords.add(e.name);
      }
      // 如果 entities 也为空，跳过关键词检索（由 emotion/spine/locus 承担）
      if (keywords.size === 0) {
        console.log('[M4] 检索兜底: keywords 为空，跳过关键词检索');
      }
    }

    if (keywords.size > 0) {
      try {
        // 🔴 P2-A11 修复: cacheKey 追加 entityUuids，防跨实体缓存污染
        const cacheKey = [...keywords].sort().join("::") + '|' + (options?.entityUuids?.slice().sort().join(',') || '');
        const _cached = await keywordCache.get(cacheKey);
        if (_cached) { byKeyword.push(..._cached); }
        else {
          const recent = await this.storage.findBySeqPosRange(0, 999_999_999, { limit: 200, entityUuids: options?.entityUuids });
          const seen = new Set<string>();
          for (const dna of recent) {
            for (const kw of keywords) {
              if (dna.raw_input.includes(kw) && !seen.has(dna.branch_id)) {
                seen.add(dna.branch_id);
                byKeyword.push(dna);
                break;
              }
            }
          }
        }
      } catch (err) {
        console.warn("[M4] 检索失败:", err);
      }
    }

    // ─── 3. 情感相似度检索 ───
    const hasEmotionType = entities.some(e => e.type === 'emotion');
    const hasMeaningfulEntity = entities.some(e => e.name.length > 0 && e.type !== 'self');
    const shouldEmotionSearch = options?.perception !== undefined && (hasEmotionType || hasMeaningfulEntity);
    const byEmotion: DNA[] = [];
    if (shouldEmotionSearch && options?.perception) {
      try {
        const scored = this.storage.findByEmotionalSimilarity({
          current_perception: options?.perception!,
          entities: entities.filter(e => e.type === 'emotion').map(e => e.name),
          similarity_mode: 'mood_congruent',
          limit: 10,
          entityUuids: options?.entityUuids,  // 第3期: 隔离靠 entityUuids
        });
        for (const sm of scored) {
          if (sm?.record) {
            byEmotion.push({
              branch_id: sm.record.id,
              locus_path: sm.record.locus_path ?? '',
              taxonomy_version: '1.0',
              seq_pos: sm.record.seq_pos ?? 0,
              leaf_zone: (sm.record as any).leaf_zone ?? 'language_semantic_zone',
              ref: '',
              entity_genes: (sm.record as any).entity_genes ?? [],
              raw_input: sm.record.raw_input ?? '',
              created_at: sm.record.created_at ?? '',
              calcium_score: sm.record.calcium_score,
              calcium_level: sm.record.calcium_level,
              // 携带检索隔离字段，供合并时按规则过滤
              memory_kind: sm.record.memory_kind,
              memory_type: (sm.record as any).memory_type,
            } as any);
          }
        }
      } catch (err) {
        console.warn('[M4] 情感检索失败:', err);
      }
    }

    // 🔥 3.5 双螺旋 state_spines 检索：从语义向量分片库直接读取候选
    // 🔴 P2-A2 修复: state_spines 无实体维度，会晤场景（有 entityUuids）跳过（防全库向量泄漏）
    const bySpine: DNA[] = [];
    if (options?.perception && (options.entityUuids?.length ?? 0) === 0) {
      try {
        const sqlite = (this.storage as any).getSQLite?.();
        if (sqlite && typeof sqlite.queryAll === 'function') {
          const p = options.perception;
          const spineRows = sqlite.queryAll(
            `SELECT s.global_uid, s.dimension_id, s.value, s.timestamp_ms
             FROM state_spines s
             WHERE s.dimension_id IN (1, 2, 5, 13)
               AND s.timestamp_ms > ?
             ORDER BY s.timestamp_ms DESC LIMIT 200`,
            [Date.now() - 30 * 86400000]
          );
          if (spineRows && spineRows.length > 0) {
            const spineMap = new Map<string, { dims: Map<number, number>; ts: number }>();
            for (const row of spineRows) {
              const uid = row.global_uid as string;
              if (!spineMap.has(uid)) spineMap.set(uid, { dims: new Map(), ts: row.timestamp_ms as number });
              const entry = spineMap.get(uid)!;
              entry.dims.set(row.dimension_id as number, row.value as number);
            }
            const targetDims = [p.pleasure ?? 0, p.arousal ?? 0, p.intimacy ?? 0, p.intimacy ?? 0];
            for (const [uid, entry] of spineMap) {
              const vec: number[] = [
                entry.dims.get(1) ?? 0.5,
                entry.dims.get(2) ?? 0.5,
                entry.dims.get(5) ?? 0.5,
                entry.dims.get(13) ?? 0.5,
              ];
              let dot = 0, nA = 0, nB = 0;
              for (let i = 0; i < 4; i++) { dot += vec[i] * targetDims[i]; nA += vec[i] * vec[i]; nB += targetDims[i] * targetDims[i]; }
              const sim = nA && nB ? (dot / (Math.sqrt(nA) * Math.sqrt(nB)) + 1) / 2 : 0.5;
              if (sim > 0.3) {
                bySpine.push({
                  branch_id: uid, locus_path: '', taxonomy_version: '1.0',
                  seq_pos: 0, leaf_zone: 'language_semantic_zone', ref: '',
                  entity_genes: [], raw_input: '', created_at: new Date(entry.ts).toISOString(),
                  calcium_score: sim * 10, calcium_level: Math.min(3, Math.floor(sim / 0.25)),
                } as any);
              }
            }
            if (bySpine.length > 0) {
              console.log('[M4-DualHelix] state_spines: ' + bySpine.length + ' candidates');
            }
          }
        }
      } catch (err) {
        console.warn('[M4-DualHelix] 检索失败:', err);
      }
    }

    // 4. 🆕 实体归属检索（belong_entity_uuid 直查，不依赖 memory_kind）
    const byEntityUuid: DNA[] = [];
    const entityUuids = options?.entityUuids || [];
    if (entityUuids.length > 0 && typeof this.storage.findByEntityUuid === 'function') {
      for (const uuid of entityUuids) {
        try {
          const entityMems = this.storage.findByEntityUuid(uuid, 10);
          if (entityMems && entityMems.length > 0) {
            for (const em of entityMems) {
              byEntityUuid.push({
                branch_id: em.id,
                locus_path: em.locus_path ?? '',
                taxonomy_version: '1.0',
                seq_pos: em.seq_pos ?? 0,
                leaf_zone: (em as any).leaf_zone ?? 'language_semantic_zone',
                ref: '',
                entity_genes: [],
                raw_input: em.raw_input ?? '',
                created_at: em.created_at ?? '',
                calcium_score: em.calcium_score,
                calcium_level: em.calcium_level,
                memory_kind: (em as any).memory_kind,
                memory_type: (em as any).memory_type,
              } as any);
            }
          }
        } catch { /* 单条检索失败不阻塞 */ }
      }
    }

    // 5. 合并去重（加入 bySpine 源）
    const seen = new Set<string>();
    let merged: DNA[] = [];
    for (const dna of [...byEmotion, ...byKeyword, ...bySpine, ...byLocus]) {
      if (!seen.has(dna.branch_id) && merged.length < limit) {
        seen.add(dna.branch_id);
        merged.push(dna);
      }
    }

    // 5. 检索规则：正常模式排除角色扮演记忆（memory_kind='roleplay' 或 memory_type='rp_dialog'）
    const _filtered = merged.filter(dna => {
      // V12.7(批1): memory_kind 已由 toDNA 回填（此前恒 undefined 死过滤）；
      // memory_type 从未被 rowToRecord 回填 → 删死判定，统一用 memory_kind。
      if (options?.isBackgroundTask && dna.memory_kind === 'roleplay') return false;
      return true;
    });
    if (_filtered.length < merged.length) {
      console.log(`[M4] 正常检索过滤 ${merged.length - _filtered.length} 条角色扮演记忆`);
      merged.length = 0;
      merged.push(..._filtered);
    }

    // 🆕 实体归属检索追加 — 绕过 memory_kind 过滤，按 UUID 直达
    //    S4 P0-2 修复: 跳过 roleplay（memory_type 从未被 rowToRecord/DNA 回填 → 死过滤），
    //    改用 memory_kind === 'roleplay'（byEntityUuid 构造时 L259 已回填）。
    if (byEntityUuid.length > 0) {
      for (const dna of byEntityUuid) {
        if (!seen.has(dna.branch_id)) {
          if (options?.isBackgroundTask && dna.memory_kind === 'roleplay') continue;
          seen.add(dna.branch_id);
          merged.push(dna);
        }
      }
    }

    // 6. 知识库补充
    if (merged.length < limit * 0.5 && this.knowledgeBase && options?.perception) {
      try {
        const sceneTags = locusPath ? locusPath.split('.').filter(Boolean) : [];
        const entityKws = entities.filter(function(e) { return e.name.length > 0 && e.type !== 'self'; }).map(function(e) { return e.name; });
        const kbKeywords = [...entityKws, locusPath.split('.').pop() || ''].filter(Boolean).join(' ');
        if (kbKeywords.length > 2) {
          // 🔴 户籍管理法（第九条 搜索闸门）: 知识库检索按当前会晤实体 UUID 过滤，
          // 杜绝"梓铭简介"（belong=梓铭）泄漏给徐诗雨。无归属(公共)资料可放行。
          const _kbUuid = options?.entityUuids?.[0] ?? undefined;
          const kbResults = await this.knowledgeBase.weightedSearch(kbKeywords, sceneTags, {
            pleasure: options.perception.pleasure,
            arousal: options.perception.arousal,
            intimacy: options.perception.intimacy,
          }, limit - merged.length, _kbUuid);
          for (const kb of kbResults) {
            if (!seen.has('kb_' + kb.id)) {
              seen.add('kb_' + kb.id);
              merged.push({
                branch_id: 'kb_' + kb.id,
                locus_path: 'knowledge.' + (kb.classification || 'general'),
                taxonomy_version: '1.0',
                seq_pos: 0,
                leaf_zone: 'language_semantic_zone',
                ref: 'kb_' + kb.id,
                entity_genes: [],
                raw_input: kb.title + '：' + (kb.content || '').substring(0, 60),
                created_at: kb.created_at,
                calcium_score: 0,
                calcium_level: 0,
              } as DNA);
            }
          }
        }
      } catch (err) {
        console.warn('[M4] 知识库检索失败:', err);
      }
    }

    // ── 五级闸门: 不可绕过, 不可关闭 (蓝皮书 §4.1, 白皮书 §5.1) ──
    if (merged.length > 0) {
      try {
        const { getFiveStageGate } = await import('../m3/FiveStageGate.js');
        const gate = getFiveStageGate();
        const gated = gate.filter(
          merged.map(d => ({
            id: d.branch_id,
            dna_root_id: (d as any).dna_root_id,
            raw_input: d.raw_input,
            calcium_score: (d as any).calcium_score ?? 0,
            calcium_level: (d as any).calcium_level ?? 0,
            effective_strength: (d as any).effective_strength ?? 1,
            location_fingerprint: (d as any).location_fingerprint ?? '',
            locus_path: d.locus_path,
            leaf_zone: d.leaf_zone,
            absolute_timestamp: (d as any).absolute_timestamp ?? (d.created_at ? new Date(d.created_at).getTime() : Date.now()),
            is_landmark: (d as any).is_landmark ?? 0,
          })),
          {
            query: locusPath,
            locationFingerprint: (options?.perception as any)?.location_fingerprint ?? '',
          },
        );
        // 按闸门排序重建·保留 dnas 中对应的 DNA 对象
        const gatedSet = new Set(gated.passed.map(m => m.id));
        merged = merged.filter(d => gatedSet.has(d.branch_id));
      } catch (_e) {
        // 闸门加载失败不阻断检索, 仅告警
        console.warn('[FiveStageGate] 加载失败, 跳过闸门过滤:', (_e as Error).message);
      }
    }

    // P1-2: 写入会话缓存
    if (sessionId && locusPath && merged.length > 0) {
      const cacheKey = `session:${sessionId}:${locusPath}`;
      sessionCache.set(cacheKey, merged).catch(() => {});
    }

    // 🧠 海马体索引: 命中时优先排序 / 未命中时回写索引
    if (indexHit && indexedIds.length > 0) {
      // 索引命中的记忆排到最前面
      const idSet = new Set(indexedIds);
      const indexed: DNA[] = [];
      const others: DNA[] = [];
      for (const d of merged) {
        (idSet.has(d.branch_id) ? indexed : others).push(d);
      }
      merged = [...indexed, ...others];
    } else if (!indexHit && merged.length > 0) {
      // 未命中 → 写入索引，下次就能走快通道
      try {
        const sqlite = (this.storage as any).getSQLite?.();
        if (sqlite && options?.perception) {
          const hIndex = new HippocampalIndex(sqlite);
          const sig = hIndex.computeSignature(locusPath, entities, options.perception);
          hIndex.store(sig, merged.slice(0, 5).map(d => d.branch_id));
        }
      } catch { /* 索引写入失败不阻塞 */ }
    }

    // 🧠 V3.1 记忆再巩固: 检索后异步更新元数据（同session去重，只改元数据不篡改内容）
    if (merged.length > 0) {
      setImmediate(() => this._reconsolidateAsync(merged, options?.perception));
    }

    // V4.0 Phase 5: 检索策略质量日志 — 积累数据供离线A/B分析
    try {
      const _logSqlite = (this.storage as any).getSQLite?.();
      if (_logSqlite) {
        const _latency = Date.now() - startTs;
        _logSqlite.writeRaw(
          `INSERT INTO retrieval_log (strategy, locus_path, latency_ms, result_count, entity_count, hit_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ['retrieveMemories', locusPath, _latency, merged.length, entities.length, indexHit ? 1 : 0, new Date().toISOString()]
        );
      }
    } catch (e) { /* 日志不可用不影响主流程 */ }

    return merged;
  }

  /**
   * V12.0 四路独立召回 — 返回 MultiRankResult 而非合并的 DNA[]
   * ==========================================================
   * 把 retrieveMemories 中散落的四路召回逻辑抽取为统一返回接口。
   * 四路各自输出 RankedList（路内已按 score 降序），由上层 UnifiedSearchEngine
   * 做 RRF 融合 + MMR 多样性，不再在 MemoryRetriever 内部拼接。
   *
   * @returns 四路独立排名 + 海马体索引命中信息
   */
  /**
   * V12.0 六路独立召回（并行化 V12.6） — 返回 MultiRankResult 而非合并的 DNA[]
   * ==========================================================
   * 把 retrieveMemories 中散落的六路召回逻辑抽取为统一返回接口。
   * 六路各自输出 RankedList（路内已按 score 降序），由上层 UnifiedSearchEngine
   * 做 RRF 融合 + MMR 多样性，不再在 MemoryRetriever 内部拼接。
   *
   * V12.6 改造：六路 Promise.all 并行执行（结构收益，为未来异步存储铺路）。
   *  🔴 不剪枝：keyword/spine 的 200 条候选窗口原样保留（改动会改变召回范围，不混入）。
   *  🔴 不改返回结构 MultiRankResult（V13 searchV13 / MemoryAdapter 消费不变）。
   *  🔴 不改 findBySeqPosRange 公共方法（M8/M7/图构建器复用，只在本方法内传参）。
   *
   * @returns 六路独立排名 + 海马体索引命中信息
   */
  async retrieveMultiRank(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    options?: { perception?: Perception24D; entityUuids?: string[]; sessionId?: string; isBackgroundTask?: boolean }
  ): Promise<MultiRankResult> {
    const sessionId = options?.sessionId ?? this._sessionId;
    const lists: RankedList[] = [];

    // ─── 0. 共享关键词集合（keyword 路 + work 路共用，提取到顶部消除耦合） ───
    const keywords = new Set<string>();
    for (const e of entities) {
      if (e.name && e.name.length > 0) keywords.add(e.name);
    }
    if (locusPath) {
      const last = locusPath.split('.').pop();
      if (last && last !== 'default' && last !== 'general') keywords.add(last);
    }

    // ─── 🧠 0b. 海马体稀疏索引查询（保持串行，检索起点依赖） ───
    let indexHit = false;
    let indexedIds: string[] = [];
    try {
      const sqlite = (this.storage as any).getSQLite?.();
      if (sqlite && options?.perception) {
        const hIndex = new HippocampalIndex(sqlite);
        const sig = hIndex.computeSignature(locusPath, entities, options.perception);
        const locs = hIndex.lookup(sig);
        if (locs && locs.length > 0) {
          indexHit = true;
          indexedIds = locs;
        }
      }
    } catch { /* 索引查询失败不阻塞 */ }

    // ─── 六路并行召回（V12.6 Promise.all） ───
    // 原串行 6 路各自包成独立 async 函数（自带 try-catch 隔离，异常不阻塞其他路），
    // Promise.all 并行执行。结果按固定顺序 [emotion, keyword, spine, locus, entity, work]
    // 合并 → 保持下游 V13 RRF 对 lists 顺序的稳定依赖。
    // 🔴 每路守卫条件原样保留（emotion 需 perception、spine 会晤跳过、entity 需 uuid、work 需关键词）。
    // 🔴 不剪枝：keyword/spine 的 200 条候选窗口原样保留（改动会改变召回范围）。
    const entityUuids = options?.entityUuids ?? [];

    // 1. 情感/情绪路 (emotion)
    const runEmotion = async (): Promise<RankedItem[]> => {
      const items: RankedItem[] = [];
      const hasEmotionType = entities.some(e => e.type === 'emotion');
      const hasMeaningfulEntity = entities.some(e => e.name.length > 0 && e.type !== 'self');
      if (options?.perception && (hasEmotionType || hasMeaningfulEntity)) {
        try {
          const scored = this.storage.findByEmotionalSimilarity({
            current_perception: options.perception,
            entities: entities.filter(e => e.type === 'emotion').map(e => e.name),
            similarity_mode: 'mood_congruent',
            limit: 30,
            entityUuids: options?.entityUuids,
          });
          for (const sm of scored) {
            if (sm?.record) {
              items.push({
                id: sm.record.id ?? '',
                text: (sm.record.raw_input ?? '').substring(0, 200),
                score: sm.composite ?? sm.scores.emotional ?? 0.5,
                source: 'emotion',
                entityUuid: sm.record?.belongEntityUuid ?? null,
                calciumScore: sm.record.calcium_score ?? 0,
                createdAt: sm.record.created_at ?? '',
              });
            }
          }
        } catch { /* skip */ }
      }
      items.sort((a, b) => b.score - a.score);
      return items;
    };

    // 2. 关键词/BM25路 (keyword)
    const runKeyword = async (): Promise<RankedItem[]> => {
      const items: RankedItem[] = [];
      if (keywords.size > 0) {
        try {
          const recent = await this.storage.findBySeqPosRange(0, 999_999_999, { limit: 200, entityUuids: options?.entityUuids });
          const seen = new Set<string>();
          for (const dna of recent) {
            if (seen.has(dna.branch_id)) continue;
            const kind = dna.memory_kind;
            if (options?.isBackgroundTask && kind === 'roleplay') continue;
            let hitCount = 0;
            for (const kw of keywords) {
              if (dna.raw_input?.includes(kw)) hitCount++;
            }
            if (hitCount > 0) {
              seen.add(dna.branch_id);
              items.push({
                id: dna.branch_id,
                text: (dna.raw_input ?? '').substring(0, 200),
                score: hitCount,
                source: 'keyword',
                entityUuid: dna.belong_entity_uuid ?? null,
                calciumScore: dna.calcium_score ?? 0,
                createdAt: dna.created_at ?? '',
              });
            }
          }
        } catch { /* skip */ }
      }
      items.sort((a, b) => b.score - a.score);
      return items;
    };

    // 3. 双螺旋 state_spines 向量路 (spine)
    // 🔴 P2-A2 修复: state_spines 表无 belong_entity_uuid 列，global_uid 与 memories 无法关联，
    //   检索出的 spine 候选无法回溯到具体实体（天然"无归属"）。
    //   会晤场景（有 entityUuids）下跳过 spine 路——否则会把全库情绪向量注入（违反 UUID 法 deny-by-default）。
    //   户主场景（无 entityUuids）下保留（户主最高权限，spine 作为辅助信号）。
    const runSpine = async (): Promise<RankedItem[]> => {
      const items: RankedItem[] = [];
      if (options?.perception && entityUuids.length === 0) {
        try {
          const sqlite = (this.storage as any).getSQLite?.();
          if (sqlite && typeof sqlite.queryAll === 'function') {
            const p = options.perception;
            const spineRows = sqlite.queryAll(
              `SELECT s.global_uid, s.dimension_id, s.value, s.timestamp_ms
               FROM state_spines s WHERE s.dimension_id IN (1,2,5,13)
                 AND s.timestamp_ms > ? ORDER BY s.timestamp_ms DESC LIMIT 200`,
              [Date.now() - 30 * 86400000]
            );
            if (spineRows?.length) {
              const spineMap = new Map<string, { dims: Map<number,number>; ts: number }>();
              for (const row of spineRows) {
                const uid = row.global_uid as string;
                if (!spineMap.has(uid)) spineMap.set(uid, { dims: new Map(), ts: row.timestamp_ms as number });
                spineMap.get(uid)!.dims.set(row.dimension_id as number, row.value as number);
              }
              const targetDims = [p.pleasure ?? 0, p.arousal ?? 0, p.intimacy ?? 0, p.intimacy ?? 0];
              for (const [uid, entry] of spineMap) {
                const vec = [entry.dims.get(1) ?? 0.5, entry.dims.get(2) ?? 0.5, entry.dims.get(5) ?? 0.5, entry.dims.get(13) ?? 0.5];
                let dot = 0, nA = 0, nB = 0;
                for (let i = 0; i < 4; i++) { dot += vec[i] * targetDims[i]; nA += vec[i] * vec[i]; nB += targetDims[i] * targetDims[i]; }
                const sim = nA && nB ? (dot / Math.sqrt(nA * nB) + 1) / 2 : 0.5;
                if (sim > 0.3) {
                  items.push({
                    id: uid, text: '', source: 'spine', entityUuid: null,
                    score: sim, calciumScore: sim * 10, createdAt: new Date(entry.ts).toISOString(),
                  });
                }
              }
            }
          }
        } catch { /* skip */ }
      }
      items.sort((a, b) => b.score - a.score);
      return items;
    };

    // 4. 话题前缀路 (locus)
    const runLocus = async (): Promise<RankedItem[]> => {
      const items: RankedItem[] = [];
      try {
        const byLocus = await this.storage.findByLocus(locusPath, { limit: 20, entityUuids: options?.entityUuids });
        for (const dna of byLocus) {
          const kind = dna.memory_kind;
          if (options?.isBackgroundTask && kind === 'roleplay') continue;
          items.push({
            id: dna.branch_id,
            text: (dna.raw_input ?? '').substring(0, 200),
            score: dna.seq_pos ?? 0,
            source: 'locus',
            entityUuid: dna.belong_entity_uuid ?? null,
            calciumScore: dna.calcium_score ?? 0,
            createdAt: dna.created_at ?? '',
          });
        }
      } catch { /* skip */ }
      items.sort((a, b) => b.score - a.score);
      return items;
    };

    // 5. 实体归属路 (entity)
    const runEntity = async (): Promise<RankedItem[]> => {
      const items: RankedItem[] = [];
      // V12.6: FusionStorageAdapter.findByEntityUuid 透传补齐（原 only-SQLiteAdapter → 恒 false 空转）
      if (entityUuids.length > 0 && typeof this.storage.findByEntityUuid === 'function') {
        for (const uuid of entityUuids) {
          try {
            const entityMems = this.storage.findByEntityUuid(uuid, 10);
            if (entityMems?.length) {
              for (const em of entityMems) {
                // S4 P0-1 修复: memory_type 从未被 rowToRecord 回填（恒 undefined）→ 死过滤。
                // 改用 memory_kind === 'roleplay'（EmotionalMemoryRecord 有该字段且 rowToRecord 回填），
                // 否则激活的 entity 路会把 roleplay 记忆泄漏进正常检索。
                if (options?.isBackgroundTask && (em as any).memory_kind === 'roleplay') continue;
                items.push({
                  id: em.id ?? '', text: (em.raw_input ?? '').substring(0, 200),
                  score: em.seq_pos ?? 0, source: 'entity',
                  entityUuid: uuid, calciumScore: em.calcium_score ?? 0,
                  createdAt: em.created_at ?? '',
                });
              }
            }
          } catch { /* skip */ }
        }
      }
      items.sort((a, b) => b.score - a.score);
      return items;
    };

    // 6. 作品直达路 (work) — 长文召回元数据桥
    // "那篇小说/继续写/标题" 由 retrieval-stage 的 ReferentResolver 直查 works 主键。
    // 此路用关键词（实体名+locus）LIKE 匹配 works.title/summary/full_text，
    // 让普通查询（如"星落之城"）也能召回作品标题——高权重 RRF 置顶。
    const runWork = async (): Promise<RankedItem[]> => {
      const items: RankedItem[] = [];
      try {
        const sqlite = (this.storage as any).getSQLite?.();
        if (sqlite && typeof sqlite.queryAll === 'function' && keywords.size > 0) {
          // 只取 top 关键词（避免全词 OR 导致过宽召回）
          const workKws = [...keywords].slice(0, 5).filter(kw => kw && kw.length > 1);
          if (workKws.length > 0) {
            const likeClauses = workKws.map(() => '(title LIKE ? OR summary LIKE ? OR full_text LIKE ?)').join(' OR ');
            const params: any[] = [];
            for (const kw of workKws) { params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`); }
            const workRows = sqlite.queryAll(
              `SELECT work_id, title, work_type, summary, full_text, belong_entity_uuid, created_at
               FROM works WHERE ${likeClauses} ORDER BY created_at DESC LIMIT 5`,
              params,
            ) as any[];
            if (workRows?.length) {
              // 按户籍过滤：会晤时仅实体自有作品；户主钥匙（空）全放行
              // 🔴 S5-评审修复: 无归属(owner=null)在会晤场景必须 deny（与 policePasses 语义一致）
              const uuidSet = new Set(entityUuids);
              for (const row of workRows) {
                const owner = (row as any).belong_entity_uuid ?? null;
                // 会晤（entityUuids 非空）→ 仅白名单内实体作品放行（无归属作品 deny，杜绝泄漏）
                // 户主钥匙（entityUuids 空）→ 全放行（户主为最高权限）
                if (entityUuids.length > 0 && (!owner || !uuidSet.has(owner))) continue;
                const title = String((row as any).title || '');
                const summary = String((row as any).summary || '').substring(0, 120);
                // 🔴 S5-评审修复: 运算符优先级 bug — 每关键字对 title/summary 各自累加（显式括号），hits 非二值
                const hits = workKws.reduce((acc: number, kw: string) =>
                  acc + (title.includes(kw) ? 1 : 0) + (((row as any).summary || '').includes(kw) ? 1 : 0), 0);
                items.push({
                  id: String((row as any).work_id),
                  text: `《${title}》 ${summary}`.substring(0, 200),
                  score: Math.max(1, hits),
                  source: 'work',
                  entityUuid: owner,
                  calciumScore: 0,
                  createdAt: String((row as any).created_at || ''),
                });
              }
            }
          }
        }
      } catch { /* work 路失败不阻塞 */ }
      items.sort((a, b) => b.score - a.score);
      return items;
    };

    // 六路并行执行 → 固定顺序合并（Promise.all 数组保序，不依赖完成先后）
    const [emotionItems, keywordItems, spineItems, locusItems, entityItems, workItems] = await Promise.all([
      runEmotion(), runKeyword(), runSpine(), runLocus(), runEntity(), runWork(),
    ]);

    if (emotionItems.length > 0) lists.push({ source: 'emotion', items: emotionItems });
    if (keywordItems.length > 0) lists.push({ source: 'keyword', items: keywordItems });
    if (spineItems.length > 0) lists.push({ source: 'spine', items: spineItems });
    if (locusItems.length > 0) lists.push({ source: 'locus', items: locusItems });
    if (entityItems.length > 0) lists.push({ source: 'entity', items: entityItems });
    if (workItems.length > 0) lists.push({ source: 'work', items: workItems });

    // 去重计数
    const allIds = new Set<string>();
    for (const list of lists) for (const item of list.items) allIds.add(item.id);

    return { lists, totalCandidates: allIds.size, indexHit, indexedIds };
  }

  /** V3.1 记忆再巩固: 检索触发突触更新（人脑 reconsolidation 机制） */
  private _reconsolidateAsync(memories: DNA[], currentPerception?: Perception24D): void {
    try {
      const sqlite = (this.storage as any).getSQLite?.();
      if (!sqlite) return;

      // 同session去重: 使用内存 Set 防止每轮重复更新同一条
      if (!(this as any).__reconsolidatedIds) (this as any).__reconsolidatedIds = new Set<string>();
      const done: Set<string> = (this as any).__reconsolidatedIds;

      for (const mem of memories) {
        const id = mem.branch_id || (mem as any).seq_pos?.toString();
        if (!id || done.has(id)) continue;
        done.add(id);

        try {
          // ① recall_count +1
          sqlite.writeRaw(
            "UPDATE memories SET recall_count = COALESCE(recall_count, 0) + 1 WHERE id = ?", [id]
          );

          // ② 钙化小幅增强
          const newCa = Math.min(10, (mem.calcium_score || 0.5) + 0.15);
          sqlite.writeRaw(
            "UPDATE memories SET calcium_score = MAX(calcium_score, ?) WHERE id = ?", [newCa, id]
          );

          // ③ 强度平滑迭代: 基于情感匹配度微调强度
          if (currentPerception) {
            const oldStrength = (mem as any).effective_strength || 1.0;
            // V12.4 阶段B 根除24D: DNA 记录本就无 perception_json（原逻辑恒走中性默认），
            // arousal 无 40D 槽位 → 中性 0.5；强度匹配度降级为仅按当前 arousal 与中性的距离
            const origArousal = 0.5;
            const arousalDiff = Math.abs((currentPerception.arousal || 0) - origArousal);
            const matchScore = Math.max(0, 1 - arousalDiff);
            const newStrength = oldStrength * 0.95 + 0.05 * matchScore;
            sqlite.writeRaw(
              "UPDATE memories SET effective_strength = ?, strength_updated_at = ? WHERE id = ?",
              [newStrength, new Date().toISOString(), id]
            );

            // ④ 情绪差异感知追加: 当前 pleasure ≠ 原始时叠加新维度（原始 pleasure 无数据源 → 0，同旧行为）
            const origPleasure = 0;
            const currPleasure = currentPerception.pleasure || 0;
            if (Math.abs(currPleasure - origPleasure) > 0.3) {
              const v2 = JSON.stringify({ pleasure: currPleasure, arousal: currentPerception.arousal, dominance: currentPerception.dominance, tagged_at: new Date().toISOString() });
              sqlite.writeRaw(
                "UPDATE memories SET perception_v2 = ? WHERE id = ?",
                [v2, id]
              );
            }
          }
        } catch { /* 单条失败不阻塞 */ }
      }

      // 防泄漏: >500条时清理旧记录
      if (done.size > 500) { const arr = [...done]; done.clear(); arr.slice(-200).forEach((s: string) => done.add(s)); }
    } catch { /* 再巩固整体失败不阻塞 */ }
  }

  /**
   * P2-3: 检索记忆 + 返回结构化条目（双输出接口）
   * 与 retrieveMemories 共享缓存，额外返回结构化元数据
   */
  async retrieveMemoriesStructured(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    options?: { limit?: number; perception?: Perception24D; sessionId?: string; entityUuids?: string[] }
  ): Promise<{ items: StructuredMemoryItem[]; summary: MemorySummary }> {
    const dnas = await this.retrieveMemories(locusPath, entities, options);
    const summary = this.compressMemories(dnas);

    const items: StructuredMemoryItem[] = dnas.map((dna, idx) => ({
      id: dna.branch_id,
      seq_pos: dna.seq_pos,
      created_at: dna.created_at || '',
      raw_input: dna.raw_input || '',
      calcium_score: dna.calcium_score ?? 0,
      calcium_level: dna.calcium_level ?? 0,
      effective_strength: (dna as any).effective_strength ?? 0.5,
      recall_count: (dna as any).recall_count ?? 0,
      primary_emotion: (dna as any).primary_emotion,
      entity_names: (dna.entity_genes || []).map((g: any) => g.name).filter(Boolean),
      score: Math.max(0, 1 - idx * 0.2),
    }));

    return { items, summary };
  }

  /**
   * 上下文窗口压缩 — 将多条 DNA 压缩为自然语言摘要
   */
  compressMemories(dnas: DNA[]): MemorySummary {
    if (dnas.length === 0) {
      return {
        timeline: [],
        frequentEntities: [],
        timeSpan: { earliest: '', latest: '' },
      };
    }

    const timeline = dnas.map((dna) => ({
      time: dna.created_at,
      summary: dna.raw_input.length > 80
        ? dna.raw_input.substring(0, 80) + '...'
        : dna.raw_input,
      calcium_level: dna.calcium_level ?? 1,
      // P0-1: 透传根码
      dna_root_id: (dna as any).dna_root_id || undefined,
    }));

    const freqMap = new Map<string, { type: string; count: number }>();
    for (const dna of dnas) {
      for (const gene of dna.entity_genes) {
        const key = `${gene.type}:${gene.name}`;
        const existing = freqMap.get(key);
        if (existing) { existing.count++; }
        else { freqMap.set(key, { type: gene.type, count: 1 }); }
      }
    }

    const frequentEntities = [...freqMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([key, val]) => {
        const [type, name] = key.split(':');
        return { name, type, mentionCount: val.count };
      });

    const sorted = [...dnas].sort((a, b) => a.seq_pos - b.seq_pos);

    return {
      timeline,
      frequentEntities,
      timeSpan: {
        earliest: sorted[0]?.created_at ?? '',
        latest: sorted[sorted.length - 1]?.created_at ?? '',
      },
    };
  }

}
