/**
 * KnowledgeEngine — 知识引擎（应用层）
 *
 * 整合向量搜索 + RAG 管道：
 * - add/upload 时自动分块、嵌入、索引
 * - search 时混合检索（向量语义 + 关键词 LIKE）
 * - API 不可用时自动降级为纯 LIKE
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import type { KnowledgeItem } from './types.js';
import type { Perception24D } from '../../m3/types/perception.js';
import { parseFile } from './FileUploadService.js';
import { FileChunker } from '../tools/FileChunker.js';
import { ConfigService } from '../../config/ConfigService.js';

// 文件切片器实例（段落策略，每块 500 字符，50 重叠）
const fileChunker = new FileChunker({ strategy: 'paragraph', chunkSize: 500, overlap: 50, minChunkLen: 20 });
import { createLocalEmbedding } from './EmbeddingProvider.js';
import { VectorStore } from './VectorStore.js';
import { hybridSearch } from './RAGPipeline.js';
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { LocalCache } from '../tools/LocalCache.js';
import { fileURLToPath } from 'node:url';
import { DNAEncoder } from '../../m1/DNAEncoder.js'; // 🔥 generateGlobalUID('WK', ...) 生成23字符GlobalUID

// ── MD 同步路径 ──
const __MD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'knowledge-md');

// ── 知识柜分类路径 ──
const __KC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'knowledge-cabinet');
const __KC_DOCS = join(__KC_ROOT, 'docs');
const __KC_IMG = join(__KC_ROOT, 'images');
const __KC_VID = join(__KC_ROOT, 'videos');
const __KC_DATA = join(__KC_ROOT, 'data');

/** source_type → 分类文件夹映射 */
const CABINET_MAP: Record<string, string> = {
  txt: 'docs', md: 'docs', text: 'docs', protocol: 'docs', person: 'docs',
  research: 'docs', query: 'docs', important: 'docs', paste: 'docs',
  jpg: 'images', jpeg: 'images', png: 'images', gif: 'images',
  bmp: 'images', webp: 'images', svg: 'images',
  mp4: 'videos', avi: 'videos', mov: 'videos', mkv: 'videos', webm: 'videos',
};
const CABINET_DIRS: Record<string, string> = {
  docs: __KC_DOCS, images: __KC_IMG, videos: __KC_VID, data: __KC_DATA,
};

/** 获取安全的文件名 */
function safeFileName(title: string, sourceType: string): string {
  const ext = sourceType === 'md' ? '.md'
    : ['jpg','jpeg','png','gif','bmp','webp','svg'].includes(sourceType) ? '.' + sourceType
    : sourceType === 'mp4' || sourceType === 'avi' || sourceType === 'mov' || sourceType === 'mkv' || sourceType === 'webm' ? '.' + sourceType
    : sourceType === 'xlsx' ? '.xlsx' : sourceType === 'xls' ? '.xls'
    : sourceType === 'csv' ? '.csv' : sourceType === 'pdf' ? '.pdf'
    : sourceType === 'docx' ? '.docx' : sourceType === 'json' ? '.json'
    : '.txt';
  const base = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().substring(0, 80);
  return base + ext;
}

/** 同步条目到知识柜分类文件夹 */
function syncToCabinet(entry: KnowledgeItem, remove = false): void {
  try {
    const folder = CABINET_MAP[entry.source_type] || 'data';
    const dir = CABINET_DIRS[folder] || __KC_DATA;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const fname = safeFileName(entry.title, entry.source_type);
    const fpath = join(dir, fname);
    if (remove) {
      if (existsSync(fpath)) unlinkSync(fpath);
      return;
    }
    writeFileSync(fpath, entry.content || '', 'utf-8');
  } catch (err) {
    console.warn('[KE→KC] 同步失败:', err);
  }
}

/** 同步条目到 Markdown 文件 */
function syncToMd(entry: KnowledgeItem, remove = false): void {
  try {
    if (!existsSync(__MD_DIR)) mkdirSync(__MD_DIR, { recursive: true });
    const fname = entry.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().substring(0, 80) + '.md';
    const fpath = join(__MD_DIR, fname);
    if (remove) {
      if (existsSync(fpath)) unlinkSync(fpath);
      return;
    }
    const tags = Array.isArray(entry.tags) ? '\n' + entry.tags.map((t: string) => `  - "${t}"`).join('\n') : '';
    const frontmatter = `---
id: "${entry.id}"
title: "${entry.title}"
type: "${entry.source_type}"
source_type: "${entry.source_type}"
created_at: "${entry.created_at}"
updated_at: "${entry.updated_at}"
${entry.source_name ? `source_name: "${entry.source_name}"\n` : ''}${entry.file_size ? `file_size: ${entry.file_size}\n` : ''}${tags ? `tags:${tags}\n` : ''}---\n\n`;
    writeFileSync(fpath, frontmatter + (entry.content || ''), 'utf-8');
  } catch (err) {
    console.warn('[KE→MD] 同步失败:', err);
  }
}

// ── 模块级单例（跨多次 createKnowledgeEngine 调用持久化） ──
// P2 ✅ 已切换: @zvec/zvec 0.5.0 C++ N-API — HNSW + COSINE + WAL
import { getZvecAdapter, type IZvecAdapter } from '../../m2/ZvecAdapter.js';
import { FtsSearch } from './FtsSearch.js';
import { Reranker } from './Reranker.js';
import { AutoClassifier } from '../learning/AutoClassifier.js';
import { EmotionMatcher } from './EmotionMatcher.js';
import { KnowledgeRelationGraph } from '../learning/KnowledgeRelationGraph.js';
import { EnhancedKnowledgeGraph } from '../learning/EnhancedKnowledgeGraph.js';
import { AutoEnhancer } from './AutoEnhancer.js';
import { DedupService } from './DedupService.js';
import { ImpressionModel } from '../learning/ImpressionModel.js';
import { RetrieverCircuitBreaker } from './RetrieverCircuitBreaker.js';
let _zvecAdapter: IZvecAdapter | null = null;
async function ensureZvecReady(): Promise<IZvecAdapter> {
  if (!_zvecAdapter) {
    _zvecAdapter = getZvecAdapter();
    await _zvecAdapter.init();
  }
  return _zvecAdapter;
}
/** P2: 检索缓存（30秒TTL） */
const searchCache = new LocalCache<string, KnowledgeItem[]>({ ttlMs: 30_000, namespace: 'kb_search' });
const embedProvider = createLocalEmbedding();
let _indexReady = false;

function rowToEntry(r: Record<string, any>): KnowledgeItem {
  return {
    id: r.id as string,
    title: r.title as string,
    content: r.content as string,
    source_type: r.source_type as string,
    source_name: r.source_name as string | null,
    file_size: r.file_size as number,
    tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags ?? []),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    locked: r.locked === 1 || r.locked === true,
    classification: r.classification as string | undefined,
    classification_pending: r.classification_pending === 1 || r.classification_pending === true,
    dna_id: r.dna_id as string | undefined,
    scene_tags: r.scene_tags as string | undefined,
    interaction_type: r.interaction_type as string | undefined,
    emotion_vector: r.emotion_vector as string | undefined,
  };
}

/** 确保向量索引已加载（懒加载，轻量模式跳过） */
async function ensureIndex(sqlite: SQLiteAdapter): Promise<void> {
  if (_indexReady) return;
  if (ConfigService.getBool("TIANQUAN_LITE")) { _indexReady = true; return; }
  try {
    const rows = sqlite.queryAll(
      `SELECT id, kn_id, chunk_text, embedding FROM knowledge_chunks WHERE embedding IS NOT NULL LIMIT 5000`,
    );
    for (const row of rows) {
      const emb = row.embedding as string;
      if (emb) {
        try {
          (await ensureZvecReady()).upsert(row.id as string, JSON.parse(emb));
        } catch (err) { console.warn("[KE] embedding损坏:", err); }
      }
    }
    console.log(`[KnowledgeEngine] 向量索引已加载: ${rows.length} 个分块`);
  } catch (err) {
    console.warn('[KnowledgeEngine] 向量索引加载失败（首次运行正常）:', err);
  }
  _indexReady = true;
}

/** 为一个知识条目创建分块 + 嵌入 + 索引 */
async function indexContent(
  sqlite: SQLiteAdapter,
  knId: string,
  content: string,
): Promise<void> {
  await ensureIndex(sqlite);
  if (ConfigService.getBool("TIANQUAN_LITE")) return; // 轻量模式跳过向量索引
  const chunkResult = fileChunker.chunkWithSummary({ text: content, source: knId });
  if (chunkResult.chunks.length === 0) return;

  // 清除旧分块
  sqlite.writeRaw(`DELETE FROM knowledge_chunks WHERE kn_id = ?`, knId);
  const store = await ensureZvecReady();
  const removed = await store.removeByPrefix(knId);

  // P0: 批量嵌入 — 减少 API 调用次数
  const chunkTexts = chunkResult.chunks.map(function(c) { return c.content; });
  const embeddings = embedProvider.isAvailable() ? await embedProvider.embedBatch(chunkTexts).catch(function() { return []; }) : [];

  for (let ci = 0; ci < chunkResult.chunks.length; ci++) {
    const chunk = chunkResult.chunks[ci];
    const chunkId = `${knId}_${chunk.index}`;
    const embedding = embeddings[ci] || [];

    // 存 SQLite
    sqlite.writeRaw(
      `INSERT OR REPLACE INTO knowledge_chunks (id, kn_id, chunk_index, chunk_text, embedding)
       VALUES (?, ?, ?, ?, ?)`,
      chunkId, knId, chunk.index, chunk.content,
      embedding.length > 0 ? JSON.stringify(embedding) : null,
    );

    // 存向量索引
    if (embedding.length > 0) {
      (await ensureZvecReady()).upsert(chunkId, embedding);
    }
  }
}

export function createKnowledgeEngine(sqlite: SQLiteAdapter) {
  /**
   * 修复双重 UTF-8 编码的中文字符串
   * 如: "ã€Šæˆ€æ¢¦å›­" -> "《恋梦园"
   * 检测方式: 将字符串每个字符当作字节重新解码为 UTF-8，
   * 如果结果包含有效中文则使用修复后版本。
   */
  function fixDoubleEncoded(str: string): string {
    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      // 如果已有合法中文（>U+4E00），说明是正常字符串，无需修复
      if (code >= 0x4E00 && code <= 0x9FA5) return str;
      bytes.push(code);
    }
    try {
      const fixed = Buffer.from(bytes).toString('utf-8');
      // 验证修复后是否包含中文字符
      for (let i = 0; i < fixed.length; i++) {
        const c = fixed.charCodeAt(i);
        if (c >= 0x4E00 && c <= 0x9FA5) return fixed;
        if (c === 0x300A || c === 0x300B) return fixed; // 《》
      }
    } catch (e: any) { console.error('[KnowledgeEngine] error:', e?.message); }
    return str; // 无法修复，返回原字符串
  }

  /** 新增（自动分块 + 嵌入 + 情绪关联 + 交互分类） */
  async function add(params: {
    title: string;
    content: string;
    source_type?: string;
    source_name?: string;
    file_size?: number;
    tags?: string[];
    /** 关联的情绪上下文（pleasure, arousal, intimacy 等关键维度） */
    emotionalContext?: { pleasure: number; arousal: number; intimacy: number };
    /** 知识分类（铁律：无分类不检索 — 不传则标记为待分类） */
    classification?: string;
    /** P0: 关联的 M1 DNA ID */
    dna_id?: string;
    /** P0: 关联场景标签（逗号分隔或数组） */
    scene_tags?: string | string[];
    /** P0: 交互型分类 */
    interaction_type?: string;
    /** P0: 情感曲谱（24D 感知向量 JSON） */
    emotion_vector?: string;
  }): Promise<KnowledgeItem> {
    // 🔴 隐私守卫：拒绝个人/用户信息进入知识库
    const _privacyPatterns = /^用户信息[:：]|^用户地址[:：]|^用户偏好[:：]|^用户厌恶[:：]|^习惯[:：]|^喜好[:：]|^重点关注[:：]|^待查询[:：]|^回忆[:：]|^研究[:：]|徐诗雨身高|梓铭简介|我的名字是|我的女友|我的工作|我的老婆|我的这根|我在哪个公园|我在哪家公司|我在外面|我在问你在哪里|我在深圳市|我把一切|我家里面|我在他们面/;
    if (_privacyPatterns.test(params.title) || _privacyPatterns.test(params.content || '')) {
      console.warn(`[KE] 🔴 隐私守卫拦截: "${(params.title||'').substring(0,40)}" — 用户个人信息不得进入知识库`);
      throw new Error('隐私内容不可存入知识库：用户个人信息应存于 MasterProfileService 或 FamilyGraph');
    }

    // 修复双重UTF-8编码（浏览器上传时可能出现的文件名编码问题）
    const fixedTitle = fixDoubleEncoded(params.title);
    const fixedContent = params.content ? fixDoubleEncoded(params.content) : params.content;

    // 🔥 FTS BM25 模糊去重：标题或内容高度相似则跳过
    if (_ftsInitialized && fixedTitle.length >= 4) {
      try {
        const dupResults = _ftsSearch.search(fixedTitle, 1);
        if (dupResults.length > 0 && dupResults[0].score > 2.5) {
          const dup = dupResults[0];
          console.log('[KE-Dedup] FTS命中重复: "' + fixedTitle.substring(0, 20) + '" ≈ "' + dup.title.substring(0, 20) + '" (score=' + dup.score.toFixed(2) + '), 跳过新增');
          throw new Error('DEDUP_SKIP');
        }
      } catch (err: any) {
        if (err.message === 'DEDUP_SKIP') throw err;
        /* FTS 未就绪时跳过去重 */
      }
    }

    // 🔥 生成 23 字符 GlobalUID (类型标记 WK=知识条目)
    const _kbSeq = (Date.now() % 65535) || 1;
    const id = DNAEncoder.generateGlobalUID('WK', _kbSeq, 0, '');
    const now = new Date().toISOString();
    const allTags = [...(params.tags ?? [])];
    if (params.emotionalContext) {
      const e = params.emotionalContext;
      allTags.push(`emotion:p${e.pleasure.toFixed(2)}_a${e.arousal.toFixed(2)}_i${e.intimacy.toFixed(2)}`);
    }
    // 无分类标记为待分类
    const hasClassification = !!params.classification;
    const classification = params.classification || null;
    const classificationPending = hasClassification ? 0 : 1;

    // 标准化 scene_tags
    const sceneTagsStr = Array.isArray(params.scene_tags)
      ? params.scene_tags.join(',')
      : (params.scene_tags ?? null);

    const entry: KnowledgeItem = {
      id, title: fixedTitle, content: fixedContent,
      source_type: params.source_type ?? 'text', source_name: params.source_name ?? null,
      file_size: params.file_size ?? 0, tags: allTags,
      created_at: now, updated_at: now, locked: false,
      classification: classification || undefined,
      classification_pending: !hasClassification,
      dna_id: params.dna_id,
      scene_tags: sceneTagsStr ?? undefined,
      interaction_type: params.interaction_type ?? 'other',
      emotion_vector: params.emotion_vector,
    };
    sqlite.writeRaw(
      `INSERT INTO knowledge_base (id, title, content, source_type, source_name, file_size, tags, created_at, updated_at, locked, classification, classification_pending, dna_id, scene_tags, interaction_type, emotion_vector)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id, entry.title, entry.content, entry.source_type,
      entry.source_name, entry.file_size, JSON.stringify(entry.tags),
      entry.created_at, entry.updated_at, entry.locked ? 1 : 0,
      classification, classificationPending ? 1 : 0,
      entry.dna_id ?? null, entry.scene_tags ?? null,
      entry.interaction_type ?? 'other', entry.emotion_vector ?? null,
    );

    // 异步分块 + 嵌入（不阻塞返回）
    syncToCabinet(entry);
    syncToMd(entry);
    indexContent(sqlite, id, fixedContent).catch(err =>
      console.warn(`[KnowledgeEngine] 索引失败 ${id}:`, err),
    );


    // 🔥 AutoClassifier: 自动分类新知识
    if (!params.classification) {
      (async () => {
        const clsResult = await _autoClassifier.classify(fixedTitle, fixedContent);
        if (clsResult.autoApproved && clsResult.classification) {
          sqlite.writeRaw('UPDATE knowledge_base SET classification = ?, classification_pending = 0 WHERE id = ?', [clsResult.classification, id]);
          console.log('[AutoClassifier] 自动分类: ' + clsResult.classification + ' ← ' + fixedTitle.substring(0, 20));
        }
      })().catch(() => {});
    }
    // 🔥 写入寻址链: 知识新增时记录到 atom_address_timeline
    try {
      const _ts = Date.now();
      const _stampBlob = JSON.stringify([{
        workshop: 'KB', operation: 'CREATE', phase_id: 'ingestion', node_id: 'KnowledgeEngine',
        timestamp: Math.floor(_ts / 1000), detail: 'knowledge_add',
      }]);
      sqlite.writeRaw(
        `INSERT OR REPLACE INTO atom_address_timeline (global_uid, global_time_seq, absolute_timestamp, time_slice_tag, entity_belong_id, route_stamp_list, hot_cold_level, crc_checksum, state_flag, created_at) VALUES (?, ?, ?, ?, ?, ?, 'W', ?, 'N', unixepoch())`,
        id, _kbSeq, _ts, now.substring(0, 7), params.dna_id || null, _stampBlob,
        require('node:crypto').createHash('sha256').update(`${id}:${_kbSeq}`).digest('hex').substring(0, 16),
      );
    } catch (_e) { /* 寻址链写入失败不阻塞 */ }

    return entry;
  }

  /** 列表 */
  function list(limit = 50): KnowledgeItem[] {
    return sqlite.queryAll(
      `SELECT * FROM knowledge_base ORDER BY created_at DESC LIMIT ?`, [limit],
    ).map(rowToEntry);
  }

  /** 按 ID 查询 */
  function getById(id: string): KnowledgeItem | null {
    const rows = sqlite.queryAll(`SELECT * FROM knowledge_base WHERE id = ? LIMIT 1`, [id]);
    return rows.length > 0 ? rowToEntry(rows[0]) : null;
  }

  /** 更新（重新分块 + 嵌入）
   *  🔴 防线④: 更新内容同样需要经过亲密守卫（防止先创建再绕过）
   */
  async function update(id: string, params: {
    title?: string; content?: string; tags?: string[]; locked?: boolean;
  }): Promise<boolean> {
    const existing = getById(id);
    if (!existing || existing.locked) return false;
    const newTitle = params.title ? fixDoubleEncoded(params.title) : existing.title;
    const newContent = params.content ? fixDoubleEncoded(params.content) : existing.content;
    const now = new Date().toISOString();
    sqlite.writeRaw(
      `UPDATE knowledge_base SET title=?, content=?, tags=?, locked=?, updated_at=? WHERE id=?`,
      newTitle, newContent,
      JSON.stringify(params.tags ?? existing.tags),
      (params.locked ?? existing.locked) ? 1 : 0, now, id,
    );
    // 同步到 Markdown 文件
    const updated = { ...existing, ...params, updated_at: now, tags: params.tags ?? existing.tags };
    syncToCabinet(updated);
    syncToMd(updated);
    // 内容变了就重新索引
    if (params.content && params.content !== existing.content) {
      indexContent(sqlite, id, params.content).catch(() => {});
    }
    return true;
  }

  /** 删除（同时清理索引 + MD 文件） */
  async function remove(id: string): Promise<boolean> {
    const existing = getById(id);
    if (!existing) return false;
    syncToCabinet(existing, true);
    syncToMd(existing, true);
    sqlite.writeRaw(`DELETE FROM knowledge_base WHERE id=?`, id);
    sqlite.writeRaw(`DELETE FROM knowledge_chunks WHERE kn_id=?`, id);
    const zvs = await ensureZvecReady();
    zvs.removeByPrefix(id).catch(() => {});
    return true;
  }

  /** 🔥 FTS5 + RRF 混合检索（取代旧 LIKE+hybrid 路径） */
  // BM25 参数可通过环境变量配置（不设则用默认值 k1=1.5, b=0.75）
  const _bm25k1 = parseFloat(process.env['KB_BM25_K1'] || '') || 1.5;
  const _bm25b = parseFloat(process.env['KB_BM25_B'] || '') || 0.75;
  const _ftsSearch = new FtsSearch(sqlite, { k1: _bm25k1, b: _bm25b });
  const _reranker = new Reranker();
  const _autoClassifier = new AutoClassifier(sqlite);
  const _emotionMatcher = new EmotionMatcher();
  // 🔥 加载持久化情感权重（engine_store），首次启动用默认值
  _emotionMatcher.loadWeights(sqlite).catch(() => {});
  const _knowledgeGraph = new KnowledgeRelationGraph(sqlite);
  const _enhancedKG = new EnhancedKnowledgeGraph(sqlite);
  const _autoEnhancer = new AutoEnhancer(sqlite, _enhancedKG);
  const _dedupService = new DedupService();
  const _impressionModel = new ImpressionModel();
  const _retrieverBreaker = new RetrieverCircuitBreaker('knowledge_fts', { timeoutMs: 3000 });
  let _ftsInitialized = false;
  let _emotionSearchCount = 0;  // 🔥 情感检索计数，每20次持久化一次权重
  _ftsSearch.init().then(() => { _ftsInitialized = true; }).catch(() => {});

  async function search(keyword: string, limit = 10, emotionalContext?: { pleasure: number; arousal: number; intimacy: number }, interactionType?: string): Promise<KnowledgeItem[]> {
    const ftsSearch = async (kw: string, lim: number) => {
      if (_ftsInitialized) {
        const ftsResults = await _retrieverBreaker.call(
          async () => _ftsSearch.search(kw, lim * 2),
          async () => {
            const like = '%' + kw + '%';
            return sqlite.queryAll('SELECT id, title, content, classification FROM knowledge_base WHERE content LIKE ? OR title LIKE ? ORDER BY updated_at DESC LIMIT ?', [like, like, lim * 2]).map((r: any) => ({ id: r.id, title: r.title, content: r.content, classification: r.classification, score: 0.5 }));
          }
        );
        if (ftsResults.length > 0) {
          return ftsResults.map((r: any) => ({
            id: r.id, title: r.title, content: r.content,
            source_type: '', source_name: null, file_size: 0,
            tags: [], created_at: '', updated_at: '',
            locked: false, classification: r.classification || undefined,
          } as KnowledgeItem));
        }
      }
      // FTS5 降级 → LIKE
      let sql = `SELECT * FROM knowledge_base WHERE (content LIKE ? OR title LIKE ?)`;
      const params: any[] = [`%${kw}%`, `%${kw}%`];
      if (interactionType) { sql += ` AND interaction_type = ?`; params.push(interactionType); }
      sql += ` ORDER BY updated_at DESC LIMIT ?`; params.push(lim);
      return sqlite.queryAll(sql, params).map(rowToEntry);
    };

    const trimmed = keyword.trim();
    if (!trimmed) {
      const rows = sqlite.queryAll(`SELECT * FROM knowledge_base ORDER BY updated_at DESC LIMIT ?`, [limit]);
      return rows.map(rowToEntry);
    }

    const cacheKey = trimmed + '_' + (interactionType || '') + '_' + limit;
    const cached = await searchCache.get(cacheKey);
    if (cached) { return cached; }

    // 1. FTS5 BM25 搜索（主路径）
    let results: KnowledgeItem[] = await ftsSearch(trimmed, limit);

    // 2. FTS5 无结果 → 拆中文词
    if (results.length === 0) {
      const words = trimmed.match(/[一-龥]{2,4}/g);
      if (words) {
        for (const word of [...new Set<string>(words)]) {
          const sub = await ftsSearch(word, limit);
          if (sub.length > 0) { results = sub; break; }
        }
      }
    }

    // 3. RRF 融合: FTS + Zvec 向量（FTS 无结果时尝试向量兜底）
    const zvs = await ensureZvecReady();
    if (embedProvider.isAvailable() && zvs.size > 0) {
      try {
        await ensureIndex(sqlite);
        const vecResults = await hybridSearch(trimmed, embedProvider, zvs as any, (kw: string, lim: number) => { const like = '%' + kw + '%'; return sqlite.queryAll('SELECT * FROM knowledge_base WHERE content LIKE ? OR title LIKE ? ORDER BY updated_at DESC LIMIT ?', [like, like, lim]).map(rowToEntry); }, limit, emotionalContext);
        if (vecResults.length > 0) {
          const fused = _reranker.rrfFuse([
            { items: results.map(r => ({ ...r, matchScore: 0.5, source: 'fts' as const })), source: 'fts' },
            { items: vecResults.map(r => ({ ...(r as any), matchScore: (r as any).matchScore || 0.5, source: 'vector' as const })), source: 'vector' },
          ], limit);
          results = fused;
        }
      } catch { /* 降级到纯FTS */ }
    }

    // 🔥 EmotionMatcher: 情感感知重排序
    if (results.length > 0 && emotionalContext) {
      const emotionBoosted = _emotionMatcher.rerank(results, emotionalContext);
      results = emotionBoosted;
    }

    // 🔥 KnowledgeRelationGraph: 建立共召关联
    if (results.length >= 2) {
      const ids = results.slice(0, 5).map(r => r.id).filter(Boolean);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          _knowledgeGraph.onCoRetrieved(ids[i], ids[j]).catch(() => {});
        }
      }
    }

    // 🔥 ImpressionModel: 更新被召回知识的印象值
    for (const r of results.slice(0, 5)) {
      try {
        const existing = sqlite.queryAll('SELECT impression_score, recall_count FROM knowledge_base WHERE id = ?', [r.id]);
        if (existing.length > 0) {
          const curScore = (existing[0] as any).impression_score ?? 0.5;
          const recallCount = (existing[0] as any).recall_count ?? 0;
          const newScore = _impressionModel.onRecalled(curScore, recallCount + 1);
          sqlite.writeRaw('UPDATE knowledge_base SET impression_score = ?, recall_count = COALESCE(recall_count, 0) + 1, last_recalled_at = ? WHERE id = ?', [newScore, new Date().toISOString(), r.id]);
        }
      } catch (e) { console.warn(`[KnowledgeEngine] 操作失败`, (e as Error)?.message || e); } /* 印象值更新不阻塞 */
    }

    searchCache.set(cacheKey, [...results]).catch(() => {});
    if (results.length > 0) {
      console.log('[KB] FTS检索: ' + trimmed.substring(0,20) + ' → ' + results.length + '条 (情感增强=' + (emotionalContext ? 'on' : 'off') + ')');
    }
    // 🔥 概率持久化情感权重（每20次检索持久化一次，降低IO）
    if (emotionalContext) {
      _emotionSearchCount++;
      if (_emotionSearchCount % 20 === 0) {
        _emotionMatcher.saveWeights(sqlite).catch(() => {});
      }
    }
    return results.slice(0, limit);
  }

  /** 计数 */
  function count(): number {
    const rows = sqlite.queryAll(`SELECT COUNT(*) as cnt FROM knowledge_base`);
    return rows.length > 0 ? (rows[0].cnt as number) : 0;
  }

  /** 文件上传并入库 */
  async function upload(
    buffer: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<KnowledgeItem> {
    const parsed = await parseFile(buffer, mimeType, fileName);
    return add({
      title: parsed.title,
      content: parsed.content,
      source_type: parsed.source_type,
      source_name: parsed.source_name,
      file_size: parsed.file_size,
      tags: [`source:${parsed.source_type}`],
    });
  }

  /** 强制重新索引所有已有知识条目（维护用） */
  async function reindexAll(): Promise<number> {
    await ensureIndex(sqlite);
    const all = list(500);
    let indexed = 0;
    for (const item of all) {
      await indexContent(sqlite, item.id, item.content);
      indexed++;
    }
    console.log(`[KnowledgeEngine] 重新索引完成: ${indexed} 条`);
    return indexed;
  }

  /** 向量搜索调试（返回原始分块匹配） */
  async function vectorSearchDebug(queryVec: number[], topK = 5): Promise<Array<{
    chunkId: string; text: string; score: number; knId: string;
  }>> {
    const zvs = await ensureZvecReady();
    const hits = await zvs.search(queryVec, topK);
    const results: Array<{ chunkId: string; text: string; score: number; knId: string }> = [];
    for (const hit of hits) {
      const rows = sqlite.queryAll(`SELECT kn_id, chunk_text FROM knowledge_chunks WHERE id = ?`, [hit.id]);
      if (rows.length > 0) {
        results.push({
          chunkId: hit.id,
          knId: rows[0].kn_id as string,
          text: (rows[0].chunk_text as string).substring(0, 100),
          score: hit.score,
        });
      }
    }
    return results;
  }

  /** 按场景标签检索知识（优先匹配 interaction_type + scene_tags） */
  function searchByScene(sceneTags: string[], limit = 5, emotionType?: string): KnowledgeItem[] {
    if (!sceneTags.length) return [];
    const conditions = sceneTags.map(() => `scene_tags LIKE ?`).join(' OR ');
    const params: any[] = sceneTags.map(t => `%${t}%`);
    let sql = `SELECT * FROM knowledge_base WHERE (${conditions}) AND classification_pending = 0`;
    if (emotionType) {
      sql += ` ORDER BY CASE WHEN tags LIKE ? THEN 0 ELSE 1 END, updated_at DESC LIMIT ?`;
      params.unshift(`%${emotionType}%`);
    } else {
      sql += ` ORDER BY updated_at DESC LIMIT ?`;
    }
    params.push(limit);
    return sqlite.queryAll(sql, params).map(rowToEntry);
  }

  // ─── 辅助：计算两个逗号分隔的 scene_tags 字符串的 Jaccard 相似度 ───
  function jaccardScene(a: string | null | undefined, b: string[]): number {
    if (!a || !b.length) return 0;
    const setA = new Set(a.split(',').map(s => s.trim()).filter(Boolean));
    if (!setA.size) return 0;
    const setB = new Set(b.map(s => s.trim()).filter(Boolean));
    let intersection = 0;
    for (const tag of setA) if (setB.has(tag)) intersection++;
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
  }

  // ─── 辅助：解析 emotion_vector JSON → number[] ───
  function parseEmotionVector(ev: string | null | undefined): number[] | null {
    if (!ev) return null;
    try { const arr = JSON.parse(ev); return Array.isArray(arr) ? arr : null; } catch { return null; }
  }

  // ─── 辅助：计算两个 24D 向量的余弦相似度 ───
  function cosineSimilarity(a: number[], b: Perception24D | { pleasure: number; arousal: number; intimacy: number }): number {
    // 从 Perception24D 提取关键维度做向量 (pleasure, arousal, dominance, intimacy, sexual_attraction, safety)
    const bVec = [b.pleasure ?? 0, b.arousal ?? 0, (b as any).dominance ?? 0, b.intimacy ?? 0, (b as any).sexual_attraction ?? 0, (b as any).safety ?? 0.5];
    const aLen = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const bLen = Math.sqrt(bVec.reduce((s, v) => s + v * v, 0));
    if (aLen === 0 || bLen === 0) return 0;
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, bVec.length); i++) dot += a[i] * bVec[i];
    return dot / (aLen * bLen);
  }

  // ─── 根据内容关键词估算 24D 情感向量（初始化默认用） ───
  // cosineSimilarity 读取前6维: [pleasure, arousal, dominance, intimacy, sexual_attraction, safety]
  function estimateEmotionFromContent(title: string, content: string): number[] {
    // 🔴 内存保护：内容超过100KB只取前100KB做情感估算
    const safeContent = (content || '').substring(0, 100 * 1024);
    const text = (title + ' ' + safeContent).toLowerCase();
    let pleasure = 0, arousal = 0, dominance = 0, intimacy = 0;
    let sexual_attraction = 0, safety = 0.5;

    // 亲密信号
    if (/亲|爱|想|抱|吻|摸|操|屄|鸡巴|高潮|性|舒服/.test(text)) { intimacy += 0.6; sexual_attraction += 0.5; pleasure += 0.3; }
    if (/老婆|女朋友|男友|喜欢|爱/.test(text)) { intimacy += 0.3; pleasure += 0.3; }
    if (/可爱|漂亮|美|迷人/.test(text)) { pleasure += 0.3; sexual_attraction += 0.3; }

    // 愉悦信号
    if (/开心|快乐|舒服|爽|喜欢|幸福|高兴/.test(text)) pleasure += 0.5;
    if (/好|棒|赞|不错|完美/.test(text)) pleasure += 0.3;

    // 兴奋信号
    if (/兴奋|激动|刺激|紧张/.test(text)) arousal += 0.5;
    if (/期待|急|等不及/.test(text)) arousal += 0.3;

    // 负面
    if (/难过|伤心|哭|痛苦|烦|焦虑|害怕/.test(text)) { pleasure -= 0.3; safety -= 0.2; }
    if (/生病|感冒|失眠|药|医院/.test(text)) { safety -= 0.3; pleasure -= 0.2; }

    // 工作/事务（降低亲密提高 factual 系数，cosineSimilarity 没读 factual 所以降 intimacy）
    if (/工作|项目|客户|会议|方案|报告|数据|分析|文档|合同|预算|设计|策略/.test(text)) { intimacy = Math.max(0, intimacy - 0.3); pleasure = Math.max(0, pleasure - 0.1); dominance += 0.2; }

    // 安全/信任
    if (/家人|父母|老婆|老公|孩子|家/.test(text)) { safety += 0.2; intimacy += 0.2; }

    // 默认弱正面
    if (pleasure === 0 && arousal === 0 && intimacy === 0) {
      pleasure = 0.2; arousal = 0.1; intimacy = 0.1;
    }

    function clamp(v: number) { return Math.max(-1, Math.min(1, v)); }
    // 前6维：情感核心维度；后18维中性值 0.5（余弦相似度不误判为负相关）
    const NEUTRAL_18 = [0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5];
    return [
      clamp(pleasure), clamp(arousal), clamp(dominance), clamp(intimacy), clamp(sexual_attraction), clamp(safety),
      ...NEUTRAL_18,
    ];
  }

  /** 初始化所有无 emotion_vector 的知识条目（启动时调用一次） */
  function initKBEmotionVectors(): number {
    const rows = sqlite.queryAll(`SELECT id, title, content FROM knowledge_base WHERE emotion_vector IS NULL`);
    if (!rows.length) return 0;
    let count = 0;
    for (const row of rows) {
      try {
        const vec = estimateEmotionFromContent(row.title as string, row.content as string);
        sqlite.writeRaw(`UPDATE knowledge_base SET emotion_vector = ? WHERE id = ?`, JSON.stringify(vec), row.id as string);
        count++;
      } catch (_) { /* skip */ }
    }
    console.log(`[KB] 情感向量初始化: ${count}/${rows.length} 条`);
    return count;
  }

  /** 加权检索：场景标签 × 0.35 + 情感关联 × 0.25 + 文本相似度 × 0.2 + 印象 × 0.2
   *
   * ⚠ 修复: 三段降级 + 全量扫描保底 + 日志可见
   *
   * 阶段1 — 提取消息中所有 2~4 字中文词 + ASCII 词，逐词 LIKE，取并集
   * 阶段2 — 如果条数不够，全表扫描 + 情感+印象排序保底
   *
   * @param keyword 搜索关键词
   * @param sceneTags 当前场景标签列表
   * @param perception 当前情感感知（至少包含 pleasure/arousal/intimacy）
   * @param limit 最大返回条数
   */
  async function weightedSearch(
    keyword: string,
    sceneTags: string[],
    perception?: { pleasure: number; arousal: number; intimacy: number },
    limit = 5,
  ): Promise<Array<KnowledgeItem & { matchScore: number; breakdown: { scene: number; emotion: number; text: number } }>> {
    const trimmed = (keyword || '').trim();

    // ── 提取所有 2~3 字中文 ngram (滑动窗口) + 2+ 字母 ASCII 词 ──
    const chars: string[] = [];
    for (const ch of trimmed) {
      if (/[一-龥]/.test(ch)) chars.push(ch);
      else if (/[a-zA-Z]/.test(ch)) chars.push(ch.toLowerCase());
    }
    const ngramSet = new Set<string>();
    for (let i = 0; i < chars.length; i++) {
      if (i + 1 < chars.length) ngramSet.add(chars[i] + chars[i+1]);
      if (i + 2 < chars.length) ngramSet.add(chars[i] + chars[i+1] + chars[i+2]);
    }
    const enWords = trimmed.match(/[a-zA-Z]{2,}/g);
    if (enWords) { for (const w of enWords) ngramSet.add(w); }

    // ── 全表扫描 + ngram 文本评分 + 情感/场景/印象排序 ──
    const allRows: any[] = sqlite.queryAll(
      `SELECT * FROM knowledge_base ORDER BY COALESCE(impression_score,0.5) DESC, updated_at DESC LIMIT 50`
    );
    if (!allRows.length) {
      console.log('[KBw] 空库');
      return [];
    }

    // 逐条评分
    const maxHits = ngramSet.size || 1;
    const scored = allRows.map(row => {
      const item = rowToEntry(row);
      const isPending = !!(row as any).classification_pending;
      const combined = (item.title + ' ' + (item.content || '')).toLowerCase();

      // 文本匹配: ngram 命中数
      let hits = 0;
      for (const ng of ngramSet) {
        if (combined.includes(ng)) hits++;
      }
      const textScore = ngramSet.size > 0 ? Math.min(hits / maxHits, 1) : 0.5;

      // 场景匹配
      const sceneScore = jaccardScene(item.scene_tags, sceneTags);

      // 情感匹配
      let emotionScore = 0;
      if (perception) {
        const ev = parseEmotionVector(item.emotion_vector);
        if (ev) emotionScore = Math.max(0, cosineSimilarity(ev, perception));
        else emotionScore = 0.3;
      }

      const penalty = isPending ? 0.7 : 1.0;
      const impressionScore = item.impression_score || 0.5;
      let matchScore: number;
      if (textScore > 0) {
        matchScore = Math.round((textScore * 0.50 + impressionScore * 0.20 + sceneScore * 0.15 + emotionScore * 0.15) * penalty * 1000) / 1000;
      } else {
        matchScore = Math.round((emotionScore * 0.35 + impressionScore * 0.25 + sceneScore * 0.25 + textScore * 0.15) * penalty * 1000) / 1000;
      }


      return {
        ...item,
        matchScore,
        breakdown: {
          scene: Math.round(sceneScore * 1000) / 1000,
          emotion: Math.round(emotionScore * 1000) / 1000,
          text: Math.round(textScore * 1000) / 1000,
        },
      };
    });

    scored.sort((a, b) => b.matchScore - a.matchScore);

    // 印象值更新（最高分）
    if (scored.length > 0 && scored[0].id) {
      try {
        sqlite.writeRaw("UPDATE knowledge_base SET impression_score = MIN(1.0, COALESCE(impression_score, 0.5) + 0.05), last_recalled_at = ? WHERE id = ?",
          [new Date().toISOString(), scored[0].id]);
      } catch (_) { /* 不阻塞 */ }
    }

    // 日志（含匹配的ngram样本）
    if (scored.length > 0) {
      const t1 = scored[0];
      const matchedGrams = Array.from(ngramSet).filter(ng => (t1.title + ' ' + (t1.content || '')).toLowerCase().includes(ng));
      console.log('[KBw] top=' + t1.matchScore.toFixed(3) + '(s:' + t1.breakdown.scene.toFixed(2) + ' e:' + t1.breakdown.emotion.toFixed(2) + ' t:' + t1.breakdown.text.toFixed(2) + ') |' + (t1.title || '').substring(0, 24) + '| ng=[' + matchedGrams.slice(0, 5).join() + ']');
    }

    return scored.slice(0, limit);
  }

  // 启动时初始化情感向量
  console.log('[KB] 初始化情感向量...');
  initKBEmotionVectors();

  /** 按交互型分类检索知识 */
  function searchByInteraction(interactionType: string, limit = 10): KnowledgeItem[] {
    return sqlite.queryAll(
      `SELECT * FROM knowledge_base WHERE interaction_type = ? AND classification_pending = 0 ORDER BY updated_at DESC LIMIT ?`,
      [interactionType, limit],
    ).map(rowToEntry);
  }

  /** 更新知识分类（玉瑶反问用户后获得分类信息时调用） */
  async function updateClassification(id: string, classification: string): Promise<boolean> {
    const existing = getById(id);
    if (!existing) return false;
    sqlite.writeRaw(
      `UPDATE knowledge_base SET classification = ?, classification_pending = 0, updated_at = ? WHERE id = ?`,
      classification, new Date().toISOString(), id,
    );
    console.log(`[KE] 已分类: ${classification} → ${existing.title.substring(0, 30)}`);
    return true;
  }

  /** 获取所有待分类的知识条目（玉瑶据此生成反问） */
  function getUnclassified(limit = 10): KnowledgeItem[] {
    return sqlite.queryAll(
      `SELECT * FROM knowledge_base WHERE classification_pending = 1 ORDER BY created_at DESC LIMIT ?`, [limit],
    ).map(rowToEntry);
  }

  /** 获取创建时间超过指定天数仍未分类的条目（用于玉瑶隔几天提醒一次） */
  function getUnclassifiedOlderThan(days: number, limit = 5): KnowledgeItem[] {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return sqlite.queryAll(
      `SELECT * FROM knowledge_base WHERE classification_pending = 1 AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
      [cutoff, limit],
    ).map(rowToEntry);
  }

  /**
   * 彻底移除超过指定天数仍未分类的垃圾条目（铁律：3个月无分类视为垃圾）
   * 同时清理关联的 knowledge_chunks 和 knowledge_memories
   */
  function deleteExpiredUnclassified(maxAgeDays: number): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
    const expired = sqlite.queryAll(
      `SELECT id FROM knowledge_base WHERE classification_pending = 1 AND created_at < ?`,
      [cutoff],
    );
    const ids = expired.map((r: any) => r.id as string);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    sqlite.writeRaw(`DELETE FROM knowledge_chunks WHERE kn_id IN (${placeholders})`, ...ids);
    sqlite.writeRaw(`DELETE FROM knowledge_memories WHERE knowledge_id IN (${placeholders})`, ...ids);
    sqlite.writeRaw(`DELETE FROM knowledge_base WHERE id IN (${placeholders})`, ...ids);
    console.log(`[KE] 垃圾清理: 移除 ${ids.length} 条超过 ${maxAgeDays} 天未分类的知识条目`);
    return ids.length;
  }

  return {
    add, list, getById, update, delete: remove,
    search, count, upload, reindexAll,
    vectorSearchDebug, embedProvider, zvecAdapter: ensureZvecReady,
    updateClassification, getUnclassified,
    getUnclassifiedOlderThan, deleteExpiredUnclassified,
    searchByScene, searchByInteraction,
    weightedSearch,
  };
}
