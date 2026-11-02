// MemoryRetriever — 从 M2 检索历史记忆 + 上下文压缩
// Ref: M4-design-v1.md §4
//
// v2: 新增会话级缓存（P1-2）+ 双输出接口（P2-3）

import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';
import type { KnowledgeBase } from '../m2/KnowledgeBase.js';
import type { DNA } from '../m1/types/dna.js';
import type { PerceptionState24 } from '../m3/types/perception.js';
import type { PerceptionV40 } from '../m3/types/perception-40d.js';
import type { MemorySummary } from './types/index.js';
import { RETRIEVAL_THRESHOLDS, BATCH_SIZES, MIN_MATCHED_FOR_BREAK } from '../m2/retrieval-constants.js';
// 🔴 2026-09-12 召回窗口修复: 实体分层召回的归属过滤统一走公安过滤器（户籍管理法第九条 搜索闸门）
import { buildSqlClause } from '../governance/police/UUIDPoliceFilter.js';
// 🔴 2026-09-12 B1 关键词倒排召回: 查询词由用户当前消息派生（与索引生产端同源切词）
import { buildNgrams } from './SearchIndexBuilder.js';
import { LocalCache } from '../app/tools/LocalCache.js';
import { HippocampalIndex } from '../engine/tianquan/temporal/HippocampalIndex.js';
import { SURNAME_CHARS } from '../config/app-identity.js';
import type { MultiRankResult, RankedList, RankedItem } from './types/retrieval.js';
// 🔴 检索架构 v11 §S2 A5：闸门加载失败的 fail-closed 改造（蓝皮书 §5.3 业主裁决 2026-10-27 方案 A）
import { Flags, ENCLOSURE_DEFAULT_LIMIT, RERANK_TOP_K } from './retrieval/Flags.js';
import {
  incr as incrMetric,
  write as writeShadow,
  error as errorShadow,
  observeLatency,
  coverageOf,
} from './retrieval/ShadowLog.js';
import { recallByStructured, scoreAndRank } from './retrieval/StructuredRecall.js';
import type { EnclosureDomain } from './retrieval/StructuredRecall.js';

// 关键词检索缓存：相同关键词 30 秒内复用结果
const keywordCache = new LocalCache<string, DNA[]>({ ttlMs: 30_000, namespace: 'm4_keyword' });

// P071 Phase1: 语义联想路 G1 语义初筛阈值（蓝皮书 §4.1：cosine≥0.3）
const SPINE40_SEMANTIC_FLOOR = 0.3;

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

  /**
   * 实体 UUID 分层召回（2026-09-12 召回窗口修复）
   *
   * 根因：实体通道原为「按 seq_pos 倒序取最新 10 条」单窗口 —— 会晤实体记忆量大
   *   （实测徐诗雨 TXS-000000007 名下 570 条），早期高钙化/地标记忆（如中秋之约）
   *   永远进不了上下文，表现为"聊过的内容再聊就不记得"。
   *
   * 分层：① 最新层（近期对话上下文）② 重要层（地标 > 高钙化 > 高召回）——
   *   两层均按 UUID 白名单过滤（deny-by-default），去重合并后截断到 window。
   * 异常：查询失败返回空，由调用方回退存储公共 API，不阻断其余五路召回。
   *
   * @param uuid  会晤实体 UUID（归属唯一依据；裸名不参与判定）
   * @param limit 分层窗口大小
   */
  private recallEntityMemoriesRanked(uuid: string, limit: number): any[] {
    if (!uuid || limit <= 0) return [];
    try {
      const sqlite = (this.storage as any)?.getSQLite?.();
      if (!sqlite || typeof sqlite.queryAll !== 'function') return [];
      // 🔴 户籍管理法（第九条 搜索闸门）: 归属过滤唯一来源 = UUIDPoliceFilter。
      //   白名单仅含目标实体；参数为空则 fail-closed（宁拒不放）。
      const police = buildSqlClause({ visibleUuids: new Set([uuid]) });
      if (!police.params.length) return [];
      const window = Math.max(10, limit);
      const half = Math.max(1, Math.ceil(window / 2));
      const seen = new Set<string>();
      const out: any[] = [];
      const take = (rows: any[]) => {
        for (const row of rows || []) {
          const key = row?.id ?? row?.branch_id;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(row);
        }
      };
      take(sqlite.queryAll(
        `SELECT * FROM memories WHERE 1=1${police.clause} AND COALESCE(namespace,'default') <> 'test' ORDER BY seq_pos DESC LIMIT ?`,
        [...police.params, half],
      ));
      take(sqlite.queryAll(
        `SELECT * FROM memories WHERE 1=1${police.clause} AND COALESCE(namespace,'default') <> 'test'
         ORDER BY is_landmark DESC, calcium_score DESC, recall_count DESC, seq_pos DESC LIMIT ?`,
        [...police.params, window],
      ));
      return out.slice(0, window);
    } catch (e) {
      console.warn('[M4] 实体分层召回失败:', (e as Error)?.message);
      return [];
    }
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
   * 🔴 检索架构 v11 §S2 A6 —— 影子调用（双跑）
   * ==========================================================
   * 与生产链路**并行**跑一遍新结构化召回，结果**只写日志、不参与返回**。
   *
   * 【硬约束（任务书 §S2 A「影子调用硬约束」+ D1）】
   *   1. **fire-and-forget**：`setImmediate` 派发，**不 await**。
   *      这样生产链路既不增加延迟，也不改变任何 await 顺序 ——
   *      是满足 S2-B8「生产返回结果集逐字节一致」的最强保证。
   *   2. 整体 try/catch 包住，异常只走 `ShadowLog.error`，**永不抛出**。
   *   3. 影子自身耗时在影子路径内自测并写日志（不占用生产请求时间）。
   *   4. 不碰任何业务表、不落任何持久化表、不进缓存（ADR-013）。
   *
   * 【为什么 domain 固定传 ['dialog_group','memory']】
   * 路由开关（`RETRIEVAL_V11_DIALOG_GROUP` 等）控制的是**生产走哪条路**；
   * 影子是**测量工具**，必须探测新链路真正要走的全部域，否则双跑数据失真。
   * 尤其 S1 已停写 conversation 的 n-gram 索引，对话组主路是退化窗口的关键对照面。
   */
  private _shadowRecall(args: {
    locusPath: string;
    /** 旧链路本次返回的 id（生产结果集的 id，不是正文） */
    oldIds: string[];
    keywords: string[];
    entityUuids?: string[];
    p40?: PerceptionV40;
    domains?: EnclosureDomain[];
    gateDegraded?: boolean;
  }): void {
    if (!Flags.enabled()) return; // 总闸关闭 ⇒ 影子完全不跑，零副作用
    const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // 🔴 **四域全探**（业主 2026-10-27 裁决「影子覆盖率是少了点，可以再大一些」）。
    //    此前只探 dialog_group + memory，而旧路 `old_ids` 是六路合并结果，
    //    两者口径不可比 ⇒ 实测覆盖率仅 17%，偏低是口径造成的，不全是召回真的差。
    //    扩到四域后覆盖率才对得起 §7.1「新链路 ⊇ 旧链路」的判据。
    //    影子是 fire-and-forget 不 await，四域串行约 200ms 不落到生产延迟上。
    const domains = args.domains ?? ['memory', 'dialog_group', 'conversation', 'work'];

    setImmediate(async () => {
      try {
        const sqlite = (this.storage as any)?.getSQLite?.();
        if (!sqlite || typeof sqlite.queryAll !== 'function') return;

        const uuids = (args.entityUuids ?? []).filter(Boolean);
        const all: Array<Awaited<ReturnType<typeof recallByStructured>>[number]> = [];

        const tEnc = Date.now();
        for (const d of domains) {
          const hits = await recallByStructured(sqlite, {
            domain: d,
            entityUuids: uuids,
            keywords: args.keywords,
            locusPath: args.locusPath,
            limit: ENCLOSURE_DEFAULT_LIMIT,
          }, args.p40);
          all.push(...hits);
        }
        const encMs = Date.now() - tEnc;

        const tRk = Date.now();
        const ranked = scoreAndRank(all, Date.now());
        const rerankMs = Date.now() - tRk;

        // 🔴 out 必须是**截断后**的候选数才有意义（§8.3 空结果率 / 漏斗宽度口径）。
        //    原实现直接用未截断的 ranked，导致 out 恒等于 in，该指标失效。
        const newIds = ranked.slice(0, RERANK_TOP_K).map((h) => h.id);
        incrMetric('v11_retrieval_total');
        incrMetric('v11_candidates_in', all.length);
        incrMetric('v11_candidates_out', newIds.length);
        if (!args.p40) incrMetric('semantic_skipped_total');
        if (args.gateDegraded) incrMetric('gate_degraded_total');
        observeLatency(encMs + rerankMs);

        writeShadow({
          trace_id: traceId,
          ts: new Date().toISOString(),
          domains,
          candidates_in: all.length,
          candidates_out: newIds.length,
          top_ids: newIds.slice(0, 5),
          old_ids: args.oldIds,
          new_ids: newIds,
          stage_ms: { enclosure: encMs, rerank: rerankMs },
          flags: {
            gate_degraded: args.gateDegraded === true,
            semantic_skipped: !args.p40,
            // 空 UUID 白名单 ⇒ 围栏 fail-closed 返回空（结构性，不是故障）
            fence_skipped_no_uuid_scope: uuids.length === 0,
          },
          // 🔴 §7.1 判据集合（2026-10-28 修正 · 业主裁决「按蓝皮书字面修为候选集」）
          //   蓝皮书 §8.3 原文：「旧路每条结果 ∈ **新链路候选集**」的查询占比。
          //   原实现传的是 `newIds` = `ranked.slice(0, RERANK_TOP_K)` —— 拿**截断后的前 50**
          //   冒充候选集，而围栏出口 `candidates_in` 实测 P50=**829**。
          //   实测四口径对照（260 条样本）：现行整体 5.1% / 蓝皮书字面查询级 0% /
          //   overlap@10 = 1.0% / 零覆盖 54.2% —— 全部因集合被截断而失真。
          //   ⇒ 改为对 `all`（围栏全候选集）计算；`new_ids` 仍记 top-K，
          //     供离线另算排名重合度做交叉验证（口径不再混用）。
          //   ⚠️ 本字段取值集合已变 ⇒ **修正前的 coverage 历史作废**，须重采。
          coverage: coverageOf(args.oldIds, all.map((h) => h.id)),
        });
      } catch (e) {
        errorShadow(e, traceId); // 影子失败只记录，不抛出、不影响生产结果
      }
    });
  }

  /** 🔴 v11 §S3 A1 路由总闸：三个开关全开才接管（围栏 + 精排 + 全局），缺一即走旧路 */
  private _v11RouteOn(): boolean {
    return Flags.enabled() && Flags.enclosure() && Flags.rerank();
  }

  /**
   * 🔴 检索架构 v11 §S3 A1 —— 新链路：围栏 → 精排 → 回表 → 五级闸门
   * ==========================================================
   * 只替换 **G1 的候选生成方式**（倒排索引 → 结构化围栏 + 现算精排），
   * **G2–G5 一字不动**且必须挂在本方法出口（白皮书 §4.1.1：闸门是唯一读取通道，无旁路）。
   *
   * @returns `null` = 新链路**不接管**，调用方原样落回旧路。
   *   触发条件：无 sqlite 句柄 / 空 UUID 白名单（围栏 fail-closed）/ 围栏零命中 / 回表失败。
   *   🔴 零命中时落回旧路是 **fail-open**（蓝皮书 §2.3 铁律②：精排是质量优化，
   *   只能 fail-open，不得因新链路空结果而丢召回）。
   */
  private async _v11FenceToDnas(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    options?: { limit?: number; p40?: PerceptionV40; entityUuids?: string[]; rawQuery?: string },
  ): Promise<DNA[] | null> {
    const sqlite = (this.storage as any)?.getSQLite?.();
    if (!sqlite || typeof sqlite.queryAll !== 'function') return null;

    const uuids = (options?.entityUuids ?? []).filter(Boolean);
    // 🔴 红线 14：UUID 白名单为空不得放行 ⇒ 围栏 fail-closed，本方法不接管
    if (uuids.length === 0) return null;

    const keywords: string[] = [];
    for (const e of entities) if (e.name && e.name.length > 0) keywords.push(e.name);
    if (locusPath) {
      const last = locusPath.split('.').pop();
      if (last && last !== 'default' && last !== 'general') keywords.push(last);
    }
    if (options?.rawQuery) keywords.push(options.rawQuery);

    // [1] 围栏
    const hits = await recallByStructured(sqlite, {
      domain: 'memory',
      entityUuids: uuids,
      keywords,
      locusPath,
      limit: ENCLOSURE_DEFAULT_LIMIT,
    }, options?.p40);
    if (hits.length === 0) return null; // fail-open 落回旧路

    // [2] 精排（权重取 Flags 冻结常量，本阶段禁止调参 —— 任务书 S2-D5 / S3-D3）
    const ranked = scoreAndRank(hits, Date.now());
    // 🔴 **恒用 RERANK_TOP_K，不得让 `options.limit` 参与截断**。
    //    旧路 `retrieveMemories` 是 `return merged`（六路合并后 30–60 条），
    //    `options.limit`（默认 5）在旧路只用于知识库配额，**不限制最终返回条数**。
    //    v11 是「在内部换实现」不是「换接口」（蓝皮书 §2.1），返回语义必须与旧路一致。
    //    2026-10-27 首次上线时按 limit=5 截断，实测召回骤减，随即回滚。
    const top = ranked.slice(0, RERANK_TOP_K);

    // [3] 回表取完整列 —— 围栏契约（蓝皮书 §2.2 EnclosureHit）只带精排所需字段，
    //     五级闸门还需要 calcium_level / effective_strength / is_landmark 等，
    //     故按 top-K id 回表（≤12 行）。与旧路 recallByKeywordIndex 的「索引命中→回表」同型。
    let rows: Array<Record<string, unknown>>;
    try {
      const phs = top.map(() => '?').join(',');
      // 🔴 SQLiteAdapter.queryAll 签名是 (sql, params?: any[]) —— 参数整组传数组，不得展开
      rows = sqlite.queryAll(
        `SELECT * FROM memories WHERE id IN (${phs}) AND COALESCE(namespace,'default') <> 'test'`,
        top.map((h) => h.id),
      ) as Array<Record<string, unknown>>;
    } catch (e) {
      console.warn('[RetrievalV11] 回表失败，落回旧路:', (e as Error)?.message);
      return null; // fail-open
    }

    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows || []) if (r['id'] != null) byId.set(String(r['id']), r);

    let merged: DNA[] = [];
    for (const h of top) {
      const r = byId.get(h.id);
      if (!r) continue;
      merged.push({
        branch_id: String(r['id']),
        locus_path: (r['locus_path'] as string) ?? '',
        taxonomy_version: '1.0',
        seq_pos: (r['seq_pos'] as number) ?? 0,
        leaf_zone: (r['leaf_zone'] as string) ?? 'language_semantic_zone',
        ref: '',
        entity_genes: [],
        raw_input: (r['raw_input'] as string) ?? '',
        created_at: (r['created_at'] as string) ?? '',
        calcium_score: (r['calcium_score'] as number) ?? 0,
        calcium_level: (r['calcium_level'] as number) ?? 0,
        memory_kind: r['memory_kind'] as string,
        dna_root_id: r['dna_root_id'] as string,
        effective_strength: (r['effective_strength'] as number) ?? 1,
        is_landmark: (r['is_landmark'] as number) ?? 0,
        absolute_timestamp: r['created_at'] ? new Date(String(r['created_at'])).getTime() : Date.now(),
      } as unknown as DNA);
    }
    if (merged.length === 0) return null;

    return merged;
  }

  /**
   * 🔴 五级闸门 G2–G5 —— v11 两个出口共用的唯一挂载实现。
   * 不可旁路（白皮书 §4.1.1）；容器层只映射 id/文本/钙分/时间/locus，**不映射
   * `cosine_score`**（蓝皮书 §5.2 hasScores 陷阱会清空全部无分候选）。
   * @returns `[]` 表示 fail-closed 已触发（闸门加载失败且开关已闭合）。
   */
  private async _v11ApplyGate(
    dnas: DNA[],
    locusPath: string,
    perceptionFingerprint: string,
  ): Promise<DNA[]> {
    let merged = dnas;
    try {
      const { getFiveStageGate } = await import('../m3/FiveStageGate.js');
      const gate = getFiveStageGate();
      const gated = gate.filter(
        merged.map((d) => ({
          id: d.branch_id,
          dna_root_id: (d as any).dna_root_id,
          raw_input: d.raw_input,
          calcium_score: (d as any).calcium_score ?? 0,
          calcium_level: (d as any).calcium_level ?? 0,
          effective_strength: (d as any).effective_strength ?? 1,
          location_fingerprint: (d as any).location_fingerprint ?? '',
          locus_path: d.locus_path,
          leaf_zone: d.leaf_zone,
          absolute_timestamp: (d as any).absolute_timestamp ?? Date.now(),
          is_landmark: (d as any).is_landmark ?? 0,
        })),
        { query: locusPath, locationFingerprint: perceptionFingerprint },
      );
      const gatedSet = new Set(gated.passed.map((m) => m.id));
      merged = merged.filter((d) => gatedSet.has(d.branch_id));
    } catch (_e) {
      if (!Flags.gateFailClosed()) {
        console.warn('[FiveStageGate·v11] 加载失败，跳过闸门过滤(回退开关已开，仅限紧急，须上报):', (_e as Error).message);
      } else {
        console.error('[FiveStageGate·v11] 加载失败，按 fail-closed 返回空结果:', (_e as Error).message);
        incrMetric('gate_failclosed_total');
        return [];
      }
    }
    return merged;
  }

  /** v11 §S3 A1 挂载点① 用的新链路：围栏→精排→回表→五级闸门 */
  private async _v11RetrieveMemories(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    options?: { limit?: number; p40?: PerceptionV40; entityUuids?: string[]; rawQuery?: string; perception?: PerceptionState24 },
  ): Promise<DNA[] | null> {
    const dnas = await this._v11FenceToDnas(locusPath, entities, options);
    if (!dnas) {
      // 🔴 接管率观测：围栏未给出候选 ⇒ 调用方 `viaV11 && viaV11.length>0` 必然为假 ⇒ 落回旧路
      incrMetric('v11_fallback_fence_total');
      incrMetric('v11_fallback_total');
      return null;
    }
    const fp = (options?.perception as any)?.location_fingerprint ?? '';
    const gated = await this._v11ApplyGate(dnas, locusPath, fp);
    // 判据与调用方**逐字同一条件**，避免「埋点说接管、代码没接管」的双口径
    if (gated.length > 0) incrMetric('v11_takeover_total');
    else incrMetric('v11_fallback_total'); // 围栏有货但闸门后为空（全被过滤 / fail-closed）
    return gated;
  }

  /**
   * 🔴 v11 §S3 A1 挂载点② —— 只替换 `retrieveMultiRank` 六路里的 **keyword 路**。
   *
   * 业主 2026-10-27 裁决：v11 本质是取代 n-gram 倒排的关键词召回，
   * 其余五路（emotion / spine / locus / entity / work）**原样保留**，
   * V13 RRF 的多路多样性不变（白皮书 §4.1「v11 只替换 G1 的候选生成方式」）。
   *
   * ⚠️ 不在本方法内挂闸门 —— `retrieveMultiRank` 的六路汇合处已有共享闸门挂载点②，
   * 在此再挂一次会重复过滤。
   *
   * @returns `null` = 新链路不接管，调用方落回旧路。
   */
  private async _v11KeywordRanked(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    options?: { p40?: PerceptionV40; entityUuids?: string[]; rawQuery?: string; isBackgroundTask?: boolean },
  ): Promise<RankedItem[] | null> {
    const dnas = await this._v11FenceToDnas(locusPath, entities, options);
    if (!dnas || dnas.length === 0) {
      // 🔴 接管率观测（与挂载点①同型）：围栏未给出候选 ⇒ runKeyword 调用方必落回旧路
      incrMetric('v11_fallback_fence_total');
      incrMetric('v11_fallback_total');
      return null;
    }
    const items: RankedItem[] = [];
    for (const d of dnas) {
      if (options?.isBackgroundTask && (d as any).memory_kind === 'roleplay') continue;
      items.push({
        id: d.branch_id,
        text: (d.raw_input ?? '').substring(0, 200),
        score: (d as any).calcium_score ?? 0,
        source: 'keyword',
        entityUuid: (d as any).belong_entity_uuid ?? null,
        calciumScore: (d as any).calcium_score ?? 0,
        createdAt: d.created_at ?? '',
      });
    }
    // `_v11FenceToDnas` 已按精排分降序返回，此处保持原序（路内已排序）
    // 🔴 接管率观测：判据与 runKeyword 的 `viaV11 && viaV11.length > 0` 逐字同一条件。
    //    items 为空（围栏有货但全被 isBackgroundTask 的 roleplay 过滤）同样算**未接管**。
    if (items.length > 0) incrMetric('v11_takeover_total');
    else incrMetric('v11_fallback_total');
    return items;
  }

  /**
   * 根据 M3 决策检索相关历史记忆
   *
   * v2: 新增会话级缓存（P1-2），同一会话中相同 locus_path 复用检索结果
   */
  async retrieveMemories(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    options?: { limit?: number; perception?: PerceptionState24; p40?: PerceptionV40; sessionId?: string; entityUuids?: string[]; isBackgroundTask?: boolean; rawQuery?: string; searchScope?: 'strict' | 'allow-unowned' | 'full' }
  ): Promise<DNA[]> {
    // 🔴 v11 §S3 A1 路由：新链路开启时接管候选生成。**旧路代码在其后逐字保留**，
    //    关掉 RETRIEVAL_V11 即回到改造前状态（分钟级回滚，任务书 S3-C）。
    //    新链路不接管（返回 null）时同样落回旧路，不阻断检索。
    if (this._v11RouteOn()) {
      const viaV11 = await this._v11RetrieveMemories(locusPath, entities, options);
      // 🔴 **不切片**：旧路是 `return merged`（六路合并后可能 30–60 条），
      //    `options.limit` 在旧路只用于知识库配额（`limit - merged.length`），
      //    **不**限制最终返回条数。若在此按 limit 截断，等于把生产召回从几十条砍到 5 条
      //    —— 2026-10-27 切换上线后实测到角色说「那个 XX 真没印象」的召回失效即由此而来。
      //    v11 是「在内部换实现」不是「换接口」（蓝皮书 §2.1），返回语义必须与旧路一致。
      if (viaV11 && viaV11.length > 0) return viaV11;
    }

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
    // 🔴 Foundation V2.0: 透传搜索范围限定
    const byLocus = await this.storage.findByLocus(locusPath, { limit: 20, entityUuids: options?.entityUuids, searchScope: options?.searchScope });

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
          // 🔴 2026-11-02 业主裁决「彻底拆除 n-gram」：原 B1 关键词倒排召回
          //   （recallByKeywordIndex 查 search_index 的 memory 分区）已删除 ——
          //   该分区在 v11 之后无写入方，且 v11 接管时本段本就不执行。
          //   现在旧路关键词召回只保留 findBySeqPosRange + 内存过滤这一条不依赖索引的路径。
          const seen = new Set<string>();
          // 🔴 Foundation V2.0: 透传搜索范围限定
          const recent = await this.storage.findBySeqPosRange(0, 999_999_999, { limit: 200, entityUuids: options?.entityUuids, searchScope: options?.searchScope });
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
          p40: options?.p40,  // 🔴 P072 整改批：查询同源——原生 40D 优先，缺失回退仅供内部分析
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

    // 🔴 P071(2026-10-23): 原 3.5 双螺旋 state_spines 检索路已随底座1 废除删除
    //   （该表从未建 HNSW、仅 4 维+30 天窗+候选无文本，残废路；40D 语义真源=memories.perception_40d）

    // 4. 🆕 实体归属检索（belong_entity_uuid 直查，不依赖 memory_kind）
    //    🔴 2026-09-12 召回窗口修复: 原「单窗口取最新 10 条」→ 分层召回（最新层 + 地标/高钙化层），
    //       窗口随调用方 limit 抬升。会晤实体（实测徐诗雨 570 条）的早期记忆不再被最新记忆挤掉。
    const byEntityUuid: DNA[] = [];
    const entityUuids = options?.entityUuids || [];
    if (entityUuids.length > 0) {
      const _entityWindow = Math.max(20, limit * 2);
      for (const uuid of entityUuids) {
        try {
          let entityMems: any[] = this.recallEntityMemoriesRanked(uuid, _entityWindow);
          // 回退：分层查询不可用（无 getSQLite / 查询异常）→ 走存储公共 API 单窗口
          if (entityMems.length === 0 && typeof this.storage.findByEntityUuid === 'function') {
            entityMems = this.storage.findByEntityUuid(uuid, _entityWindow) as any;
          }
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

    // 5. 合并去重（P071: spine 路已删，剩四源）
    const seen = new Set<string>();
    let merged: DNA[] = [];
    for (const dna of [...byEmotion, ...byKeyword, ...byLocus]) {
      if (!seen.has(dna.branch_id) && merged.length < limit) {
        seen.add(dna.branch_id);
        merged.push(dna);
      }
    }

    // 5. 检索规则：正常模式排除角色扮演记忆（memory_kind='roleplay' 或 memory_type='rp_dialog'）
    // 🔴 2026-09-12 P0-② 过滤对称化: 原条件仅 `isBackgroundTask` → **非会晤场景（和玉瑶聊天）
    //   完全不过滤**，byLocus/byEmotion/byKeyword 三路把他人会晤记忆注入玉瑶上下文
    //   （实测症状：玉瑶频道自称"诗雨"）。现对称判定：
    //     会晤场景(entityUuids 非空) → 保留本实体的会晤记忆；
    //     非会晤场景 → 排除（他人会晤记忆不得注入）；后台任务 → 维持排除。
    const _nonMeetingContext = (options?.entityUuids?.length ?? 0) === 0;
    const _filtered = merged.filter(dna => {
      // V12.7(批1): memory_kind 已由 toDNA 回填（此前恒 undefined 死过滤）；
      // memory_type 从未被 rowToRecord 回填 → 删死判定，统一用 memory_kind。
      if ((options?.isBackgroundTask || _nonMeetingContext) && dna.memory_kind === 'roleplay') return false;
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
        // 🔴 五级闸门是安全边界，只能 fail-closed（蓝皮书 §2.3 铁律① / §5.3 方案 A）。
        //    原实现「打印告警并继续」是 fail-open，使「不可绕过」在异常路径上被绕过 —— 本次根治。
        //    开关 RETRIEVAL_V11_GATE_FAILCLOSED：S2 期默认关（生产行为不变），
        //    S3 起默认闭合。回退开关仅限紧急且须上报（任务书 §S2 C / §S3 D5）。
        if (!Flags.gateFailClosed()) {
          // 旧行为：告警后**落穿**到后续会话缓存 / 海马体索引 / 检索日志再返回。
          // 这里刻意不 return —— 保持与改造前逐字节一致的控制流（fail-open 放行）。
          console.warn('[FiveStageGate] 加载失败, 跳过闸门过滤(回退开关已开，仅限紧急，须上报):', (_e as Error).message);
        } else {
          console.error('[FiveStageGate] 加载失败，按 fail-closed 返回空结果:', (_e as Error).message);
          incrMetric('gate_failclosed_total');
          return []; // 安全边界失败 ⇒ 宁拒不放
        }
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

    // 🔴 v11 §S2 A6 影子调用：只写日志，绝不参与返回值（fire-and-forget，不 await）
    this._shadowRecall({
      locusPath,
      oldIds: merged.map((d) => d.branch_id),
      keywords: [...keywords],
      entityUuids: options?.entityUuids,
      p40: options?.p40,
    });

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
    options?: { perception?: PerceptionState24; p40?: PerceptionV40; queryText?: string; entityUuids?: string[]; sessionId?: string; isBackgroundTask?: boolean; searchScope?: 'strict' | 'allow-unowned' | 'full' }
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
    // 🔴 P071 Phase1: spine 路以 perception_40d 重建（语义联想路，全实体含会晤，无时间窗）。
    // 🔴 每路守卫条件原样保留（emotion 需 perception、spine 需 perception、entity 需 uuid、work 需关键词）。
    // 🔴 不剪枝：keyword/spine 的 200 条候选窗口原样保留（改动会改变召回范围）。
    const entityUuids = options?.entityUuids ?? [];
    
    // 🔴 Foundation V2.0: 搜索范围限定
    const searchScope = options?.searchScope ?? 'strict';

    // 1. 情感/情绪路 (emotion)
    const runEmotion = async (): Promise<RankedItem[]> => {
      const items: RankedItem[] = [];
      const hasEmotionType = entities.some(e => e.type === 'emotion');
      const hasMeaningfulEntity = entities.some(e => e.name.length > 0 && e.type !== 'self');
      if (options?.perception && (hasEmotionType || hasMeaningfulEntity)) {
        try {
          const scored = this.storage.findByEmotionalSimilarity({
            current_perception: options.perception,
            p40: options?.p40,  // 🔴 P072 整改批：查询同源——原生 40D 优先，缺失回退仅供内部分析
            entities: entities.filter(e => e.type === 'emotion').map(e => e.name),
            similarity_mode: 'mood_congruent',
            limit: 30,
            entityUuids: options?.entityUuids,
            searchScope: options?.searchScope,
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
      // 🔴 v11 §S3 A1 挂载点②：新链路开启时**只替换本路**（v11 本质取代 n-gram 倒排
      //    的关键词召回）。其余五路 emotion/spine/locus/entity/work 原样保留，
      //    V13 RRF 多样性不变。旧路代码在其后逐字保留，关开关即回滚。
      if (this._v11RouteOn()) {
        const viaV11 = await this._v11KeywordRanked(locusPath, entities, options);
        if (viaV11 && viaV11.length > 0) return viaV11;
      }
      const items: RankedItem[] = [];
      if (keywords.size > 0) {
        try {
          const recent = await this.storage.findBySeqPosRange(0, 999_999_999, { limit: 200, entityUuids: options?.entityUuids, searchScope: options?.searchScope });
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

    // 3. P071 Phase1 · 语义联想路 (spine40D) — 双螺旋语义链真源 memories.perception_40d
    // 🔴 P072 业主立法级裁决（2026-10-23）：「除 40D 外其它都是违法」——
    //   查询向量**必须是 M3 原生 40D**（options.p40，与写入侧同源同规格）；
    //   **禁止 projectState24ToV40 等 24D→40D 二次投影**（违法支线，且实测六维规格不一致：
    //   写入侧未映射维=M3 中性 0.35/瑶光回填，投影侧=0 → 瑶光回填记忆被系统性降分）。
    //   无原生 p40 → 本路直接跳过，不降级。
    // 法定 G1 候选源：全 40 维扇区加权余弦（cosineSimilarity40D 唯一合法相似度）
    //   → floor 0.3（G1 语义初筛在路内执行，见闸门挂载注释）。
    //   - 全实体生效（含会晤场景）：UUID 过滤经 belong_entity_uuid 列；户主场景全池（最高权限钥匙）。
    //   - 无时间窗（SEMANTIC_ONLY 自由联想，隔几年也命中）。
    //   - 退化治理：全零向量 sim=0 被 floor 拦截（交关键词路）；同 dna_root_id 一簇一票；tie-break sim→钙分→新。
    //   - 双源（业主裁决⑤ 四库覆盖）：memories（金库，排 promoted_to_diamond）+
    //     black_diamond（黑钻 active）；砂金无向量列由关键词/原文路覆盖，
    //     知识库走 KnowledgeEngine 既有链路（visible_entity_uuids 可见性规则不旁路）。
    const runSpine40D = async (): Promise<RankedItem[]> => {
      const items: RankedItem[] = [];
      const q40 = options?.p40; // M3 原生 40D（唯一合法查询量纲）
      if (!q40) return items;
      try {
        const sqlite = (this.storage as any).getSQLite?.();
        if (sqlite && typeof sqlite.queryAll === 'function') {
          const { decodePerceptionV40, cosineSimilarity40D } = await import('../m2/PerceptionVector40DCodec.js');
          // UUID 户籍过滤（户籍法第九条 搜索闸门）：白名单非空 → IN 子句；空 → 户主全池
          const uuidClause = entityUuids.length > 0 ? `AND belong_entity_uuid IN (${entityUuids.map(() => '?').join(',')})` : '';
          const uuidParams = entityUuids.length > 0 ? entityUuids : [];
          const rows: Array<{ id: string; raw_input: string; calcium_score: number; created_at: string; perception_40d: string; dna_root_id: string | null; src: string; memory_kind?: string }> = [
            ...(sqlite.queryAll(
              `SELECT id, raw_input, calcium_score, created_at, perception_40d, dna_root_id, memory_kind, 'memory' AS src
               FROM memories
               WHERE COALESCE(promoted_to_diamond, 0) = 0
                 AND COALESCE(namespace, 'default') <> 'test'
                 AND perception_40d IS NOT NULL AND perception_40d <> '' ${uuidClause}`,
              uuidParams,
            ) ?? []),
            ...(sqlite.queryAll(
              `SELECT id, summary AS raw_input, (CAST(calcium_level AS REAL) / 3.0) AS calcium_score,
                      created_at, emotion_vector AS perception_40d, dna_root_id, 'active' AS memory_kind, 'black_diamond' AS src
               FROM black_diamond
               WHERE status = 'active' AND emotion_vector IS NOT NULL AND emotion_vector <> '' ${uuidClause}`,
              uuidParams,
            ) ?? []),
          ];
          // 🔴 P071-Phase2批B · DUAL_CHAIN 寻址先行（业主架构：UUID 主线，藤/时序为池内工具）：
          //   主动回忆意图（G4 正则，经 isActiveRecallIntent 同源判定）且 UUID 白名单非空时 →
          //   ATL 按实体归属 + 时序倒序取历史 GlobalUID（200）扩展语义联想候选池——
          //   旧记忆不再被近期窗/关键词排除；双 UUID 守卫（ATL entity IN + 下方 memories belong IN）。
          if (entityUuids.length > 0 && options?.queryText) {
            try {
              const { isActiveRecallIntent } = await import('../m3/FiveStageGate.js');
              if (isActiveRecallIntent(options.queryText)) {
                const hist = sqlite.queryAll(
                  `SELECT global_uid FROM atom_address_timeline
                   WHERE entity_belong_id IN (${entityUuids.map(() => '?').join(',')})
                   ORDER BY absolute_timestamp DESC LIMIT 200`, entityUuids) as Array<{ global_uid: string }>;
                if (hist && hist.length > 0) {
                  const huids = hist.map(h => h.global_uid);
                  const histRows = sqlite.queryAll(
                    `SELECT id, raw_input, calcium_score, created_at, perception_40d, dna_root_id, memory_kind, 'memory' AS src
                     FROM memories
                     WHERE global_uid IN (${huids.map(() => '?').join(',')})
                       AND COALESCE(promoted_to_diamond, 0) = 0
                       AND COALESCE(namespace, 'default') <> 'test'
                       AND perception_40d IS NOT NULL AND perception_40d <> '' ${uuidClause}`,
                    [...huids, ...uuidParams]) as Array<typeof rows[number]>;
                  if (histRows?.length) {
                    rows.push(...histRows);
                    console.log(`[M4-Spine40D] DUAL_CHAIN 寻址先行: ATL 历史候选 ${histRows.length} 条（意图命中）`);
                  }
                }
              }
            } catch { /* 寻址先行失败不阻塞语义联想 */ }
          }
          // 语义扇区余弦 + 退化治理：全零拦截 / 同 dna_root 一簇一票 / tie-break
          const bestByRoot = new Map<string, { r: typeof rows[number]; sim: number }>();
          for (const r of rows) {
            if (options?.isBackgroundTask && r.memory_kind === 'roleplay') continue;
            const mem40 = decodePerceptionV40(r.perception_40d);
            if (!mem40) continue;
            const sim = cosineSimilarity40D(q40, mem40);
            if (!Number.isFinite(sim) || sim < SPINE40_SEMANTIC_FLOOR) continue;
            const rootKey = r.dna_root_id || r.id;
            const prev = bestByRoot.get(rootKey);
            if (!prev || sim > prev.sim) bestByRoot.set(rootKey, { r, sim });
          }
          for (const { r, sim } of bestByRoot.values()) {
            items.push({
              id: r.id, text: (r.raw_input ?? '').substring(0, 200),
              score: sim, source: 'spine',
              entityUuid: null, calciumScore: r.calcium_score ?? 0,
              createdAt: r.created_at ?? '',
            });
          }
          if (items.length > 0) console.log('[M4-Spine40D] 语义联想候选: ' + items.length + ' 条 (双源' + rows.length + '行)');
        }
      } catch (err) { console.warn('[M4-Spine40D] 语义联想路失败（不阻塞其他路）:', (err as Error).message); }
      items.sort((a, b) => (b.score - a.score) || ((b.calciumScore ?? 0) - (a.calciumScore ?? 0)));
      return items;
    };

    // 4. 话题前缀路 (locus)
    const runLocus = async (): Promise<RankedItem[]> => {
      const items: RankedItem[] = [];
      try {
        // 🔴 Foundation V2.0: 透传搜索范围限定
        const byLocus = await this.storage.findByLocus(locusPath, { limit: 20, entityUuids: options?.entityUuids, searchScope: options?.searchScope });
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
      // 🔴 2026-09-12 召回窗口修复: 与主路径同源 —— 分层召回 + 窗口随 limit 抬升（原硬编码 10 条）。
      if (entityUuids.length > 0) {
        // 本路所属接口无 limit 概念 → 固定分层窗口 20（旧实现硬编码取最新 10 条）
        const _entityWindow = 20;
        for (const uuid of entityUuids) {
          try {
            let entityMems: any[] = this.recallEntityMemoriesRanked(uuid, _entityWindow);
            if (entityMems.length === 0 && typeof this.storage.findByEntityUuid === 'function') {
              entityMems = this.storage.findByEntityUuid(uuid, _entityWindow) as any;
            }
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

    // P071 Phase1: 六路并行（spine 路以 perception_40d 重建，恢复原六路结构）
    const [emotionItems, keywordItems, spineItems, locusItems, entityItems, workItems] = await Promise.all([
      runEmotion(), runKeyword(), runSpine40D(), runLocus(), runEntity(), runWork(),
    ]);

    if (emotionItems.length > 0) lists.push({ source: 'emotion', items: emotionItems });
    if (keywordItems.length > 0) lists.push({ source: 'keyword', items: keywordItems });
    if (spineItems.length > 0) lists.push({ source: 'spine', items: spineItems });
    if (locusItems.length > 0) lists.push({ source: 'locus', items: locusItems });
    if (entityItems.length > 0) lists.push({ source: 'entity', items: entityItems });
    if (workItems.length > 0) lists.push({ source: 'work', items: workItems });

    // 🔴 P071 Phase1: 五级闸门挂共享出口（蓝皮书 §8.3「唯一读取通道，无旁路」，
    //   原主链 retrieveMultiRank 全程 0 闸门 = 合规缺陷，本次修复）
    //   - G1 语义初筛：spine 路内 floor=0.3 已执行；容器 G1 **不重复设分**——
    //     混合池中非语义候选无 cosine 分，一旦池内存在带分候选，G1 会把无分候选全部清零剔除
    //     （FiveStageGate 实现如此），故容器层不映射 cosine_score 字段，G1 自然放行。
    //   - 容器跑 G2 时空 / G3 衰减 / G4 意图 / G5 话题壁垒；只按**成员过滤**、保持各路原序
    //     （G2-G5 现行为均为重权不丢弃；成员过滤为未来丢弃型规则预留）。
    try {
      if (lists.length > 0) {
        const { getFiveStageGate } = await import('../m3/FiveStageGate.js');
        const gate = getFiveStageGate();
        const gateCandidates = lists.flatMap(l => l.items.map(it => ({
          id: it.id,
          raw_input: it.text,
          calcium_score: it.calciumScore,
          absolute_timestamp: it.createdAt ? Date.parse(it.createdAt) : undefined,
          locus_path: locusPath,
        })));
        if (gateCandidates.length > 0) {
          // P071-Phase2: G4 意图区分用真实消息（原误传 locusPath 致主动回忆正则空转）；无消息回退 locusPath
          const gated = gate.filter(gateCandidates, { query: options?.queryText || locusPath, locationFingerprint: '' });
          const passedIds = new Set(gated.passed.map(m => m.id));
          for (const l of lists) l.items = l.items.filter(it => passedIds.has(it.id));
          for (let i = lists.length - 1; i >= 0; i--) if (lists[i].items.length === 0) lists.splice(i, 1);
          console.log(`[FiveStageGate·主链] ${gateCandidates.length}候选过闸 | ${JSON.stringify(gated.stageStats)}`);
        }
      }
    } catch (e) {
      // 🔴 同上：主链共享出口的闸门加载失败，只能 fail-closed（蓝皮书 §5.3 改造点 ②）。
      if (!Flags.gateFailClosed()) {
        // 旧行为：告警后**落穿**到 try/catch 之后的去重计数再返回（fail-open 放行）。
        // 这里刻意不 return —— 保持与改造前逐字节一致的控制流。
        console.warn('[FiveStageGate·主链] 加载失败，跳过闸门过滤(回退开关已开，仅限紧急，须上报):', (e as Error).message);
      } else {
        console.error('[FiveStageGate·主链] 加载失败，按 fail-closed 清空候选:', (e as Error).message);
        incrMetric('gate_failclosed_total');
        return { lists: [], totalCandidates: 0, indexHit, indexedIds };
      }
    }

    // 去重计数
    const allIds = new Set<string>();
    for (const list of lists) for (const item of list.items) allIds.add(item.id);

    // 🔴 v11 §S2 A6 影子调用：只写日志，绝不参与返回值（fire-and-forget，不 await）
    this._shadowRecall({
      locusPath,
      oldIds: [...allIds],
      keywords: [...keywords],
      entityUuids: options?.entityUuids,
      p40: options?.p40,
    });

    return { lists, totalCandidates: allIds.size, indexHit, indexedIds };
  }

  /** V3.1 记忆再巩固: 检索触发突触更新（人脑 reconsolidation 机制） */
  private _reconsolidateAsync(memories: DNA[], currentPerception?: PerceptionState24): void {
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
    options?: { limit?: number; perception?: PerceptionState24; sessionId?: string; entityUuids?: string[] }
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
