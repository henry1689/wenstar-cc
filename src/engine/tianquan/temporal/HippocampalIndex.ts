/**
 * HippocampalIndex.ts — 海马体稀疏索引 + CA1 输出整合层 (V3.0)
 * ==============================================================
 * 人脑海马体 CA1 区的功能：接收 DG（模式分离）和 CA3（模式补全）的输出，
 * 整合后决定最终返回什么给新皮层。
 *
 * 同时维护一个稀疏索引——不存记忆内容，只存 "context_signature → memory_locations" 的指针映射。
 * 同等上下文再出现时，O(1) 定位，无需扫全库。
 *
 * 三阶段生命周期：
 *   θ 节律（对话中）：查索引 → 命中则快速定位 → 未命中则扫库 + 写入索引
 *   SWR 节律（>30s）：更新索引钙化 boost
 *   δ 节律（>2h）：重建/优化稀疏索引（清理过期、合并相似）
 *
 * 使用:
 *   const idx = new HippocampalIndex(sqlite);
 *   const locs = idx.lookup(locusPath, entities, perception); // → memory_ids[]
 *   idx.store(contextSignature, memoryIds);  // 新发现的路径写入索引
 */
import type { SQLiteAdapter } from '../../../m2/SQLiteAdapter.js';
import type { DNA } from '../../../m1/types/dna.js';
import { createHash } from 'node:crypto';

// ─── 类型 ───
export interface HippocampalIndexEntry {
  contextSignature: string;
  memoryLocations: string[];    // 指向 memories 表的 id 列表
  calciumBoost: number;         // 每次命中 +0.1（常用路径更粗）
  lastActivatedAt: string;
  hitCount: number;
  createdAt: string;
}

export interface CA1IntegrationResult {
  /** CA1 整合后的最终记忆 id 列表（有序，最相关优先） */
  finalIds: string[];
  /** 是否从稀疏索引命中 */
  indexHit: boolean;
  /** DG 报告：去重了多少条 */
  dgDeduped: number;
  /** CA3 报告：补全了哪些维度 */
  ca3CompletedDimensions: string[];
  /** CA3 增强查询（用于知识库补充检索） */
  ca3EnhancedQuery: string;
}

// ─── 主类 ───
export class HippocampalIndex {
  private sqlite: SQLiteAdapter;
  /** 内存缓存：最多 500 条热索引 */
  private _cache = new Map<string, HippocampalIndexEntry>();
  private readonly CACHE_MAX = 500;

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
  }

  // ═══════════════════════════════════════════════════════
  //  稀疏索引查询（π 节律 — 对话时）
  // ═══════════════════════════════════════════════════════

  /**
   * 计算上下文签名
   * 签名 = hash(locus_domain + 情感聚类 + 实体组合)
   */
  computeSignature(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    perception?: { pleasure?: number; arousal?: number; dominance?: number }
  ): string {
    const domain = locusPath?.split('.').slice(0, 2).join('.') || 'root';
    const personEntities = entities
      .filter(e => e.type === 'person' && e.name !== '我')
      .map(e => e.name)
      .sort()
      .join('|');
    const emotionCluster = perception
      ? `${(perception.pleasure ?? 0) > 0.2 ? 'pos' : (perception.pleasure ?? 0) < -0.2 ? 'neg' : 'neu'}_${(perception.arousal ?? 0) > 0.3 ? 'high' : 'low'}`
      : 'neu_low';

    const raw = `${domain}|${emotionCluster}|${personEntities}`;
    return createHash('sha256').update(raw).digest('hex').substring(0, 16);
  }

  /**
   * 查稀疏索引：给定上下文签名，返回命中的 memory_locations
   * @returns memory_ids 数组（最多 5 个），null 表示未命中
   */
  lookup(contextSignature: string): string[] | null {
    // 1. 内存缓存
    const cached = this._cache.get(contextSignature);
    if (cached && (Date.now() - new Date(cached.lastActivatedAt).getTime()) < 3600_000) {
      // 命中后钙化 boost（异步更新，不阻塞）
      this._boostAsync(contextSignature);
      return cached.memoryLocations;
    }

    // 2. SQLite
    try {
      const rows = this.sqlite.queryAll(
        "SELECT memory_locations, calcium_boost, hit_count FROM hippocampal_index WHERE context_signature = ? LIMIT 1",
        [contextSignature]
      );
      if (rows && rows.length > 0) {
        const row = rows[0] as any;
        const locs = JSON.parse(row.memory_locations || '[]') as string[];
        if (locs.length > 0) {
          // 写入内存缓存
          const entry: HippocampalIndexEntry = {
            contextSignature,
            memoryLocations: locs,
            calciumBoost: row.calcium_boost || 0,
            lastActivatedAt: new Date().toISOString(),
            hitCount: (row.hit_count || 0) + 1,
            createdAt: new Date().toISOString(),
          };
          this._setCache(contextSignature, entry);
          this._boostAsync(contextSignature);
          return locs;
        }
      }
    } catch (err) {
      console.warn('[HippocampalIndex] 查询失败:', err);
    }
    return null; // 未命中
  }

  /**
   * 查经验摘要：给定上下文签名，返回 δ 节律归纳的经验摘要文本
   * @returns 经验摘要，null 表示无归纳
   */
  lookupExperience(contextSignature: string): string | null {
    try {
      const rows = this.sqlite.queryAll(
        "SELECT experience_summary FROM hippocampal_index WHERE context_signature = ? AND experience_summary IS NOT NULL AND experience_summary != '' LIMIT 1",
        [contextSignature]
      );
      if (rows && rows.length > 0) {
        const summary = (rows[0] as any).experience_summary as string;
        // 命中后异步 boosts
        setImmediate(() => {
          try {
            this.sqlite.writeRaw(
              "UPDATE hippocampal_index SET calcium_boost = MIN(5.0, calcium_boost + 0.1), last_activated_at = ? WHERE context_signature = ?",
              [new Date().toISOString(), contextSignature]
            );
          } catch (e) { console.warn(`[HippocampalIndex] 操作失败`, (e as Error)?.message || e); }
        });
        return summary;
      }
    } catch { /* 静默 */ }
    return null;
  }

  /**
   * 按关键字模糊搜索经验摘要（exp: 前缀条目）
   * 用于 θ 节律——根据用户消息内容查找相关的经验摘要，注入 LLM 上下文
   */
  lookupExperienceByKeyword(keyword: string): string | null {
    if (!keyword || keyword.length < 2) return null;
    try {
      const rows = this.sqlite.queryAll(
        "SELECT experience_summary FROM hippocampal_index WHERE context_signature LIKE 'exp:%' AND experience_summary LIKE ? ORDER BY calcium_boost DESC LIMIT 1",
        [`%${keyword}%`]
      );
      if (rows && rows.length > 0) {
        const summary = (rows[0] as any).experience_summary as string;
        return summary || null;
      }
    } catch { /* 静默 */ }
    return null;
  }

  /**
   * 写入稀疏索引：新发现的上下文路径
   */
  store(contextSignature: string, memoryIds: string[]): void {
    if (!memoryIds.length) return;
    const now = new Date().toISOString();
    const locsJson = JSON.stringify(memoryIds.slice(0, 5));

    // 写入 SQLite
    try {
      this.sqlite.writeRaw(
        `INSERT OR REPLACE INTO hippocampal_index (context_signature, memory_locations, calcium_boost, last_activated_at, hit_count, created_at)
         VALUES (?, ?, COALESCE((SELECT calcium_boost + 0.05 FROM hippocampal_index WHERE context_signature = ?), 0.05), ?, COALESCE((SELECT hit_count + 1 FROM hippocampal_index WHERE context_signature = ?), 1), ?)`,
        [contextSignature, locsJson, contextSignature, now, contextSignature, now]
      );
    } catch (err) {
      console.warn('[HippocampalIndex] 写入失败:', err);
    }

    // 写内存缓存
    this._setCache(contextSignature, {
      contextSignature,
      memoryLocations: memoryIds.slice(0, 5),
      calciumBoost: 0.05,
      lastActivatedAt: now,
      hitCount: 1,
      createdAt: now,
    });
  }

  // ═══════════════════════════════════════════════════════
  //  CA1 输出整合（核心方法）
  // ═══════════════════════════════════════════════════════

  /**
   * CA1: 整合 DG 分离结果 + CA3 补全结果 → 最终输出
   *
   * 这是海马体三突触回路的最后一站。
   * 输入 DG 和 CA3 的输出，产出最终返回给 M5 的记忆列表。
   */
  integrate(dgResult: {
    distinct: DNA[];
    deduped: number;
  }, ca3Result: {
    enhancedQuery: string;
    completedDimensions: string[];
    prototypeId?: string;
  }, indexHit: boolean): CA1IntegrationResult {
    // 优先级排序：钙化高 + 有原型匹配 + 最近活跃 → 排前面
    const sorted = [...dgResult.distinct].sort((a, b) => {
      const aProto = ca3Result.prototypeId && (a.branch_id === ca3Result.prototypeId || a.seq_pos?.toString() === ca3Result.prototypeId) ? 1 : 0;
      const bProto = ca3Result.prototypeId && (b.branch_id === ca3Result.prototypeId || b.seq_pos?.toString() === ca3Result.prototypeId) ? 1 : 0;
      if (aProto !== bProto) return bProto - aProto; // 原型排最前
      return (b.calcium_score || 0.5) - (a.calcium_score || 0.5);
    });

    return {
      finalIds: sorted.slice(0, 5).map(d => d.branch_id || d.seq_pos?.toString() || ''),
      indexHit,
      dgDeduped: dgResult.deduped,
      ca3CompletedDimensions: ca3Result.completedDimensions,
      ca3EnhancedQuery: ca3Result.enhancedQuery,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  SWR 节律：索引钙化维护
  // ═══════════════════════════════════════════════════════

  /**
   * 异步提升索引钙化（每次命中 +0.1）
   */
  private _boostAsync(contextSignature: string): void {
    setImmediate(() => {
      try {
        this.sqlite.writeRaw(
          "UPDATE hippocampal_index SET calcium_boost = MIN(5.0, calcium_boost + 0.1), hit_count = hit_count + 1, last_activated_at = ? WHERE context_signature = ?",
          [new Date().toISOString(), contextSignature]
        );
      } catch { /* 静默 */ }
    });
  }

  // ═══════════════════════════════════════════════════════
  //  δ 节律：索引维护
  // ═══════════════════════════════════════════════════════

  /**
   * 每日索引维护（在 SleepTimeConsolidator δ 节律中调用）
   * - 清理 90 天未激活的低钙化索引
   * - 合并相似索引（context_signature 前 8 位相同 → 合并）
   * - 晋升 hit_count > 100 且钙化 > 3.0 的为永久索引
   */
  runDailyMaintenance(): number {
    let cleaned = 0;
    try {
      // 1. 清理过期
      const cutoff = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
      const result = this.sqlite.writeRaw(
        "DELETE FROM hippocampal_index WHERE last_activated_at < ? AND calcium_boost < 0.3 AND hit_count < 10",
        [cutoff]
      );
      cleaned += (result as any)?.changes || 0;

      // 2. 标记永久索引（hit_count > 100 且钙化 > 3.0）
      this.sqlite.writeRaw(
        "UPDATE hippocampal_index SET calcium_boost = MIN(10.0, calcium_boost) WHERE hit_count > 100 AND calcium_boost > 3.0"
      );

      if (cleaned > 0) console.log(`[HippocampalIndex] δ 维护: 清理 ${cleaned} 条过期索引`);
    } catch (err) {
      console.warn('[HippocampalIndex] δ 维护失败:', err);
    }
    return cleaned;
  }

  /** 获取统计信息 */
  getStats(): { totalIndexes: number; permanentIndexes: number; avgBoost: number } {
    try {
      const total = (this.sqlite.queryAll("SELECT COUNT(*) as c FROM hippocampal_index")[0] as any)?.c || 0;
      const permanent = (this.sqlite.queryAll("SELECT COUNT(*) as c FROM hippocampal_index WHERE calcium_boost > 3.0 AND hit_count > 100")[0] as any)?.c || 0;
      const avgBoost = (this.sqlite.queryAll("SELECT AVG(calcium_boost) as a FROM hippocampal_index")[0] as any)?.a || 0;
      return { totalIndexes: total as number, permanentIndexes: permanent as number, avgBoost: avgBoost as number };
    } catch { return { totalIndexes: 0, permanentIndexes: 0, avgBoost: 0 }; }
  }

  // ─── 内存缓存管理 ───
  private _setCache(key: string, entry: HippocampalIndexEntry): void {
    if (this._cache.size >= this.CACHE_MAX) {
      // LRU 淘汰：删除最旧的 10%
      const entries = [...this._cache.entries()]
        .sort((a, b) => new Date(a[1].lastActivatedAt).getTime() - new Date(b[1].lastActivatedAt).getTime());
      for (let i = 0; i < Math.floor(this.CACHE_MAX * 0.1); i++) {
        this._cache.delete(entries[i][0]);
      }
    }
    this._cache.set(key, entry);
  }
}

// ─── 单例 ───
let _globalIndex: HippocampalIndex | null = null;

export function getHippocampalIndex(): HippocampalIndex | null {
  return _globalIndex;
}

export function initHippocampalIndex(sqlite: SQLiteAdapter): HippocampalIndex {
  if (!_globalIndex) _globalIndex = new HippocampalIndex(sqlite);
  return _globalIndex;
}
