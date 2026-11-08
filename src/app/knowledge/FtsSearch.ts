/**
 * FtsSearch.ts — 内存倒排索引全文检索引擎
 * ==========================================
 * 基于内存倒排索引 + BM25 评分，零外部依赖。
 * 比 LIKE %keyword% 快 50-100x，适合 5000 条以内知识库。
 *
 * 原理:
 *   1. init() 时从 SQLite 全量加载 → 构建倒排索引
 *   2. search() 时 BM25 评分 + 排序
 *   3. add()/remove() 实时更新索引
 *
 * 使用:
 *   const fts = new FtsSearch(sqlite);
 *   await fts.init();
 *   const results = fts.search('关键词', 10);
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import { RETRIEVABLE_WHERE_SQL } from './SourceTypePolicy.js';

export interface FtsSearchOptions {
  /** BM25 k1 参数 — 控制词频饱和度 (默认 1.5, 范围 0.5-3.0) */
  k1?: number;
  /** BM25 b 参数 — 控制文档长度归一化 (默认 0.75, 范围 0-1) */
  b?: number;
}

export interface FtsSearchOptions {
  /** BM25 k1 参数 — 控制词频饱和度 (默认 1.5, 范围 0.5-3.0) */
  k1?: number;
  /** BM25 b 参数 — 控制文档长度归一化 (默认 0.75, 范围 0-1) */
  b?: number;
}

export interface FtsResult {
  id: string;
  title: string;
  content: string;
  classification: string | null;
  score: number;  // BM25-like 评分
}

interface DocEntry {
  id: string;
  title: string;
  content: string;
  classification: string | null;
  length: number; // 文档长度（词数）
}

export class FtsSearch {
  private sqlite: SQLiteAdapter;
  private _ready = false;
  private k1: number;
  private b: number;

  /** 倒排索引: term → Map<docId, termFrequency> */
  private _invertedIndex = new Map<string, Map<string, number>>();

  /** 文档存储: docId → DocEntry */
  private _docs = new Map<string, DocEntry>();

  /** 停用词（不建索引的高频词） */
  private static STOP_WORDS = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
    '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去',
    '你', '会', '着', '没有', '看', '好', '自己', '这', '他', '她',
    '它', '们', '那', '里', '来', '出', '为', '与', '对', '把',
    '被', '让', '从', '向', '往', '用', '以', '及', '比', '但',
  ]);

  constructor(sqlite: SQLiteAdapter, options?: FtsSearchOptions) {
    this.sqlite = sqlite;
    this.k1 = options?.k1 ?? 1.5;
    this.b = options?.b ?? 0.75;
  }

  /** 初始化：全量加载 → 构建倒排索引 */
  async init(): Promise<void> {
    if (this._ready) return;
    try {
      const rows = this.sqlite.queryAll(
        `SELECT id, title, content, classification FROM knowledge_base WHERE ${RETRIEVABLE_WHERE_SQL()} ORDER BY rowid`
      );
      if (!rows || rows.length === 0) {
        this._ready = true;
        return;
      }

      for (const row of rows) {
        const r = row as any;
        const id = r.id as string;
        const title = r.title as string || '';
        const content = r.content as string || '';

        const combined = title + ' ' + content;
        const doc: DocEntry = {
          id, title, content,
          classification: r.classification as string | null,
          length: 0,
        };

        // 分词并构建索引
        const terms = this._tokenize(combined);
        doc.length = terms.length;

        this._docs.set(id, doc);

        // 统计 term frequency
        const tf = new Map<string, number>();
        for (const term of terms) {
          tf.set(term, (tf.get(term) || 0) + 1);
        }

        // 写入倒排索引
        for (const [term, freq] of tf) {
          let postings = this._invertedIndex.get(term);
          if (!postings) {
            postings = new Map();
            this._invertedIndex.set(term, postings);
          }
          postings.set(id, freq);
        }
      }

      this._ready = true;
      console.log(`[FTS] ✅ 内存倒排索引就绪: ${this._docs.size} 文档, ${this._invertedIndex.size} 词条`);
    } catch (err) {
      console.warn('[FTS] 初始化失败:', err);
    }
  }

  /** BM25 检索 */
  search(query: string, limit = 10): FtsResult[] {
    if (!this._ready || !query.trim() || this._docs.size === 0) return [];

    const queryTerms = this._tokenize(query);
    if (queryTerms.length === 0) return [];

    const N = this._docs.size;          // 文档总数
    const avgdl = this._avgDocLength();  // 平均文档长度
    

    // BM25 评分
    const scores = new Map<string, number>();

    for (const term of [...new Set(queryTerms)]) {
      const postings = this._invertedIndex.get(term);
      if (!postings) continue;

      const df = postings.size;  // 包含该词的文档数
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const [docId, tf] of postings) {
        const doc = this._docs.get(docId);
        if (!doc) continue;

        const docLen = doc.length || 1;
        const score = idf * ((tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * docLen / avgdl)));

        scores.set(docId, (scores.get(docId) || 0) + score);
      }
    }

    // 排序
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => {
        const doc = this._docs.get(id)!;
        return {
          id: doc.id,
          title: doc.title,
          content: doc.content,
          classification: doc.classification,
          score,
        };
      });
  }

  /** 新增文档到索引（新增知识时调用） */
  add(id: string, title: string, content: string, classification?: string | null): void {
    if (this._docs.has(id)) return;

    const combined = title + ' ' + content;
    const terms = this._tokenize(combined);
    const doc: DocEntry = { id, title, content, classification: classification || null, length: terms.length };
    this._docs.set(id, doc);

    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
    for (const [term, freq] of tf) {
      let postings = this._invertedIndex.get(term);
      if (!postings) { postings = new Map(); this._invertedIndex.set(term, postings); }
      postings.set(id, freq);
    }
  }

  /** 从索引移除文档 */
  remove(id: string): void {
    this._docs.delete(id);
    for (const postings of this._invertedIndex.values()) {
      postings.delete(id);
    }
  }

  /** 重建索引 */
  async rebuild(): Promise<void> {
    this._invertedIndex.clear();
    this._docs.clear();
    this._ready = false;
    await this.init();
  }

  /** 状态 */
  getStatus(): { ready: boolean; indexed: number } {
    return { ready: this._ready, indexed: this._docs.size };
  }

  // ─── 私有方法 ───

  /** 中文分词：滑动窗口 2-3 gram（对齐 SearchIndexBuilder.buildNgrams）+ 停用词过滤 */
  private _tokenize(text: string): string[] {
    const terms: string[] = [];
    const cleaned = text.toLowerCase();

    // 🔴 S2-B1: 原贪婪 2-4 字分组（/[一-龥]{2,4}/g）在查询"熊梓铭的/个人简介/是什么"处
    //   边界错位 — 查询 term 与索引 term（"熊梓铭"）永远不匹配 → BM25 0 命中 → 降级
    //   LIKE %熊梓铭的% 也失配（content 是"熊梓铭，"）。滑动窗口保证任意 2/3 字子串
    //   都是 term，"熊梓铭"必然被索引且被查询命中。
    const chineseChars: string[] = [];
    for (const ch of cleaned) {
      if (/[一-龥]/.test(ch)) chineseChars.push(ch);
    }
    // 🔴 S4-Y1: 不去重 — 让同一 term 多次出现 tf>1，BM25 词频饱和生效。
    // 原 `seen` 去重使所有 term tf 恒为 1 + doc.length=唯一 gram 数 → 高频词 doc
    // 反而不如低频 doc（实测 docA 含"熊梓铭"×5 得 0.517 < docB ×1 得 0.581，排序反转）。
    // 索引膨胀可接受（知识库仅 67 文档）；与旧贪婪实现（重复词也 push）行为一致。
    for (let i = 0; i < chineseChars.length; i++) {
      if (i + 1 < chineseChars.length) {
        const g2 = chineseChars[i] + chineseChars[i + 1];
        if (!FtsSearch.STOP_WORDS.has(g2)) terms.push(g2);
      }
      if (i + 2 < chineseChars.length) {
        const g3 = chineseChars[i] + chineseChars[i + 1] + chineseChars[i + 2];
        if (!FtsSearch.STOP_WORDS.has(g3)) terms.push(g3);
      }
    }

    // 提取英文/数字词 (2+ 字符)
    const asciiWords = cleaned.match(/[a-z0-9]{2,}/g);
    if (asciiWords) {
      for (const w of asciiWords) {
        if (!FtsSearch.STOP_WORDS.has(w)) terms.push(w);
      }
    }

    return terms;
  }

  private _avgDocLength(): number {
    if (this._docs.size === 0) return 1;
    let total = 0;
    for (const doc of this._docs.values()) total += doc.length || 1;
    return total / this._docs.size;
  }
}
