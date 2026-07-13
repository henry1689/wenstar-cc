/**
 * ZvecAdapter.ts — Zvec 向量检索引擎适配器 (蓝皮书 §6.1, P2 阶段)
 * ===============================================================
 * 适配: 知识库重构设计规范 V1.0 / 蓝皮书 V2.0 §6.1
 *
 * 三 Collection 架构:
 *   Collection 1: knowledge_semantic  — 32D VECTOR_FP32 HNSW COSINE
 *   Collection 2: knowledge_fulltext  — STRING FTS 全文索引 + BM25
 *   Collection 3: knowledge_metadata  — 标量字段 (title/classification/tags)
 *
 * Zvec 特性:
 *   HNSW 图索引 + COSINE 距离
 *   VECTOR_FP32 32维 float32
 *   WAL 持久化 — 重启不丢失
 *   insertSync/querySync 同步 API
 *
 * P2 已切换: 基于 @zvec/zvec 0.5.0 (Windows x86_64 ✅)
 *
 * 使用:
 *   import { ZvecAdapter, createZvecAdapter } from '../m2/ZvecAdapter.js';
 *   const zvec = createZvecAdapter('./data/zvec_knowledge');
 *   await zvec.upsert('doc_001', embedding, { title, content });
 *   const results = await zvec.search(queryVector, 10);
 */

import { join } from 'node:path';

// ═══════════════════════════════════════════════════════════
// §1 — 接口定义 (与 @zvec/zvec 实际 API 对齐)
// ═══════════════════════════════════════════════════════════

export interface SearchResult {
  id: string;
  score: number;
  vectors?: Record<string, number[]>;
  fields?: Record<string, string>;
}

export interface IZvecAdapter {
  init(): Promise<void>;
  upsert(id: string, vector: Float32Array | number[], fields?: Record<string, string>): Promise<void>;
  search(query: Float32Array | number[], limit: number, filterField?: string, filterValue?: string): Promise<SearchResult[]>;
  upsertBatch(entries: Array<{ id: string; vector: Float32Array | number[]; fields?: Record<string, string> }>): Promise<void>;
  remove(id: string): Promise<void>;
  removeByPrefix(prefix: string): Promise<number>;
  readonly size: number;
  flush(): Promise<void>;
  close(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════
// §2 — 真实 Zvec C++ N-API 实现 (P2 已切换)
// ═══════════════════════════════════════════════════════════

class NativeZvecAdapter implements IZvecAdapter {
  private _coll: any = null;
  private _zvec: any = null;
  private _path: string;
  private _memFallback: InMemoryZvecAdapter | null = null;

  constructor(zvecPath: string) {
    this._path = zvecPath;
  }

  async init(): Promise<void> {
    try {
      this._zvec = await import('@zvec/zvec');
      this._zvec.ZVecInitialize({ logLevel: 2 }); // WARN level

      const { ZVecCollectionSchema, ZVecDataType, ZVecIndexType, ZVecMetricType } = this._zvec;

      const schema = new ZVecCollectionSchema({
        name: 'knowledge',
        vectors: [
          { name: 'embedding', dataType: ZVecDataType.VECTOR_FP32, dimension: 32, indexType: ZVecIndexType.HNSW, metricType: ZVecMetricType.COSINE },
        ],
        fields: [
          { name: 'title', dataType: ZVecDataType.STRING },
          { name: 'content', dataType: ZVecDataType.STRING },
          { name: 'classification', dataType: ZVecDataType.STRING },
          { name: 'tags', dataType: ZVecDataType.STRING },
        ],
      });

      this._coll = this._zvec.ZVecCreateAndOpen(this._path, schema, { readOnly: false });
      console.log(`[ZvecAdapter] ✅ HNSW+COSINE 就绪 (${this._coll.stats.docCount} docs)`);

    } catch (e) {
      console.warn('[ZvecAdapter] Zvec native 不可用 → 内存降级:', (e as Error).message.substring(0,80));
      this._coll = null;
      this._zvec = null;
      this._memFallback = new InMemoryZvecAdapter();
      await this._memFallback.init();
    }
  }

  async upsert(id: string, vector: Float32Array | number[], fields?: Record<string, string>): Promise<void> {
    if (this._memFallback) return this._memFallback.upsert(id, vector, fields);
    if (!this._coll) return;
    const arr = vector instanceof Float32Array ? Array.from(vector) : vector as number[];
    const doc: any = { id, vectors: { embedding: arr } };
    if (fields) {
      doc.title = fields.title || (fields as any).source_name || '';
      doc.content = fields.content || '';
      doc.classification = fields.classification || '';
      doc.tags = Array.isArray(fields.tags) ? (fields.tags as string[]).join(',') : (fields.tags || '');
    }
    this._coll.insertSync(doc);
  }

  async search(query: Float32Array | number[], limit: number, filterField?: string, filterValue?: string): Promise<SearchResult[]> {
    if (this._memFallback) return this._memFallback.search(query, limit, filterField, filterValue);
    if (!this._coll) return [];
    const arr = query instanceof Float32Array ? Array.from(query) : query as number[];
    const params: any = { fieldName: 'embedding', vector: arr, topk: limit };
    if (filterField && filterValue) {
      params.filter = `${filterField} == "${filterValue}"`;
    }
    const results = this._coll.querySync(params);
    if (!results || !Array.isArray(results)) return [];
    return results.map((r: any) => ({
      id: r.id,
      score: r.score ?? 0,
      vectors: r.vectors,
      fields: r.fields,
    }));
  }

  async upsertBatch(entries: Array<{ id: string; vector: Float32Array | number[]; fields?: Record<string, string> }>): Promise<void> {
    if (this._memFallback) return this._memFallback.upsertBatch(entries);
    if (!this._coll) return;
    const docs = entries.map(e => {
      const arr = e.vector instanceof Float32Array ? Array.from(e.vector) : e.vector as number[];
      const doc: any = { id: e.id, vectors: { embedding: arr } };
      if (e.fields) { doc.title = e.fields.title || ''; doc.content = e.fields.content || ''; doc.classification = e.fields.classification || ''; doc.tags = Array.isArray(e.fields.tags) ? (e.fields.tags as string[]).join(',') : (e.fields.tags || ''); }
      return doc;
    });
    if (docs.length === 1) this._coll.insertSync(docs[0]);
    else if (docs.length > 1) this._coll.insertSync(docs);
  }

  async remove(id: string): Promise<void> {
    if (this._memFallback) return this._memFallback.remove(id);
    if (!this._coll) return;
    try { this._coll.deleteByIdSync(id); } catch { /* ignore */ }
  }

  async removeByPrefix(prefix: string): Promise<number> {
    if (this._memFallback) return this._memFallback.removeByPrefix(prefix);
    if (!this._coll) return 0;
    try {
      const all = this._coll.querySync({ filter: `title LIKE "${prefix}%"`, limit: 10000, outputFields: ['id'] });
      const ids = all.map((r: any) => r.id);
      if (ids.length > 0) this._coll.deleteByIdSync(ids);
      return ids.length;
    } catch { return 0; }
  }

  get size(): number { return this._memFallback ? this._memFallback.size : (this._coll?.stats?.docCount ?? 0); }

  async flush(): Promise<void> {
    if (this._memFallback) return this._memFallback.flush();
    if (!this._coll) return;
    try { (this._coll as any).flushSync?.(); } catch { /* optional */ }
  }

  async close(): Promise<void> {
    if (this._memFallback) { await this._memFallback.close(); this._memFallback = null; return; }
    if (this._coll) { try { (this._coll as any).closeSync?.(); } catch { } this._coll = null; }
  }
}

// ═══════════════════════════════════════════════════════════
// §3 — 内存 Fallback (Zvec 不可用时自动降级)
// ═══════════════════════════════════════════════════════════

class InMemoryZvecAdapter implements IZvecAdapter {
  private _store = new Map<string, { vector: Float32Array; fields?: Record<string, string> }>();

  async init(): Promise<void> { this._store.clear(); }
  async upsert(id: string, vector: Float32Array | number[], fields?: Record<string, string>): Promise<void> {
    const v = vector instanceof Float32Array ? vector : new Float32Array(vector);
    this._store.set(id, { vector: v, fields });
  }
  async search(query: Float32Array | number[], limit: number, filterField?: string, filterValue?: string): Promise<SearchResult[]> {
    const q = query instanceof Float32Array ? query : new Float32Array(query);
    const results: SearchResult[] = [];
    for (const [id, entry] of this._store) {
      if (filterField && filterValue) {
        const val = entry.fields?.[filterField];
        if (val !== filterValue) continue;
      }
      const score = cosineSimilarity(q, entry.vector);
      results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
  async upsertBatch(entries: Array<{ id: string; vector: Float32Array | number[]; fields?: Record<string, string> }>): Promise<void> {
    for (const e of entries) await this.upsert(e.id, e.vector, e.fields);
  }
  async remove(id: string): Promise<void> { this._store.delete(id); }
  async removeByPrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const id of this._store.keys()) { if (id.startsWith(prefix)) { this._store.delete(id); count++; } }
    return count;
  }
  get size(): number { return this._store.size; }
  async flush(): Promise<void> { /* noop */ }
  async close(): Promise<void> { this._store.clear(); }
}

// ═══════════════════════════════════════════════════════════
// §4 — 工厂 + 工具
// ═══════════════════════════════════════════════════════════

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/** 创建 Zvec 适配器 (自动尝试 native, 失败则内存降级) */
export function createZvecAdapter(zvecPath?: string): IZvecAdapter {
  const path = zvecPath || join('data', 'zvec_knowledge');
  // NativeZvecAdapter.init() handles async import+fallback internally
  return new NativeZvecAdapter(path);
}

let _instance: IZvecAdapter | null = null;

export function getZvecAdapter(): IZvecAdapter {
  if (!_instance) _instance = createZvecAdapter();
  return _instance;
}

/** 重置全局实例 (调试/测试用) */
export function resetZvecAdapter(): void { _instance = null; }
