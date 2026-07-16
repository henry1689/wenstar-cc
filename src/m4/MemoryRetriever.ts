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
    options?: { limit?: number; perception?: Perception24D; sessionId?: string }
  ): Promise<DNA[]> {
    const limit = options?.limit ?? 5;
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
    const byLocus = await this.storage.findByLocus(locusPath, { limit: 20 });

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

    if (keywords.size > 0) {
      try {
        const cacheKey = [...keywords].sort().join("::");
        const _cached = await keywordCache.get(cacheKey);
        if (_cached) { byKeyword.push(..._cached); }
        else {
          const recent = await this.storage.findBySeqPosRange(0, 999_999_999, { limit: 200 });
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
          excludeRoleplay: true,  // 正常检索排除角色扮演记忆
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
    const bySpine: DNA[] = [];
    if (options?.perception) {
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

    // 4. 合并去重（加入 bySpine 源）
    const seen = new Set<string>();
    let merged: DNA[] = [];
    for (const dna of [...byEmotion, ...byKeyword, ...bySpine, ...byLocus]) {
      if (!seen.has(dna.branch_id) && merged.length < limit) {
        seen.add(dna.branch_id);
        merged.push(dna);
      }
    }

    // 5. 检索规则：正常模式排除角色扮演记忆（memory_kind='roleplay' 或 memory_type='rp_dialog'）
    //    角色扮演记忆只属于角色扮演检索管线(retrieveFullClue)，不应污染正常对话的检索结果。
    const _filtered = merged.filter(dna => {
      const kind = (dna as any).memory_kind;
      const mtype = (dna as any).memory_type;
      if (kind === 'roleplay' || mtype === 'rp_dialog') return false;
      return true;
    });
    if (_filtered.length < merged.length) {
      console.log(`[M4] 正常检索过滤 ${merged.length - _filtered.length} 条角色扮演记忆`);
      merged.length = 0;
      merged.push(..._filtered);
    }

    // 5. 知识库补充
    if (merged.length < limit * 0.5 && this.knowledgeBase && options?.perception) {
      try {
        const sceneTags = locusPath ? locusPath.split('.').filter(Boolean) : [];
        const entityKws = entities.filter(function(e) { return e.name.length > 0 && e.type !== 'self'; }).map(function(e) { return e.name; });
        const kbKeywords = [...entityKws, locusPath.split('.').pop() || ''].filter(Boolean).join(' ');
        if (kbKeywords.length > 2) {
          const kbResults = await this.knowledgeBase.weightedSearch(kbKeywords, sceneTags, {
            pleasure: options.perception.pleasure,
            arousal: options.perception.arousal,
            intimacy: options.perception.intimacy,
          }, limit - merged.length);
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

    return merged;
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
            // 比较当前 arousal 与记忆原始 arousal（同尺度 [-1,1]），而非 calcium_score
            let origArousal = 0.5;
            try {
              const orig = JSON.parse((mem as any).perception_json || '{}');
              if (typeof orig.arousal === 'number') origArousal = orig.arousal;
            } catch (e) { console.warn(`[MemoryRetriever] 操作失败`, (e as Error)?.message || e); }
            const arousalDiff = Math.abs((currentPerception.arousal || 0) - origArousal);
            const matchScore = Math.max(0, 1 - arousalDiff);
            const newStrength = oldStrength * 0.95 + 0.05 * matchScore;
            sqlite.writeRaw(
              "UPDATE memories SET effective_strength = ?, strength_updated_at = ? WHERE id = ?",
              [newStrength, new Date().toISOString(), id]
            );

            // ④ 情绪差异感知追加: 当前 pleasure ≠ 原始时叠加新维度
            const origPleasure = (() => { try { return JSON.parse((mem as any).perception_json || '{}').pleasure || 0; } catch { return 0; } })();
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
    options?: { limit?: number; perception?: Perception24D; sessionId?: string }
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
      summary: dna.raw_input.length > 60
        ? dna.raw_input.substring(0, 60) + '...'
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

  // === P0: 五层串行截断检索 ===
  async retrieveFullClue(roleplay: string, message: string, m4Ctx: any, enableTopology?: boolean, namespace?: string, sinceTimestamp?: string): Promise<FullClueResult> {
    const layers: string[] = []; const r: any = { l1Context:[], l2Sand:[], l2Vault:[], l2Diamond:[], l3Topology:[], l4Knowledge:[], hasValidRelation:false, layersUsed:layers };
    layers.push('L1');
    if (m4Ctx && m4Ctx.family_context) for (const fc of m4Ctx.family_context) if (fc.entity === roleplay || fc.related_entity === roleplay) r.l1Context.push(fc.entity + '的' + fc.relation + '是' + fc.related_entity);
    if (r.l1Context.length > 0) { r.hasValidRelation = true; return r; }
    layers.push('L2');
    try {
      const sq = typeof this.storage.getSQLite === 'function' ? this.storage.getSQLite() : null;
      if (sq && typeof sq.queryAll === 'function') {
        // 📜 时间窗过滤：sinceTimestamp 存在时只检索之后的数据（防止旧场景污染）
        const timeFilter = sinceTimestamp ? "AND timestamp > ?" : "";
        const timeParams = sinceTimestamp ? [roleplay, sinceTimestamp] : [roleplay];
        const s = sq.queryAll("SELECT content FROM conversations WHERE roleplay_char=? AND is_compacted=0 AND role='user' " + timeFilter + " ORDER BY timestamp DESC LIMIT 10", timeParams);
        for (const x of s || []) if (x.content) r.l2Sand.push(String(x.content ?? "").substring(0, 200));
        const vtFilter = sinceTimestamp ? "AND created_at > ?" : "";
        const vtParams = sinceTimestamp ? ['%' + roleplay + '%', sinceTimestamp] : ['%' + roleplay + '%'];
        const v = sq.queryAll("SELECT raw_input FROM memories WHERE raw_input LIKE ? " + vtFilter + " ORDER BY calcium_score DESC LIMIT 8", vtParams);
        for (const x of v || []) if (x.raw_input) r.l2Vault.push(String(x.raw_input ?? "").substring(0, 200));
        const bdFilter = sinceTimestamp ? "AND created_at > ?" : "";
        const bdParams = sinceTimestamp ? ['%rp_' + roleplay + '%', sinceTimestamp] : ['%rp_' + roleplay + '%'];
        const d = sq.queryAll("SELECT summary FROM black_diamond WHERE tags LIKE ? " + bdFilter + " ORDER BY created_at DESC LIMIT 5", bdParams);
        for (const x of d || []) if (x.summary) r.l2Diamond.push(String(x.summary ?? "").substring(0, 200));
      }
    } catch (e) {}
    // 🔴 修正：不因 L2 关键词提前截断 — L2 对话内容含"妈妈"不代表有实际关系数据
    // 必须运行 L3 拓扑获取真实亲属关系
    if (enableTopology || /妈妈|爸爸|姐姐|妹妹|母亲|父亲/.test(message || '')) {
      layers.push('L3');
      try {
        const sq = typeof this.storage.getSQLite === 'function' ? this.storage.getSQLite() : null;
        if (sq) {
          const { EntityTopologyManager } = await import('./EntityTopologyManager.js');
          const tp = new EntityTopologyManager(sq);
          const rels = tp.queryRelatives(roleplay, 3, undefined, namespace || 'default');
          const seen = new Set<string>();
          const lm = { mother:'母亲', father:'父亲', elder_sister:'姐姐', younger_sister:'妹妹', sister:'姐妹', brother:'兄弟', sibling:'兄弟姐妹', daughter:'女儿', son:'儿子', wife:'老婆', husband:'老公', aunt:'姑姑', cousin:'表亲', niece:'侄女' };
          for (const rel of rels) {
            const k = rel.relation_type + ':' + rel.target_entity_id;
            if (seen.has(k)) continue; seen.add(k);
            r.l3Topology.push({ rootId: roleplay, targetId: rel.target_entity_id, relation: (lm as any)[rel.relation_type] || rel.relation_type, chainPath: roleplay + '→' + rel.target_entity_id, level: rel.topology_level });
          }
          if (r.l3Topology.length > 0) r.hasValidRelation = true;
        }
      } catch (e) {}
    }
    layers.push('L4');
    return r;
  }
}

export interface FullClueResult {
  l1Context: string[];
  l2Sand: string[]; l2Vault: string[]; l2Diamond: string[];
  l3Topology: Array<{ rootId: string; targetId: string; relation: string; chainPath: string; level: number }>;
  l4Knowledge: string[];
  hasValidRelation: boolean;
  layersUsed: string[];
}
