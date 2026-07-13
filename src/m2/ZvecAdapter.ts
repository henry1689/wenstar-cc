/**
 * ZvecAdapter.ts — Zvec 向量检索引擎适配器 (蓝皮书 §6.1, P2 阶段)
 * ===============================================================
 * 适配: 知识库重构设计规范 V1.0 / 蓝皮书 V2.0 §6.1
 *
 * P2 目标:
 *   @zvec/zvec N-API 绑定 → libzvec C++
 *   HNSW 图索引 + RaBitQ 量化 (32× 内存压缩) + WAL 持久化
 *
 * 当前 (P1 过渡):
 *   内存 Map<id, float32[]>  + cosine 匹配
 *   重启丢失索引
 *
 * 使用:
 *   import { ZvecAdapter, createZvecAdapter } from '../m2/ZvecAdapter.js';
 *   const zvec = createZvecAdapter();
 *   await zvec.upsert('mm_001', vector);
 *   const results = await zvec.search(queryVec, 10);
 */

// ═══════════════════════════════════════════════════════════
// §1 — 接口定义
// ═══════════════════════════════════════════════════════════

export interface SearchResult {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
}

export interface IZvecAdapter {
  /** 初始化引擎 (加载索引/WAL恢复) */
  init(): Promise<void>;

  /** 插入/更新向量 */
  upsert(id: string, vector: Float32Array | number[], payload?: Record<string, unknown>): Promise<void>;

  /** 向量检索 (余弦相似度) */
  search(query: Float32Array | number[], limit: number): Promise<SearchResult[]>;

  /** 批量插入 */
  upsertBatch(entries: Array<{ id: string; vector: Float32Array | number[]; payload?: Record<string, unknown> }>): Promise<void>;

  /** 删除向量 */
  remove(id: string): Promise<void>;

  /** 索引大小 */
  readonly size: number;

  /** 强制落盘 (WAL checkpoint) */
  flush(): Promise<void>;

  /** 关闭引擎 */
  close(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════
// §2 — 内存实现 (P1 过渡, 重启丢失)
// ═══════════════════════════════════════════════════════════

class InMemoryZvecAdapter implements IZvecAdapter {
  private _store = new Map<string, { vector: Float32Array; payload?: Record<string, unknown> }>();
  private _dirty = false;

  async init(): Promise<void> {
    this._store.clear();
    this._dirty = false;
  }

  async upsert(id: string, vector: Float32Array | number[], payload?: Record<string, unknown>): Promise<void> {
    const v = vector instanceof Float32Array ? vector : new Float32Array(vector);
    this._store.set(id, { vector: v, payload });
    this._dirty = true;
  }

  async search(query: Float32Array | number[], limit: number): Promise<SearchResult[]> {
    const q = query instanceof Float32Array ? query : new Float32Array(query);
    const results: SearchResult[] = [];

    for (const [id, entry] of this._store) {
      const score = cosineSimilarity(q, entry.vector);
      results.push({ id, score, payload: entry.payload });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async upsertBatch(entries: Array<{ id: string; vector: Float32Array | number[]; payload?: Record<string, unknown> }>): Promise<void> {
    for (const e of entries) await this.upsert(e.id, e.vector, e.payload);
  }

  async remove(id: string): Promise<void> { this._store.delete(id); this._dirty = true; }
  get size(): number { return this._store.size; }
  async flush(): Promise<void> { /* 内存模式: 无持久化 */ }
  async close(): Promise<void> { this._store.clear(); }
}

// ═══════════════════════════════════════════════════════════
// §3 — Zvec Native 实现 (P2 切换目标)
// ═══════════════════════════════════════════════════════════

/**
 * P2 安装步骤:
 *   1. npm install @zvec/zvec  (或从本地 C++ 编译)
 *   2. 取消下面 import 的注释
 *   3. 将 createZvecAdapter() 的返回值改为 new NativeZvecAdapter()
 *
 * import { createZvecEngine, type ZvecEngine } from '@zvec/zvec';
 *
 * class NativeZvecAdapter implements IZvecAdapter {
 *   private _engine: ZvecEngine | null = null;
 *
 *   async init() {
 *     this._engine = await createZvecEngine({
 *       dim: 32,                    // P3: 32D
 *       indexType: 'hnsw',
 *       quantize: 'rabitq',         // 32× 压缩
 *       storagePath: 'data/webui/zvec_wal',
 *       m: 16,                      // HNSW M 参数
 *       efConstruction: 200,
 *     });
 *   }
 *
 *   async upsert(id, vector, payload?) {
 *     await this._engine!.upsert(id, vector, payload);
 *   }
 *
 *   async search(query, limit) {
 *     return this._engine!.search(query, limit);
 *   }
 *
 *   async upsertBatch(entries) {
 *     await this._engine!.upsertBatch(entries);
 *   }
 *
 *   async remove(id) { await this._engine!.remove(id); }
 *   get size() { return this._engine!.size; }
 *   async flush() { await this._engine!.flush(); }
 *   async close() { await this._engine!.close(); }
 * }
 */

// ═══════════════════════════════════════════════════════════
// §4 — 工厂 + 工具
// ═══════════════════════════════════════════════════════════

/** 创建 Zvec 适配器 (当前返回内存实现, P2 后返回 Native) */
export function createZvecAdapter(): IZvecAdapter {
  // P2 切换: return new NativeZvecAdapter();
  return new InMemoryZvecAdapter();
}

/** 全局单例 */
let _instance: IZvecAdapter | null = null;
export function getZvecAdapter(): IZvecAdapter {
  if (!_instance) _instance = createZvecAdapter();
  return _instance;
}

/** 余弦相似度 (纯 JS, 无依赖) */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * P2 切换检查清单:
 *   1. npm install @zvec/zvec
 *   2. 验证 HNSW 图索引正确载入 499 条现有分块
 *   3. 验证 RaBitQ 量化: 32× 压缩率, 余弦精度 < 2% 损失
 *   4. 验证 WAL 持久化: 重启后索引不丢失
 *   5. 知识库 search/weightedSearch 全部切换到 ZvecAdapter.search()
 *   6. 移除 current KnowledgeEngine 中的 vectorStore (内存Map)
 *   7. 性能验证: 374 条条目 < 1ms, 5000 条 < 5ms
 */
