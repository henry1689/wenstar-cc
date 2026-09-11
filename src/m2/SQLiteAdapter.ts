/**
 * SQLiteAdapter — SQLite 记忆存储封装
 *
 * 作为融合记忆系统的主存储引擎。
 * 使用 sql.js（纯 JS SQLite 实现，零原生依赖）。
 *
 * 遵循 `src/m4/FamilyGraph.ts` 中已建立的 sql.js 使用模式。
 */
// @ts-ignore - sql.js ships its own types
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSqlClause } from '../governance/police/UUIDPoliceFilter.js';
// 2026-09-11: 启动期 fg_entity_names 派生回填需与写入侧共用同一序列化格式
import { formatNames } from './EntityNameCodec.js';
// 🔴 FG-P0(2026-09-09): 实体写前统一合规闸门 — ensureEntity object 通道过滤垃圾(句子片段/外貌特征词不建独立实体)
import { checkEntityWrite } from '../m4/household/EntityWriteGate.js';
import type { Perception24D } from '../m3/types/perception.js';
import type { EntityGene } from '../m1/types/dna.js';
import type {
  EmotionalMemoryRecord,
  RetrievalQuery,
  ScoredMemory,
  EmotionalLandscape,
  InductionSummary,
  SimilarityMode,
} from './types/index.js';
import {
  computeCalcium,
  updateDynamics,
  recallBoost,
  reinforcementBoost,
} from './math.js';
import { MEMORY_CONFIG } from '../config/MemoryConfig.js';
import { computeL2Norm40D } from './PerceptionVector40DCodec.js';
import { decodePerceptionV40, encodePerceptionV40, map24DTo40D, cosineSimilarity40D, PERCEPTION_40D_ENCODING_VERSION, encodeEmptyPerceptionV40 } from './PerceptionVector40DCodec.js';
import type { PerceptionV40 } from './types/perception-40d.js';
import { PERCEPTION_40D_KEYS, createEmptyPerceptionV40 } from './types/perception-40d.js';
import { migrateSchema } from './MigrationManager.js';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_DB_PATH = join(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

interface SqlJsDatabase {
  run(sql: string, params?: any[]): void;
  exec(sql: string): Array<{
    columns: string[];
    values: any[][];
  }>;
  prepare(sql: string): SqlJsStatement;
  close(): void;
  export(): Uint8Array;
}

interface SqlJsStatement {
  bind(params?: any[]): void;
  step(): boolean;
  getAsObject(): any;
  free(): void;
}

/** 将 EntityGene[] 转为 JSON 字符串 */
function genesToJson(genes: EntityGene[]): string {
  return JSON.stringify(genes.map(g => ({
    name: g.name, type: g.type, allele: g.allele,
    phenotype: g.phenotype, knowledge_type: g.knowledge_type,
  })));
}

/** 从 JSON 字符串恢复 EntityGene[] */
function jsonToGenes(json: string): EntityGene[] {
  try { return JSON.parse(json); } catch (err) { console.warn('[SQLite] jsonToGenes解析失败:', err); return []; }
}

/** V12.4 阶段B: 解析 24D JSON（数组24元素 或 命名对象）→ Perception24D。解析失败返回中性 0.5。
 *  仅作 writeMemory 的 40D 派生源（24D 不再落库）。 */
const KEYS24_ORDER: (keyof Perception24D)[] = [
  'pleasure','arousal','dominance','aggression','sincerity','humor',
  'factual','logical','certainty','abstract','temporal_focus','self_ref',
  'intimacy','power_diff','dependency','moral_judgment','etiquette','belonging',
  'sexual_attraction','sensory_craving','energy_merge','possessiveness','ecstasy','safety',
];
function parsePerception24DJson(json: string | null | undefined): Perception24D {
  const neutral: Perception24D = {} as Perception24D;
  for (const k of KEYS24_ORDER) neutral[k] = 0.5;
  if (!json) return neutral;
  try {
    const p = JSON.parse(json);
    if (Array.isArray(p) && p.length === 24) {
      const o = {} as Record<string, number>;
      for (let i = 0; i < 24; i++) o[KEYS24_ORDER[i]] = Number(p[i]) || 0;
      return o as unknown as Perception24D;
    }
    if (p && typeof p === 'object') {
      const o = {} as Record<string, number>;
      for (const k of KEYS24_ORDER) o[k] = Number((p as Record<string, unknown>)[k]) || 0;
      return o as unknown as Perception24D;
    }
  } catch { /* 解析失败走中性 */ }
  return neutral;
}

/** V12.4 阶段B 根除24D: 40D → 24D 反解映射（仅 14 维可反解，与 MAP_24_TO_40 互逆）。
 *  🔴 边界铁律：40D 无槽位的 10 维（arousal/aggression/factual/logical/certainty/abstract/
 *      temporal_focus/power_diff/sensory_craving/ecstasy）无真实值，反解为中性 0.5。
 *      record.perception 仅供 M3 内部/下游读字段方使用，不落库、不再参与 24D 检索打分。 */
const REVERSE_MAP_40_TO_24: ReadonlyArray<{ dim40: number; key24: keyof Perception24D }> = [
  { dim40: 9, key24: 'self_ref' }, { dim40: 12, key24: 'pleasure' }, { dim40: 14, key24: 'safety' },
  { dim40: 15, key24: 'intimacy' }, { dim40: 17, key24: 'belonging' }, { dim40: 19, key24: 'etiquette' },
  { dim40: 33, key24: 'sexual_attraction' }, { dim40: 34, key24: 'energy_merge' },
  { dim40: 35, key24: 'sincerity' }, { dim40: 36, key24: 'dominance' },
  { dim40: 37, key24: 'moral_judgment' }, { dim40: 38, key24: 'humor' },
  { dim40: 39, key24: 'dependency' }, { dim40: 40, key24: 'possessiveness' },
];
function perceptionV40To24D(p40: PerceptionV40 | null): Perception24D {
  const neutral: Perception24D = {} as Perception24D;
  for (const k of KEYS24_ORDER) neutral[k] = 0.5;
  if (!p40) return neutral;
  for (const { dim40, key24 } of REVERSE_MAP_40_TO_24) {
    const v = p40[PERCEPTION_40D_KEYS[dim40 - 1]];
    if (typeof v === 'number' && isFinite(v)) neutral[key24] = v;
  }
  return neutral;
}

/**
 * D8 根治（2026-09-11）: memories 覆盖写「身份/归属关键列」单一事实源。
 *
 * 背景：memories 表存在多处 `INSERT OR REPLACE`，而 REPLACE = DELETE + INSERT ——
 * 未列入 column list 的列会被静默重置为 NULL（不报错、不告警）。
 * 历史实证：`writeMemory()` 的列清单漏了 `fg_entity_names`，导致全库 2012 条该列恒为 NULL；
 * 而同路径 `entity_genes` 却保留了 362 条 —— 正是「列缺失」而非「未赋值」的铁证。
 *
 * 本清单是这类字段的唯一权威定义：任何 memories 覆盖写路径都必须携带。
 *
 * ❗ 刻意的范围边界（S4 评审 P2-7）: 本清单只保护「身份/归属类」6 列。
 *   未纳入的列（如 recall_count / promoted_to_diamond / effective_strength，
 *   在 writeMemory 的 VALUES 里仍是硬编码字面量 0/0/1.0）今日不可达——
 *   因为 writeMemory 的 id 是每轮随机的 mem_*，不会 REPLACE 到同一行；
 *   但这意味着守卫抓不到「REPLACE 抹掉召回/晋升计数」類型的未来回归。
 *   若写入语义变为「可重复写同一 id」，必须把这几列一并纳入。
 */
export const MEMORY_IDENTITY_CRITICAL_COLUMNS = [
  'dna_root_id',
  'entity_genes',
  'fg_entity_names',
  'global_uid',
  'belong_entity_uuid',
  'location_fingerprint',
] as const;

/** 返回 columnList 中缺失的关键列（纯函数，供守卫与单测复用） */
export function missingMemoryCriticalColumns(columnList: readonly string[]): string[] {
  const present = new Set(columnList.map((c) => c.trim()));
  return MEMORY_IDENTITY_CRITICAL_COLUMNS.filter((c) => !present.has(c));
}

/**
 * 从 INSERT 语句文本中提取 column list（纯函数）。
 * 仅识别首对圆括号，兼容 `INSERT [OR REPLACE] INTO <table> (c1, c2, ...)`。
 */
export function extractInsertColumns(sql: string): string[] {
  const m = /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+[`"\w]+\s*\(([^)]*)\)/i.exec(sql);
  if (!m) return [];
  return m[1]
    .split(',')
    // 拼接式 SQL 字符串会产生 `" +\n "locus_path` 这类 token → 剥引号与加号（S4 评审 P2-2 噪音项）
    .map((s) => s.replace(/["'`+]/g, '').trim())
    .filter(Boolean);
}

export class SQLiteAdapter {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;

  /** 获取 sql.js 原始实例 — 供 DualHelixWriter 底层写入使用 */
  get rawDb(): SqlJsDatabase | null { return this.db; }
  private ready = false;
  private blackDiamondFtsReady = false;
  /**
   * 防抖合并落盘：export() 会序列化整个内存库（当前 ~96MB），不能每次写入都落盘。
   * 策略：一轮对话内的多次写入（消息×2 + 对话组锚点/碎片/黑钻 ~10 次）合并为一次 export。
   * - _FLUSH_INTERVAL：首次写入后 150ms 内的写入合并落盘（崩溃丢失窗口 ~150ms，远小于旧的 2s）
   * - _FLUSH_BATCH：硬上限，仅当同步突发写入积压过多时才强制立即落盘（兜底，避免内存无界）
   *
   * P0-3 加固：
   * - flushNow() 公开强制落盘（替代旧私有 flush()）
   * - shutdownFlush() 关闭前清除定时器 + 强制落盘 + 关闭数据库
   * - close() 增强：落盘前清定时器，确保不丢数据
   */
  private _dirtyCount = 0;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _FLUSH_BATCH = 50;  // 硬上限：突发积压超过 50 次才强制同步落盘
  private readonly _FLUSH_INTERVAL = 150; // 防抖窗口：150ms 内的写入合并为一次落盘

  /** P5: 热点查询缓存（2秒 TTL） */
  private _queryCache = new Map<string, { result: any; expiresAt: number }>();
  private readonly _CACHE_TTL_MS = 2000;

  private _cacheGet<T>(key: string): T | null {
    const entry = this._queryCache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.result as T;
    this._queryCache.delete(key);
    return null;
  }

  private _cacheSet(key: string, result: any, ttlMs: number = this._CACHE_TTL_MS): void {
    this._queryCache.set(key, { result, expiresAt: Date.now() + ttlMs });
    if (this._queryCache.size > 50) {
      const now = Date.now();
      for (const [k, v] of this._queryCache) {
        if (v.expiresAt <= now) this._queryCache.delete(k);
      }
    }
  }

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? DEFAULT_DB_PATH;
  }

  async initialize(): Promise<void> {
    // @ts-ignore
    const SQL = await initSqlJs();
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer) as unknown as SqlJsDatabase;
    } else {
      this.db = new SQL.Database() as unknown as SqlJsDatabase;
    }

    // ⚠️ 迁移必须在 DDL 之前执行：旧数据库缺少新列时，schema.sql 中的
    //    CREATE INDEX IF NOT EXISTS ... ON memories(source_type) 会因列不存在而 crash
    // V4.0: source_type 列（新库 DDL 中已有，旧库需迁移补列）
    try { this.db.run("ALTER TABLE memories ADD COLUMN source_type TEXT DEFAULT 'conversation'"); } catch { /* 列已存在 */ }
    // V4.0: black_diamond 增强字段
    try { this.db.run("ALTER TABLE black_diamond ADD COLUMN entry_channel TEXT DEFAULT 'auto'"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE black_diamond ADD COLUMN entry_reason TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE black_diamond ADD COLUMN stabilization_score REAL DEFAULT 1.0"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE black_diamond ADD COLUMN manual_quota_consumed INTEGER DEFAULT 0"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE black_diamond ADD COLUMN status TEXT DEFAULT 'active'"); } catch { /* 列已存在 */ }

    // 旧列迁移（V4.0 新列已在上方处理）
    try { this.db.run("ALTER TABLE memories ADD COLUMN vad_spectrum TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN primary_emotion TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN secondary_emotions TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN promoted_to_diamond INTEGER DEFAULT 0"); } catch { /* 列已存在 */ }

    // 执行 DDL（在补全所有列之后，保证 CREATE INDEX 不会因缺列而崩溃）
    const ddl = readFileSync(SCHEMA_PATH, 'utf-8');
    this.db.run(ddl);

    // 索引迁移：emotion 列可能在新库中已在 DDL 中创建，旧库需通过迁移创建
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_memories_emotion ON memories(primary_emotion)"); } catch { /* 列不存在或索引已存在 */ }

    // 迁移：知识库分类字段（铁律 — 无分类不检索）
    try { this.db.run("ALTER TABLE knowledge_base ADD COLUMN classification TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE knowledge_base ADD COLUMN classification_pending INTEGER DEFAULT 1"); } catch { /* 列已存在 */ }

    // 🔧 V10.1: 知识库印象分+召回计数（ImpressionModel 运行时更新）
    try { this.db.run("ALTER TABLE knowledge_base ADD COLUMN impression_score REAL DEFAULT 0.5"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE knowledge_base ADD COLUMN recall_count INTEGER DEFAULT 0"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE knowledge_base ADD COLUMN last_recalled_at TEXT"); } catch { /* 列已存在 */ }

    // 🔧 V10.4: memories 实体归属标注
    try { this.db.run("ALTER TABLE memories ADD COLUMN belong_entity_uuid TEXT"); } catch { /* 列已存在 */ }

    // vault_log / black_diamond / source_tracking 等新增表已通过 L~130 的 schema.sql DDL 初始化
    // 此处不再重复执行完整 DDL，避免已有列上的 ALTER TABLE 重复报错

    // P1-1: 黑钻库 emotion_vector 列迁移
    try { this.db.run("ALTER TABLE black_diamond ADD COLUMN emotion_vector TEXT DEFAULT NULL"); } catch { /* 列已存在 */ }
    // V12.1: 黑钻库实体归属列 — 此前DDL缺失，必须补列
    try { this.db.run("ALTER TABLE black_diamond ADD COLUMN belong_entity_uuid TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE black_diamond ADD COLUMN dna_root_id TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE black_diamond ADD COLUMN dna_full_code TEXT"); } catch { /* 列已存在 */ }
    // S5: l2_norm 预计算字段
    try { this.db.run("ALTER TABLE black_diamond ADD COLUMN l2_norm REAL DEFAULT NULL"); } catch { /* 列已存在 */ }

    // 对话组结构字段
    try { this.db.run("ALTER TABLE memories ADD COLUMN dialog_group_id TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN thread_id TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN session_id TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN source_conversation_ids TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN round_count INTEGER DEFAULT 1"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN topic_label TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN anchor_score REAL"); } catch { /* 列已存在 */ }
    // 🏗️ Fix: ConsolidationQueue.write() 需要 dna_root_id 列
    try { this.db.run("ALTER TABLE memories ADD COLUMN dna_root_id TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN memory_kind TEXT DEFAULT 'episodic'"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN lifecycle_state TEXT DEFAULT 'candidate'"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN perception_v2 TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN perception_40d TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN confidence_score REAL DEFAULT 0.5"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN stability_score REAL DEFAULT 0.5"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN last_verified_at TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN promotion_reason TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN suppression_reason TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN archived_at TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN healed_at TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_memories_dialog_group ON memories(dialog_group_id)"); } catch { /* 索引已存在 */ }
    // 🆕 V10.0 P0-9: 以下独立 try/catch（从嵌套中拆分）

    // Schema 版本迁移（v2: 编码链路 + 基建标准化）
    try {
      const executed = migrateSchema(this.db);
      if (executed > 0) console.log(`[SQLiteAdapter] Schema 迁移完成: v${executed} 条`);
    } catch (err) {
      console.warn('[SQLiteAdapter] Schema 迁移失败（首次运行正常）:', err);
    }

    // V13: Foresight 前瞻时态列
    try { this.db.run("ALTER TABLE memories ADD COLUMN is_foresight INTEGER DEFAULT 0"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN valid_until_ms REAL"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN foresight_status TEXT"); } catch { /* 列已存在 */ }

    // 🔴 V13: 启动期数据完整性修复（global_uid / entity_uuid / null向量）
    // 与 schema 迁移不同：每次启动都执行，幂等
    try {
      console.error('[SQLiteAdapter] 开始数据完整性修复...');
      const { repairDataIntegrity } = await import('./MigrationManager.js');
      const fgPath = join(dirname(this.dbPath), 'knowledge', 'family_graph.db');
      const repairResult = await repairDataIntegrity(this.db, fgPath);
      console.error('[SQLiteAdapter] 数据完整性修复结果:', JSON.stringify(repairResult));
      // 🔴 修复后立即强制落盘：repairDataIntegrity 直接操作 sql.js db.run()，绕过了 _dirtyCount 计数
      // flushNow() 依赖 _dirtyCount>0 才执行 export，所以这里直接 export+write
      if (repairResult.entityUuid > 0 || repairResult.globalUid > 0) {
        try {
          const data = (this.db as any).export();
          writeFileSync(this.dbPath, Buffer.from(data));
          console.error('[SQLiteAdapter] 修复数据已直接 export 落盘 (' + (repairResult.entityUuid + repairResult.globalUid) + ' 条变更)');
        } catch (e) { console.error('[SQLiteAdapter] 修复落盘失败:', e); }
      }
    } catch (err) {
      console.error('[SQLiteAdapter] 数据完整性修复失败:', err);
    }

    // V15: entity_relations + KB 修复（独立于 memories 锚点，不依赖运行顺序）
    try {
      this._fixEntityRelations();
      this._fixKnowledgeBase();
    } catch (err) { console.warn('[SQLiteAdapter] 实体/KB修复失败:', (err as Error)?.message); }

    // V13: write() 路径完整性自检 — 检查 global_uid 是否全部填充
    try {
      const missing = this.db.exec("SELECT COUNT(*) FROM memories WHERE (global_uid IS NULL OR global_uid = '') AND leaf_zone != 'assistant'");
      const missingCount = missing.length > 0 && missing[0]?.values?.[0] ? missing[0].values[0][0] as number : 0;
      if (missingCount > 0) {
        console.warn(`[WritePath] ⚠️ global_uid 缺失: ${missingCount} 条 — 自动回填中...`);
        const nullRows = this.db.exec("SELECT id FROM memories WHERE (global_uid IS NULL OR global_uid = '') AND leaf_zone != 'assistant'");
        if (nullRows.length > 0 && nullRows[0].values) {
          for (const [id] of nullRows[0].values) {
            const h = createHash('sha256').update(String(id)).digest('hex').substring(0, 8).toUpperCase();
            this.db.run("UPDATE memories SET global_uid = ? WHERE id = ?", ['MM' + h, String(id)]);
          }
        }
        console.log(`[WritePath] ✅ global_uid 回填完成: ${missingCount} 条`);
      } else {
        console.log('[WritePath] ✅ global_uid 完整性验证通过: 0 条缺失');
      }
    } catch (e) { console.warn('[WritePath] 自检失败:', e); }

    // 家族图谱别名表（模糊去重）
    try {
      this.db.run("CREATE TABLE IF NOT EXISTS person_aliases (name TEXT, alias TEXT, PRIMARY KEY(name, alias))");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_person_aliases_alias ON person_aliases(alias)");
    } catch (e) { console.warn('[SQLite] person_aliases 表创建失败:', e); }
    // M7 梦境日志独立表（替代写入黑钻，避免摘要混入永久回忆）
    // 🔴 户籍管理法（第二条 适用范围）: dream_logs 纳入 UUID 监管，加 belong_entity_uuid 列。
    try {
      this.db.run("CREATE TABLE IF NOT EXISTS dream_logs (id TEXT PRIMARY KEY, summary TEXT, emotion_tag TEXT, source TEXT, tags TEXT, belong_entity_uuid TEXT, created_at TEXT NOT NULL)")
      this.db.run("CREATE INDEX IF NOT EXISTS idx_dream_logs_created ON dream_logs(created_at)")
      try { this.db.run("ALTER TABLE dream_logs ADD COLUMN belong_entity_uuid TEXT"); } catch { /* 列已存在 */ }
    } catch (e) { console.warn("[SQLite] dream_logs 表创建失败:", e); }

    // 🆕 V10.0 P1-1: 核心表索引（已有数据库运行时补建）
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_me_memory ON memory_entities(memory_id)"); } catch {}
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_me_entity ON memory_entities(entity_id)"); } catch {}
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_er_a ON entity_relations(entity_a_id)"); } catch {}
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_er_b ON entity_relations(entity_b_id)"); } catch {}
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_conv_compacted ON conversations(is_compacted)"); } catch {}
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_kb_class ON knowledge_base(classification)"); } catch {}

    // 🆕 V10.11: UUID实体归属索引 — 多角色超长上下文检索性能保障
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_conversations_belong_uuid ON conversations(belong_entity_uuid)"); } catch {}
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_memories_belong_uuid ON memories(belong_entity_uuid)"); } catch {}
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_black_diamond_belong_uuid ON black_diamond(belong_entity_uuid)"); } catch {}

    // 🆕 V10.11: 实体上下文快照表 — 跨会话情感连续性
    try { this.db.run(
      `CREATE TABLE IF NOT EXISTS entity_context_snapshots (
        uuid TEXT PRIMARY KEY, pleasure REAL DEFAULT 0, arousal REAL DEFAULT 0,
        intimacy REAL DEFAULT 0, last_topic TEXT DEFAULT '', saved_at TEXT NOT NULL
      )`
    ); } catch { /* 表已存在 */ }

    // S2-6: 知识库印象值 + 最近召回时间
    try { this.db.run("ALTER TABLE knowledge_base ADD COLUMN impression_score REAL DEFAULT 0.5"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE knowledge_base ADD COLUMN last_recalled_at TEXT"); } catch { /* 列已存在 */ }

    // 🧠 海马体稀疏索引表（V3.0）：不存记忆内容，只存 context_signature → memory_locations 指针映射
    try {
      this.db.run(`CREATE TABLE IF NOT EXISTS hippocampal_index (
        context_signature TEXT PRIMARY KEY,
        memory_locations TEXT NOT NULL,
        calcium_boost REAL DEFAULT 0.05,
        last_activated_at TEXT NOT NULL,
        hit_count INTEGER DEFAULT 1,
        experience_summary TEXT,
        created_at TEXT NOT NULL
      )`);
      this.db.run("CREATE INDEX IF NOT EXISTS idx_hippocampal_boost ON hippocampal_index(calcium_boost DESC)");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_hippocampal_activated ON hippocampal_index(last_activated_at)");
    } catch (e) { console.warn('[SQLite] hippocampal_index 表创建失败:', e); }

    // 🧠 场景认知地图表（V3.1）：位置细胞+网格细胞 → 用户主观经验空间
    try {
      this.db.run(`CREATE TABLE IF NOT EXISTS scene_map (
        scene_id TEXT PRIMARY KEY,
        scene_label TEXT NOT NULL,
        parent_scene TEXT,
        adjacency TEXT DEFAULT '[]',
        visit_count INTEGER DEFAULT 1,
        last_visited_at TEXT NOT NULL,
        associated_topics TEXT DEFAULT '[]',
        fg_events TEXT DEFAULT '[]',
        kb_entries TEXT DEFAULT '[]'
      )`);
      this.db.run("CREATE INDEX IF NOT EXISTS idx_scene_visit ON scene_map(visit_count DESC)");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_scene_label ON scene_map(scene_label)");
    } catch (e) { console.warn('[SQLite] scene_map 表创建失败:', e); }

    // 记事记忆：复用 memories 表，新增 type 字段区分
    try { this.db.run("ALTER TABLE memories ADD COLUMN memory_type TEXT DEFAULT 'dialog'"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN sub_type TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN note_key TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN is_valid INTEGER DEFAULT 1"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN remind_at TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN reminded INTEGER DEFAULT 0"); } catch { /* 列已存在 */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN repeat_rule TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_memories_note_key ON memories(note_key)"); } catch { /* 索引已存在 */ }
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_memories_remind ON memories(remind_at)"); } catch { /* 索引已存在 */ }
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type)"); } catch { /* 索引已存在 */ }

    // 砂金库：原始对话表（三段存储③，与原设计合并回同库）
    try {
      this.db.run(`CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seq_pos INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        topic TEXT,
        entity_names TEXT,
        perception_summary TEXT,
        calcium_score REAL DEFAULT 0,
        dna_root_id TEXT,
        dialog_group_id TEXT,
        dialog_round INTEGER DEFAULT 0,
        is_compacted INTEGER DEFAULT 0,
        is_test INTEGER DEFAULT 0,
        is_summary INTEGER DEFAULT 0,
        is_promoted INTEGER DEFAULT 0,
        summary_of_range TEXT,
        roleplay_char TEXT,
        message_id TEXT UNIQUE,
        namespace TEXT DEFAULT 'default'
      )`);
      try { this.db.run("ALTER TABLE conversations ADD COLUMN dna_root_id TEXT"); } catch { /* 列已存在 */ }
      try { this.db.run("ALTER TABLE conversations ADD COLUMN dialog_group_id TEXT"); } catch { /* 列已存在 */ }
      try { this.db.run("ALTER TABLE conversations ADD COLUMN dialog_round INTEGER DEFAULT 0"); } catch { /* 列已存在 */ }
      try { this.db.run("ALTER TABLE conversations ADD COLUMN is_compacted INTEGER DEFAULT 0"); } catch { /* 列已存在 */ }
      try { this.db.run("ALTER TABLE conversations ADD COLUMN is_test INTEGER DEFAULT 0"); } catch { /* 列已存在 */ }
      try { this.db.run("ALTER TABLE conversations ADD COLUMN is_summary INTEGER DEFAULT 0"); } catch { /* 列已存在 */ }
      try { this.db.run("ALTER TABLE conversations ADD COLUMN is_promoted INTEGER DEFAULT 0"); } catch { /* 列已存在 */ }
      try { this.db.run("ALTER TABLE conversations ADD COLUMN summary_of_range TEXT"); } catch { /* 列已存在 */ }
      try { this.db.run("ALTER TABLE conversations ADD COLUMN roleplay_char TEXT"); } catch { /* 列已存在 */ }
    // 🆕 V5.0: 户籍管理体系 — entities 表加 uuid 列关联 FamilyGraph.nodes.uuid
    try { this.db.run("ALTER TABLE entities ADD COLUMN uuid TEXT"); } catch { /* 列已存在 */ }
    try { this.db.run("CREATE INDEX IF NOT EXISTS idx_entities_uuid ON entities(uuid)"); } catch { /* 索引已存在 */ }
      try { this.db.run("ALTER TABLE conversations ADD COLUMN message_id TEXT"); } catch { /* 列已存在 */ }
      try { this.db.run("ALTER TABLE conversations ADD COLUMN namespace TEXT DEFAULT 'default'"); } catch { /* 列已存在 */ }
      try { this.db.run("ALTER TABLE vault_log ADD COLUMN content_md TEXT"); } catch { /* 列已存在 */ }
      this.db.run("CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp DESC)");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_conv_seq ON conversations(seq_pos)");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_conv_dna_root ON conversations(dna_root_id)");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_conv_dg ON conversations(dialog_group_id)");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_conv_promoted ON conversations(is_promoted)");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_conv_message_id ON conversations(message_id)");
    } catch (e) { console.warn('[SQLite] conversations 表创建失败:', e); }

    // SP3-3: 黑钻库 FTS5 全文索引（加速检索）
    try {
      this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS black_diamond_fts USING fts5(summary, tags, content='black_diamond', content_rowid='rowid')");
      // 同步已有数据到 FTS5 索引（首次运行时）
      this.db.run("INSERT OR IGNORE INTO black_diamond_fts(rowid, summary, tags) SELECT rowid, summary, tags FROM black_diamond");
      this.blackDiamondFtsReady = true;
    } catch (e) {
      this.blackDiamondFtsReady = false;
      if ((e as Error)?.message?.includes('no such module: fts5')) {
        console.log('[SQLite] FTS5 不可用，跳过全文索引初始化');
      } else {
        console.warn('[SQLite] FTS5 索引初始化失败:', e);
      }
    }

    this.ready = true;
    console.log(`[SQLiteAdapter] 初始化完成: ${this.dbPath}`);

    // 🔴 V10.5: 启动时自动回填 belong_entity_uuid —— 在同一个进程中执行，数据永不再丢失
    if (typeof process !== 'undefined' && process.env?.SKIP_BACKFILL !== 'true') {
      try {
        const _memBefore = (this.queryAll('SELECT COUNT(*) as cnt FROM memories WHERE belong_entity_uuid IS NOT NULL')[0] as any)?.cnt || 0;

        // conversations 回填：按 entity 名称匹配 + 自称检测
        const _ents = this.queryAll("SELECT DISTINCT name,uuid FROM entities WHERE type='person' AND LENGTH(name)>=2 AND uuid IS NOT NULL");
        for (const _e of _ents) {
          const _n = (_e as any).name, _u = (_e as any).uuid;

          // 全文匹配
          const _sql1 = `UPDATE conversations SET belong_entity_uuid='${_u}' WHERE belong_entity_uuid IS NULL AND content LIKE '%${_n}%'`;
          try { (this.db as any).run(_sql1); } catch {}

          // 自称检测：扩展6种模式（"我是XX"/"我就是XX"/"XX来了"/"我叫XX"/"XX在呢"/"是XX呀"）
          const _sql2 = `UPDATE conversations SET belong_entity_uuid='${_u}' WHERE belong_entity_uuid IS NULL AND role='assistant' AND (content LIKE '%我是${_n}%' OR content LIKE '%我就是${_n}%' OR content LIKE '%我叫${_n}%' OR content LIKE '%${_n}来了%' OR content LIKE '%${_n}在呢%' OR content LIKE '%是${_n}呀%')`;
          try { (this.db as any).run(_sql2); } catch {}
        }

        // memories 从 conversations 传导
        this.runSql("UPDATE memories SET belong_entity_uuid = (SELECT DISTINCT c.belong_entity_uuid FROM conversations c WHERE c.belong_entity_uuid IS NOT NULL AND c.content LIKE '%' || substr(memories.raw_input,1,30) || '%' LIMIT 1) WHERE belong_entity_uuid IS NULL");

        // 🆕 V10.7: 旧 roleplay 记忆直接匹配 entities.name → UUID
        //    间接回填路径（conversations 传导）可能因 raw_input/前缀不匹配而漏掉，
        //    此处直接用 raw_input 中的人名匹配 entities 表，确保 roleplay 记忆 UUID 完整。
        this.runSql(
          "UPDATE memories SET belong_entity_uuid = (" +
          "  SELECT e.uuid FROM entities e" +
          "  WHERE e.type='person' AND e.uuid IS NOT NULL" +
          "  AND memories.raw_input LIKE '%' || e.name || '%'" +
          "  LIMIT 1" +
          ") WHERE belong_entity_uuid IS NULL AND memory_kind='roleplay'"
        );

        // black_diamond 从 source_id → memories 传导
        this.runSql("UPDATE black_diamond SET belong_entity_uuid = (SELECT m.belong_entity_uuid FROM memories m WHERE m.id = black_diamond.source_id AND m.belong_entity_uuid IS NOT NULL) WHERE belong_entity_uuid IS NULL AND source_id IS NOT NULL");

        // 🔴 2026-09-11: fg_entity_names **幂等派生回填**（从 entity_genes）——
        //   为何放在启动末步：该列在 D3 修复前几乎全空；且实测**存在启动期写入路径把它抹回 NULL**
        //   （实测：磁盘上已回填 298 条 → 启动后变 0）。
        //   本步放在此处 → 无论此前哪个写入点抹过，启动后该列都与 entity_genes 一致（幂等可重复跑）。
        //   数据源确定性（无需 LLM），格式与写入侧共用 EntityNameCodec.formatNames。
        try {
          const _fgRows = this.db.exec(
            "SELECT id, entity_genes FROM memories WHERE entity_genes IS NOT NULL AND entity_genes != '' AND entity_genes != '[]' AND (fg_entity_names IS NULL OR fg_entity_names = '')",
          );
          let _fgFilled = 0;
          if (_fgRows.length && _fgRows[0].values) {
            for (const [id, genesRaw] of _fgRows[0].values) {
              let genes: any[] = [];
              try { genes = JSON.parse(String(genesRaw)); } catch { continue; }
              if (!Array.isArray(genes)) continue;
              const names = genes.filter((g) => g && g.type !== 'self' && g.name).map((g) => String(g.name).trim()).filter(Boolean);
              const formatted = formatNames(names);
              if (!formatted) continue;
              this.db.run("UPDATE memories SET fg_entity_names = ? WHERE id = ? AND (fg_entity_names IS NULL OR fg_entity_names = '')", [formatted, String(id)]);
              _fgFilled++;
            }
          }
          if (_fgFilled > 0) console.log('[Backfill] fg_entity_names 派生回填: ' + _fgFilled + ' 条');
        } catch (e) { console.warn('[Backfill] fg_entity_names 派生失败(不阻塞):', (e as Error)?.message); }

        const _memAfter = (this.queryAll('SELECT COUNT(*) as cnt FROM memories WHERE belong_entity_uuid IS NOT NULL')[0] as any)?.cnt || 0;
        console.log('[Backfill] memories标注: ' + _memBefore + '→' + _memAfter);

        // 🔴 持久化：回填必须立即 flush（save 只计数不落盘）
        this.flushNow();
      } catch (_bfErr) { console.warn('[Backfill] 自动回填失败:', (_bfErr as Error)?.message); }
    }

    // 🔴 V17: 锚点重建 + 完整性检查 — init() 最末端，确保所有上游修复完成后执行
    //   必须在 Backfill 落盘之后执行，否则 Backfill 的 flushNow() 会覆盖锚点重建的写入
    try {
      const anchored = this._rebuildMemoryAnchors();
      if (anchored > 0) console.log(`[SQLiteAdapter] memories锚点: ${anchored}条`);
      // 🔴 V20: 40D 启动补全 — 必须在锚点重建之后执行
      //   锚点重建走 write() 的 INSERT（不含 perception_40d），会把锚点行的 40D 清空，
      //   故补全放到重建后，覆盖全部行（含新锚点），flush 时随库持久。
      //   同时根治 sql.js 整库覆写（backfill 磁盘写入被内存态覆盖）。
      try {
        this._backfillPerception40D();
      } catch (_p40Err) { console.warn('[V20] 40D 补全失败:', (_p40Err as Error)?.message); }
      // V21: 三库（state_spines/knowledge_base/black_diamond）40D 补齐
      try {
        this._backfillLibs40D();
      } catch (_libErr) { console.warn('[V21] 三库 40D 补齐失败:', (_libErr as Error)?.message); }
      // V12.4: 存量 40D 编码升级 — v1 纯数组 → v2 `{__v:2,dims:[...]}`（幂等）
      try {
        this._upgradePerception40DToV2();
      } catch (_upErr) { console.warn('[V12.4] 40D 编码升级失败:', (_upErr as Error)?.message); }
      this._runIntegrityChecks();
      // 强制落盘
      if (this._dirtyCount > 0) { this.flushNow(); }
      // 磁盘验证：sql.js 重读磁盘文件确认持久化成功
      {
        const data2 = (this.db as any).export();
        writeFileSync(this.dbPath, Buffer.from(data2));
        const initSqlJs2 = (await import('sql.js')).default;
        const SQL2 = await initSqlJs2();
        const verifyBuf = readFileSync(this.dbPath);
        const vDb = new (SQL2 as any).Database(verifyBuf);
        const vRes = (vDb as any).exec("SELECT COUNT(*) as c FROM memories WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != ''");
        const vCount = (vRes.length && vRes[0]?.values?.[0]?.[0]) ? Number(vRes[0].values[0][0]) : 0;
        // V18: ANCHOR 重建结果观测 — 重建产物恒带 UUID（INSERT 前已跳过空 UUID）。
        //     空 UUID 锚点的真正检测点在 _rebuildMemoryAnchors() 的 DELETE 之前（见该函数 V18 注释）。
        const aRes = (vDb as any).exec("SELECT COUNT(*) as c FROM memories WHERE id LIKE '%\\_ANCHOR' ESCAPE '\\' AND belong_entity_uuid IS NOT NULL AND belong_entity_uuid != ''");
        const aTotal = (aRes.length && aRes[0]?.values?.[0]?.[0]) ? Number(aRes[0].values[0][0]) : 0;
        const aAllRes = (vDb as any).exec("SELECT COUNT(*) as c FROM memories WHERE id LIKE '%\\_ANCHOR' ESCAPE '\\'");
        const aAll = (aAllRes.length && aAllRes[0]?.values?.[0]?.[0]) ? Number(aAllRes[0].values[0][0]) : 0;
        (vDb as any).close();
        const icon = vCount >= 600 ? '✅' : '🔴';
        const aIcon = (aAll > 0 && aTotal === aAll) ? '✅' : '🔴';
        console.log(`[SQLiteAdapter] ${icon} 磁盘验证: ${vCount}条有UUID (重读磁盘)`);
        console.log(`[SQLiteAdapter] ${aIcon} ANCHOR重建结果: ${aTotal}/${aAll} 锚点带UUID`);
      }
    } catch (err) { console.warn('[SQLiteAdapter] 锚点重建失败:', (err as Error)?.message); }
  }

  /** 获取原始 sql.js 实例（供 ConversationDB 共享） */
  getDb(): any { return this.db; }

  isBlackDiamondFTSReady(): boolean {
    return this.blackDiamondFtsReady;
  }

  close(): void {
    // C4: 关闭前确保所有待写入数据已落盘
    this.flushNow();
    if (this.db) this.db.close();
    this.ready = false;
  }

  // ─── 砂金库：全量对话活档案 ───

  /** 写入一条对话记录（即时落盘） */
  insertConversation(role: string, content: string, options?: {
    seqPos?: number; topic?: string; entityNames?: string[];
    perception?: { pleasure: number; arousal: number; intimacy: number };
    calciumScore?: number;
    dnaRootId?: string;
    isCompacted?: number;
    namespace?: string;
  }): number {
    this.ensureReady();
    const now = new Date().toISOString();
    const compacted = options?.isCompacted ?? 0;
    this.runSql(
      'INSERT INTO conversations (role, content, timestamp, seq_pos, topic, entity_names, perception_summary, calcium_score, dna_root_id, is_compacted, is_summary, is_promoted, namespace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
      [role, content, now, options?.seqPos ?? null, options?.topic ?? null,
       options?.entityNames ? JSON.stringify(options.entityNames) : null,
       options?.perception ? JSON.stringify(options.perception) : null,
       options?.calciumScore ?? null, options?.dnaRootId ?? null,
       compacted, compacted, options?.namespace ?? 'default']
    );
    // ⚠️ P1(S4 独立评审): rowid 必须在 save() **之前**读取——与 ConversationDB.insertConversation 同一陷阱。
    // save() 达到 _FLUSH_BATCH 时会同步 flushNow() → db.export()，而 sql.js 的 export()
    // 会关闭并重开连接，last_insert_rowid() 作为连接级状态将归 0（已实测证实）→ 原实现会返回 0。
    const _rowIdRes = this.queryAll('SELECT last_insert_rowid() as id');
    // C4: 关键写入触发防抖落盘（合并在 150ms 窗口，避免 per-write 96MB export）
    this.save();
    // 降级可见性（S4 复审 P2-D 对称要求）：与 ConversationDB.insertConversation 保持一致
    const _finalRid = Number(_rowIdRes?.[0]?.id) || 0;
    if (_finalRid <= 0) {
      console.warn(
        '[SQLiteAdapter] insertConversation 未能取得 last_insert_rowid（返回 0）— ' +
          '调用方若将其当作主键使用会出错，请检查 flush 顺序',
      );
    }
    return _finalRid;
  }

  /** 搜索砂金库对话（降级检索用） */
  searchConversations(keyword: string, limit = 10): Array<{ id: number; role: string; content: string; timestamp: string; topic?: string }> {
    this.ensureReady();
    return this.queryAll(
      'SELECT id, role, content, timestamp, topic FROM conversations WHERE content LIKE ? AND is_compacted = 0 ORDER BY timestamp DESC LIMIT ?',
      ['%' + keyword + '%', limit]
    );
  }

  /** 按实体名搜索（M4降级路径） */
  searchConversationsByEntity(entityName: string, limit = 10): Array<{ id: number; role: string; content: string; timestamp: string }> {
    this.ensureReady();
    return this.queryAll(
      'SELECT id, role, content, timestamp FROM conversations WHERE entity_names LIKE ? AND is_compacted = 0 ORDER BY timestamp DESC LIMIT ?',
      ['%' + entityName + '%', limit]
    );
  }

  /** 按时间范围检索（"上周说了什么"） */
  findByTimeRange(start: string, end: string, limit = 20): Array<{ id: number; role: string; content: string; timestamp: string }> {
    this.ensureReady();
    return this.queryAll(
      'SELECT id, role, content, timestamp FROM conversations WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC LIMIT ?',
      [start, end, limit]
    );
  }

  /** 获取砂金库统计 */
  getConversationStats(): { total: number; userCount: number; assistantCount: number; oldest: string; newest: string } {
    this.ensureReady();
    const rows = this.queryAll(
      "SELECT COUNT(*) as total, SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) as userCount, SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) as assistantCount, MIN(timestamp) as oldest, MAX(timestamp) as newest FROM conversations"
    );
    const r = rows[0] || { total: 0, userCount: 0, assistantCount: 0, oldest: '', newest: '' };
    return { total: Number(r.total) || 0, userCount: Number(r.userCount) || 0, assistantCount: Number(r.assistantCount) || 0, oldest: String(r.oldest || ''), newest: String(r.newest || '') };
  }

  /** 获取最近对话（供 LLM 上下文拼接） */
  getRecentConversations(limit = 100): Array<{ role: string; content: string; timestamp: string }> {
    this.ensureReady();
    const rows = this.queryAll<{ role: string; content: string; timestamp: string }>(
        'SELECT role, content, timestamp FROM conversations WHERE is_compacted = 0 ORDER BY timestamp DESC LIMIT ?',
        [limit]
      );
      return rows.reverse();
  }

  // ─── 写入 ───

  write(record: EmotionalMemoryRecord): void {
    this.ensureReady();
    // V12.4 阶段B 根除24D: perception_json 列已删，24D 不再落库（仅作 M3 内部语义引擎/计算介质）。
    // 40D 强制恒写：record.perceptionV40 优先，缺失时从 record.perception(24D) 派生，防读-改-写清空。
    const p40 = record.perceptionV40 ?? map24DTo40D(record.perception);
    const p40Json = encodePerceptionV40(p40);

    // P0-4: 钙化分边界强制校验
    const cs = Math.max(MEMORY_CONFIG.recall.calciumMin, Math.min(MEMORY_CONFIG.recall.calciumMax, record.calcium_score));
    const cl = record.calcium_level;
    // P1: l2_norm 预计算（40维感知向量）
    const l2 = computeL2Norm40D(p40);

    this.runSql(
      `INSERT OR REPLACE INTO memories
      (id, seq_pos, created_at, perception_40d,
       calcium_score, calcium_level,
       locus_path, leaf_zone, raw_input,
       memory_kind, lifecycle_state, confidence_score, stability_score,
       last_verified_at, promotion_reason, suppression_reason, archived_at, healed_at,
       thread_id, session_id, dialog_group_id, source_conversation_ids,
       recall_count, last_recalled_at,
       reinforcement_accumulator, effective_strength, strength_updated_at,
       is_landmark, landmarked_at, narrative_tag, sensory_anchor,
       scar_type, scar_healed,
       vad_spectrum,
       primary_emotion, secondary_emotions,
       dna_root_id,
       entity_genes,
       fg_entity_names, time_period, season, lunar_term, namespace,
       global_uid, belong_entity_uuid, location_fingerprint,
       is_foresight, valid_until_ms, foresight_status,
       l2_norm)
      VALUES (?, ?, ?, ?,
              ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?,
              ?,
              ?, ?,
              ?,
              ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?)`,
      [
        record.id, record.seq_pos, record.created_at, p40Json,
        cs, cl,
        record.locus_path, record.leaf_zone, record.raw_input,
        record.memory_kind, record.lifecycle_state, record.confidence_score, record.stability_score,
        record.last_verified_at,
        record.promotion_reason ?? null,
        record.suppression_reason ?? null,
        record.archived_at ?? null,
        record.healed_at ?? null,
        record.thread_id ?? record.dialog_group_id ?? record.dna_root_id ?? record.id,
        record.session_id ?? null,
        record.dialog_group_id ?? null,
        record.source_conversation_ids ? JSON.stringify(record.source_conversation_ids) : null,
        record.recall_count, record.last_recalled_at,
        record.reinforcement_accumulator, record.effective_strength, record.strength_updated_at,
        record.is_landmark ? 1 : 0, record.landmarked_at,
        record.narrative_tag ?? null, record.sensory_anchor ?? null,
        record.scar?.type ?? null, record.scar?.healed ? 1 : record.scar ? 0 : null,
        record.vad_spectrum ? JSON.stringify(record.vad_spectrum) : null,
        record.primary_emotion ?? null,
        record.secondary_emotions ? JSON.stringify(record.secondary_emotions) : null,
        record.dna_root_id ?? null,
        record.entity_genes ? JSON.stringify(record.entity_genes) : null,
        // 🔴 2026-09-11: fg_entity_names 兜底派生 —— 若调用方未传但 entity_genes 非空，自动派生
        //   必要性：MemoryAssessor 等旧路径可能从空 conv.entity_names 解析出空 entityGenes，
        //   导致 fg_entity_names 被写 NULL；此处兜底确保只要 entity_genes 有数据就不会丢失。
        (record.fg_entity_names ?? (record.entity_genes && record.entity_genes.length > 0 ? formatNames(record.entity_genes.map((g: any) => g.name).filter(Boolean)) : null)) ?? null,
        record.time_period ?? null,
        record.season ?? null,
        record.lunar_term ?? null,
        record.namespace ?? 'default',
        record.global_uid || ('MM' + createHash('sha256').update(record.id).digest('hex').substring(0, 8).toUpperCase()),
        record.belongEntityUuid ?? null,
        record.location_fingerprint ?? null,
        record.isForesight ? 1 : 0,
        record.validUntilMs ?? null,
        record.foresightStatus ?? null,
        l2,
      ],
    );

    // 写入实体关联
    for (const gene of record.entity_genes) {
      this.ensureEntity(gene.name, gene.type, (gene as any).uuid);
      this.runSql(
        `INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, allele, phenotype, knowledge_type)
        VALUES (?, (SELECT id FROM entities WHERE name=? AND type=?), ?, ?, ?)`,
        [record.id, gene.name, gene.type, gene.allele, gene.phenotype, gene.knowledge_type],
      );
    }

    // 持久化到磁盘
    this.save();
  }

  /**
   * writeMemory — 对话持久化专用写入（改造②：替代 persistence-stage 中
   * 通过 getDb() 绕过封装层直接操作 sql.js 的 unsafe 模式）
   *
   * 使用 runSql() 私有方法（稳定可靠），不走 as any 逃逸路径。
   * 写入后触发批量刷新 save()。
   */
  writeMemory(opts: {
    id: string; seqPos: number; createdAt: string;
    // V12.4 阶段B 根除24D: perceptionJson 不再落库，仅作 40D 缺失时的派生源（可选）
    perceptionJson?: string | null; calciumScore: number; calciumLevel: number;
    locusPath: string; leafZone: string; rawInput: string;
    primaryEmotion: string; memoryType: string;
    globalUid?: string; locationFingerprint?: string;
    memoryKind?: string; lifecycleState?: string;
    confidenceScore?: number; stabilityScore?: number;
    threadId?: string | null; sessionId?: string | null;
    sourceConversationIds?: number[] | null;
    dialogGroupId?: string | null; topicLabel?: string | null;
    dnaRootId?: string | null;        // P0-1: DNA 根码透传落库（编码规约 B1）
    entityGenes?: any[] | null;       // P0-2: L3 实体基因落库（编码规约 B2）
    fgEntityNames?: string | null;    // D3 修复: FG 实体名(逗号分隔)；缺省时由 entityGenes 同源派生，调用方一般无需传
    belongEntityUuid?: string | null;  // V10.4: 实体归属标注
    isForesight?: boolean;            // V13: 前瞻时态标记
    validUntilMs?: number | null;     // V13: 有效截止时间(ms)
    foresightStatus?: string | null;  // V13: 前瞻状态
    namespace?: string | null;        // BATCH-23: memory namespace scope
    perceptionV40?: string | null;    // V20: 40D感知向量(JSON数组40元素)，写 perception_40d 列（唯一落库感知向量）
  }): boolean {
    this.ensureReady();
    try {
      // 40D 强制恒写：perceptionV40 优先，缺失时从 perceptionJson(24D JSON) 派生
      const p40Json = opts.perceptionV40
        ? opts.perceptionV40
        : (opts.perceptionJson ? encodePerceptionV40(map24DTo40D(parsePerception24DJson(opts.perceptionJson))) : null);

      // 🔴 D3 修复(2026-09-11): fg_entity_names 落库。
      // 原实现列清单缺席该列 → INSERT OR REPLACE 每轮把已写入的值抹成 NULL（全库 2012 条恒空）。
      // 由 entityGenes 同源派生（过滤 self），使调用方无需各自记得传参 —— 结构上不可遗漏。
      const fgEntityNames = opts.fgEntityNames
        ?? (Array.isArray(opts.entityGenes)
          ? (opts.entityGenes
              .filter((g: any) => g && g.type !== 'self' && g.name)
              .map((g: any) => String(g.name))
              .join(',') || null)
          : null);
      this.runSql(
        `INSERT OR REPLACE INTO memories
        (id, fg_entity_names, seq_pos, created_at, perception_40d, calcium_score, calcium_level,
         locus_path, leaf_zone, raw_input, memory_kind, lifecycle_state,
         confidence_score, stability_score, thread_id, session_id, source_conversation_ids,
         recall_count, promoted_to_diamond, strength_updated_at, effective_strength,
         is_landmark, primary_emotion, memory_type, dialog_group_id, topic_label,
	         dna_root_id, entity_genes,
	         global_uid, location_fingerprint, belong_entity_uuid,
		         is_foresight, valid_until_ms, foresight_status, namespace)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1.0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          opts.id, fgEntityNames, opts.seqPos, opts.createdAt, p40Json,
          opts.calciumScore, opts.calciumLevel,
          opts.locusPath, opts.leafZone, (opts.rawInput.length > 4000 ? console.warn(`[SQLiteAdapter] raw_input 超长: ${opts.rawInput.length} seq=${opts.seqPos}`) : null, opts.rawInput),
          opts.memoryKind ?? 'episodic',
          opts.lifecycleState ?? (opts.calciumLevel >= 2 ? 'active' : 'candidate'),
          opts.confidenceScore ?? 0.55,
          opts.stabilityScore ?? (opts.calciumLevel >= 2 ? 0.45 : 0.2),
          opts.threadId ?? opts.dialogGroupId ?? opts.id,
          opts.sessionId ?? null,
          opts.sourceConversationIds ? JSON.stringify(opts.sourceConversationIds) : null,
          opts.createdAt,
          opts.primaryEmotion, opts.memoryType || 'dialog',
          opts.dialogGroupId ?? null, opts.topicLabel ?? null,
          opts.dnaRootId ?? null, opts.entityGenes ? JSON.stringify(opts.entityGenes) : null,
          opts.globalUid || ('MM' + createHash('sha256').update(opts.id).digest('hex').substring(0, 8).toUpperCase()), opts.locationFingerprint ?? null,
	          opts.belongEntityUuid ?? null,
          opts.isForesight ? 1 : 0, opts.validUntilMs ?? null, opts.foresightStatus ?? null,
          opts.namespace || 'default',
        ],
      );
      this.save();
      return true;
    } catch (e: any) {
      console.error(`[SQLiteAdapter] ❌ writeMemory 失败 seq=${opts.seqPos} zone=${opts.leafZone}:`, e?.message);
      return false;
    }
  }

  private ensureEntity(name: string, type: string, uuid?: string): void {
    // 🔴 FG-P0: 写前统一闸门(object 通道) — 句子片段/外貌特征词/对话残留不再建独立 object 实体
    //   (person 由 M1 isPersonName/gradeEntity 识别后进入, 高可信, 不gate防误伤)
    if (type === 'object') {
      const _gv = checkEntityWrite(name);
      if (!_gv.allowed) {
        console.warn(`[EntityGate] ensureEntity 拦截 object 写入: "${name}" — ${_gv.reason}`);
        return;
      }
    }
    this.runSql(
      `INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)`,
      [name, type],
    );
    // 🆕 V5.0: 若基因携带 TXS-ID，回填到 entities 表
    if (uuid) {
      try {
        this.runSql(
          `UPDATE entities SET uuid = ? WHERE name = ? AND type = ? AND uuid IS NULL`,
          [uuid, name, type],
        );
      } catch { /* uuid 更新非关键 */ }
    }
  }

  /** V13: 构建 entityUuid SQL 过滤子句（占位符返回到主 SQL 中拼接）。
   *  🔴 户籍管理法：委托 UUIDPoliceFilter.buildSqlClause。
   *   - 空白名单 → AND 1=0（fail-closed，杜绝"无过滤"）
   *   - 默认 deny-by-default（allowUnowned=false，杜绝 OR IS NULL 逃生口）
   * 🔴 P0-A5 修复: 户主钥匙语义 — entityUuids 为空（户主/无活跃实体）时放行全部，
   *   不再 fail-closed 返回 AND 1=0（否则户主本人记忆永远检索不到，主场景功能退化）。 */
  private _entityUuidClause(entityUuids?: string[], allowUnowned = false): { clause: string; params: string[] } {
    // 户主钥匙场景：无活跃实体白名单 → 放行所有（户主是全库最高权限）
    if (!entityUuids || entityUuids.length === 0) {
      return { clause: '', params: [] };
    }
    return buildSqlClause({
      visibleUuids: new Set(entityUuids.filter(Boolean)),
      allowUnowned,
    });
  }

  // ─── 读取 ───

  /** 按 seq_pos 范围读取 */
  findBySeqPosRange(start: number, end: number, limit = 50): EmotionalMemoryRecord[] {
    this.ensureReady();
    const res = this.execSql(
      `SELECT * FROM memories WHERE seq_pos >= ? AND seq_pos <= ?
       ORDER BY seq_pos DESC LIMIT ?`,
      [start, end, limit],
    );
    return this.rowsToRecords(res);
  }

  /** 带衰减门控的检索 — 过滤低强度记忆，按 (strength * calcium) 排序 */
  findBySeqPosRangeWithStrength(start: number, end: number, limit = 50, minStrength = 0.05, entityUuids?: string[]): EmotionalMemoryRecord[] {
    this.ensureReady();
    const euClause = this._entityUuidClause(entityUuids);
    // 先拉取较多候选，再在应用层排序
    const res = this.execSql(
      `SELECT * FROM memories WHERE seq_pos >= ? AND seq_pos <= ?${euClause.clause}
       ORDER BY seq_pos DESC LIMIT ?`,
      [start, end, ...euClause.params, Math.min(limit * 3, 200)],
    );
    const records = this.rowsToRecords(res);
    // 过滤 + 排序（按 strength * calcium 综合分降序）
    return records
      .filter(r => r.effective_strength >= minStrength)
      .sort((a, b) => (b.effective_strength * b.calcium_score) - (a.effective_strength * a.calcium_score))
      .slice(0, limit);
  }

  /** 按 strength 过滤的 findByLocus */
  findByLocusWithStrength(locusPath: string, limit = 20, minStrength = 0.05, entityUuids?: string[]): EmotionalMemoryRecord[] {
    this.ensureReady();
    const euClause = this._entityUuidClause(entityUuids);
    const res = this.execSql(
      `SELECT * FROM memories WHERE locus_path LIKE ?${euClause.clause}
       ORDER BY seq_pos DESC LIMIT ?`,
      [`${locusPath}%`, ...euClause.params, limit * 2],
    );
    return this.rowsToRecords(res)
      .filter(r => r.effective_strength >= minStrength)
      .slice(0, limit);
  }

  /** 按 locus_path 前缀匹配 */
  findByLocus(locusPath: string, limit = 20): EmotionalMemoryRecord[] {
    this.ensureReady();
    const res = this.execSql(
      `SELECT * FROM memories WHERE locus_path LIKE ?
       ORDER BY seq_pos DESC LIMIT ?`,
      [`${locusPath}%`, limit],
    );
    return this.rowsToRecords(res);
  }

  /** 按 branch_id 精确查询（含实体关联） */
  findById(id: string): EmotionalMemoryRecord | null {
    this.ensureReady();
    const res = this.execSql(
      `SELECT * FROM memories WHERE id = ? LIMIT 1`,
      [id],
    );
    if (res.length === 0 || res[0].values.length === 0) return null;
    const { columns, values } = res[0];
    const record = this.rowToRecord(values[0], columns);

    // 加载实体关联
    try {
      const entRes = this.execSql(
        `SELECT e.name, e.type, me.allele, me.phenotype, me.knowledge_type
         FROM memory_entities me JOIN entities e ON me.entity_id = e.id
         WHERE me.memory_id = ?`,
        [id],
      );
      if (entRes.length > 0) {
        const genes: EntityGene[] = [];
        for (const rowVals of entRes[0].values) {
          const cols = entRes[0].columns;
          const rowObj: Record<string, any> = {};
          for (let i = 0; i < cols.length; i++) rowObj[cols[i]] = rowVals[i];
          genes.push({
            name: rowObj.name as string,
            type: rowObj.type as any,
            allele: rowObj.allele as string,
            phenotype: rowObj.phenotype as any,
            knowledge_type: rowObj.knowledge_type as any,
          });
        }
        record.entity_genes = genes;
      }
    } catch (err) { console.warn('[SQLite] findById entity加载失败:', err); }

    return record;
  }

  /** 获取总记录数 */
  getTotalCount(): number {
    this.ensureReady();
    const res = this.execSql(`SELECT COUNT(*) as cnt FROM memories`);
    if (res.length > 0 && res[0].values.length > 0) {
      return res[0].values[0][0] as number;
    }
    return 0;
  }

  // ─── 情感检索（核心新能力） ───

  /**
   * 按情感相似度检索。
   * 遍历全部记录，计算加权余弦相似度，返回 Top-N。
   * 后续可优化为 KD-tree 索引。
   */
  findByEmotionalSimilarity(query: RetrievalQuery): ScoredMemory[] {
    // V12.4 阶段B 根除24D: 固定转发 40D 情感检索（perception_json 列已删，24D 检索路径退役）。
    // 24D 打分在 record.perception 反解后（10 维中性 0.5）会产生失真结果，不再保留 24D 分支。
    // 所有调用方（V13 emotion 路 / retrieval-stage / 金库）零改动。
    return this.findByEmotionalSimilarity40D(query);
  }

  /**
   * V12.4 阶段A: 40D 情感检索 — 用 perception_40d 列 + cosineSimilarity40D 评分。
   * 与 findByEmotionalSimilarity 同构（landmark/recent 分层 + 过滤），但：
   *   - 查询感知：current_perception(24D) → map24DTo40D → PerceptionV40
   *   - 记录感知：record.perceptionV40（perception_40d 列，v2 兼容 decode）
   *   - 相似度：cosineSimilarity40D（扇区加权）
   * 40D 缺失行（perceptionV40 空）→ 降级按钙化分排序，不崩不泄漏。
   */
  findByEmotionalSimilarity40D(query: RetrievalQuery): ScoredMemory[] {
    this.ensureReady();
    const cacheKey = 'ems40_' + query.similarity_mode + '_' + query.limit + '_' + (query.locus_path || '') + '_' + (query.entities?.slice().sort().join(',') || '') + '_' + (query.entityUuids?.slice().sort().join(',') || '') + '_' + (query.isBackgroundTask ? 'bg' : 'chat') + '_' + JSON.stringify(query.current_perception);
    const cached = this._cacheGet<ScoredMemory[]>(cacheKey);
    if (cached) return cached;

    const startTime = performance.now();
    // 查询 24D → 40D 派生（与 M3 buildPerceptionV40 同源投影）
    const q40 = map24DTo40D(query.current_perception);

    // P0-3: 仅后台任务（isBackgroundTask=true，梦境/金库/分析）排除 roleplay 记忆；
    // 聊天私聊/会晤检索不过滤（会晤记忆可被聊天召回，根治"回头就忘"）。保留 memory_kind 体系。
    const rpExclude = query.isBackgroundTask
      ? " AND (memory_kind IS NULL OR (memory_kind != 'roleplay' AND memory_type != 'rp_dialog'))"
      : "";
    const euClause = this._entityUuidClause(query.entityUuids);
    const landmarkRows = this.execSql(
      `SELECT * FROM memories WHERE is_landmark = 1${rpExclude}${euClause.clause} ORDER BY calcium_score DESC LIMIT 20`,
      euClause.params,
    );
    const landmarkRecords = this.rowsToRecords(landmarkRows)
      .filter(r => r.effective_strength >= 0.05);

    const allScored: ScoredMemory[] = [];
    const landmarkIds = new Set<string>();
    for (const record of landmarkRecords) {
      landmarkIds.add(record.id);
      const score = this._scoreMemory40D(record, q40);
      if (score) allScored.push(score);
    }

    if (allScored.length < query.limit) {
      const all = this.execSql(
        `SELECT * FROM memories WHERE 1=1${rpExclude}${euClause.clause} ORDER BY created_at DESC LIMIT 200`,
        euClause.params,
      );
      const records = this.rowsToRecords(all)
        .filter(r => r.effective_strength >= 0.05 && !landmarkIds.has(r.id));
      for (const record of records) {
        const score = this._scoreMemory40D(record, q40);
        if (score) allScored.push(score);
      }
    }

    const result = allScored
      .sort((a, b) => b.composite - a.composite)
      .slice(0, query.limit);

    const elapsed = performance.now() - startTime;
    if (elapsed > 100) {
      console.warn(`[SQLite] SLOW QUERY [findByEmotionalSimilarity40D]: ${elapsed.toFixed(0)}ms`);
    }
    this._cacheSet(cacheKey, result);
    return result;
  }

  /** V12.4: 40D 单条评分 — cosineSimilarity40D 扇区加权。
   * 合成语义对齐 24D _scoreMemory（S4 评审 P1 修复）：
   *   - 钙化分 /10 归一化（累积级钙化最高 [0,10]，不归一化会淹没情感相似度）
   *   - effective_strength 乘子 + 时间衰减
   *   - safeComposite > 0.05 低相似过滤（与调用方阈值契约一致）
   */
  private _scoreMemory40D(record: EmotionalMemoryRecord, q40: PerceptionV40): ScoredMemory | null {
    // S4 P1-1 修复: 40D 缺失行不再从 record.perception（反解含 10 维中性 0.5）map 兜底——
    //   否则金库/记事/锚点会以相同 14×0.5 签名参与余弦，污染情感召回。
    //   缺失行 → emotional=0，仅按钙化分+recency 降级排序（与注释契约一致）。
    const r40 = record.perceptionV40 ?? null;
    const emotional = r40 ? cosineSimilarity40D(q40, r40) : 0;

    const calcium = record.calcium_score ?? 0;
    let recency = 1.0;
    if (record.created_at) {
      const hoursAgo = (Date.now() - new Date(record.created_at).getTime()) / 3_600_000;
      recency = Math.pow(0.5, hoursAgo / 24);
    }
    const str = record.effective_strength ?? 0.5;
    // V12.4: 40D 相似度 55% + 钙化(归一化) 30% + 时间衰减 15%（weighted）
    const composite = isNaN(str) ? 0.5 : str * (
      0.55 * emotional +
      0.30 * (calcium / 10) +
      0.15 * recency
    );
    const safeComposite = isNaN(composite) ? 0 : Math.max(0, Math.min(1, composite));

    if (safeComposite > 0.05) {
      return {
        record,
        scores: { emotional, topic: 0, entity: 0, calcium },
        composite: safeComposite,
      };
    }
    return null;
  }

  // V12.4 阶段B 根除24D: 原 _scoreMemory(24D 加权余弦) 已退役 — findByEmotionalSimilarity 固定走 40D。
  // 40D 评分统一在 _scoreMemory40D（cosineSimilarity40D 扇区加权）。
  // ─── 记忆动力学更新 ───

  /** 更新召回避次数 + 重新巩固增强 */
  updateRecall(memoryIds: string[]): void {
    this.ensureReady();
    const now = new Date().toISOString();
    for (const id of memoryIds) {
      const record = this.findById(id);
      if (!record) continue;

      record.recall_count++;
      record.last_recalled_at = now;
      const boost = recallBoost(record.effective_strength);
      record.effective_strength = Math.min(1.0, record.effective_strength + boost);
      record.strength_updated_at = now;

      this.write(record);
    }
  }

  /** 批量衰减维护 */
  runDecayMaintenance(): { total: number; archived: number } {
    this.ensureReady();
    const now = new Date();
    let archived = 0;
    let total = 0;
    const PAGE_SIZE = 500;
    let offset = 0;
    let pageRecords: any[];

    // 分页处理，避免全表加载
    do {
      const res = this.execSql(`SELECT * FROM memories ORDER BY id LIMIT ? OFFSET ?`, [PAGE_SIZE, offset]);
      pageRecords = this.rowsToRecords(res);
      if (pageRecords.length === 0) break;

      for (const record of pageRecords) {
      const before = record.effective_strength;
      updateDynamics(record, now);

      // 记录衰减日志（M2: 只记录有实质变化的行，抑制噪声）
      //  decay_log 仅用于调试追溯，686K 行中有 >99% 的 strength 变化 <0.00001（纯机械刷新，无诊断价值），
      //  跳过这些噪声行，同时每周期裁剪到每 memory_id 最近 5 条。
      const deltaAbs = Math.abs(before - record.effective_strength);
      if (deltaAbs >= 0.0001) {
        const lastUpdate = record.strength_updated_at
          ? Math.max(0, (now.getTime() - new Date(record.strength_updated_at).getTime()) / 86_400_000)
          : 0;
        this.runSql(
          `INSERT INTO decay_log (memory_id, checked_at, strength_before, strength_after, days_elapsed)
           VALUES (?, ?, ?, ?, ?)`,
          [record.id, now.toISOString(), before, record.effective_strength, lastUpdate],
        );
      }

      this.write(record);
      if (record.effective_strength < 0.05) archived++;
      total++;
    }
      offset += PAGE_SIZE;
    } while (pageRecords.length >= PAGE_SIZE);

    // M2: 裁剪 decay_log — 每个 memory_id 只保留最近 5 条检查记录，防止无界膨胀撑大 96MB 库（拖慢 C4 落盘）。
    //  decay_log 是纯调试追溯日志，从不参与检索；仅保留最近若干条即可满足排障需要。
    //  用窗口函数单遍扫描（sql.js 1.11 支持），避免相关子查询在存量大表上的 O(N²) 开销。
    try {
      (this.db as any).run(
        `DELETE FROM decay_log WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER (PARTITION BY memory_id ORDER BY checked_at DESC) AS rn
             FROM decay_log
           ) WHERE rn > 5
         )`,
      );
      const removed = typeof (this.db as any).getRowsModified === 'function'
        ? (this.db as any).getRowsModified() : 0;
      if (removed > 0) console.log(`[Decay] decay_log 裁剪: 删除 ${removed} 条历史记录`);
      // 仅在一次性清理大量存量时 VACUUM 回收磁盘页（日常维护删几条不触发，避免每日重建整库）
      if (removed > 10000) {
        try {
          (this.db as any).run('VACUUM');
          console.log('[Decay] decay_log 大批清理后已 VACUUM 回收空间');
        } catch (ve: any) { console.warn('[Decay] VACUUM 失败:', ve?.message); }
      }
    } catch (e: any) {
      console.warn('[Decay] decay_log 裁剪失败:', e?.message);
    }

    // Q2: 辅助日志表无界增长防护 — 每日维护时顺带裁剪过期记录
    try {
      const d90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const d30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      (this.db as any).run("DELETE FROM vault_log WHERE created_at < ?", [d90]);
      (this.db as any).run("DELETE FROM aqc_records WHERE created_at < ?", [d30]);
    } catch (e: any) { /* 非致命 — 表可能不存在 */ }

    return { total, archived };
  }

  /** 情感相似事件增强 */
  applyReinforcement(
    newPerception: Perception24D,
    newCalcium: number,
    memoryIds: string[],
  ): void {
    this.ensureReady();
    const now = new Date().toISOString();
    // V12.4 阶段B 根除24D: 相似度改用 40D 扇区加权余弦（perception 反解后 10 维中性 0.5，24D 余弦失真）
    const newP40 = map24DTo40D(newPerception);
    for (const id of memoryIds) {
      const record = this.findById(id);
      if (!record) continue;

      // S4 P1-1 一致性修复: 40D 缺失行不 map 反解中性 0.5（避免 14×0.5 假相似），similarity=0 自然不过 0.3 门槛
      const r40 = record.perceptionV40 ?? null;
      const similarity = r40 ? cosineSimilarity40D(newP40, r40) : 0;
      if (similarity < 0.3) continue;

      const boost = reinforcementBoost(record.calcium_score, newCalcium, similarity);
      record.reinforcement_accumulator += boost;
      record.effective_strength = Math.min(1.0, record.effective_strength + boost * 0.1);
      record.strength_updated_at = now;

      this.write(record);
    }
  }

  // ─── 年轮/地标视图 ───

  /** 获取情感地形图（含非地标疤痕记忆） */
  getEmotionalLandscape(): EmotionalLandscape {
    this.ensureReady();
    // 1. 地标记录
    const landmarks = this.execSql(
      `SELECT * FROM memories WHERE is_landmark = 1
       ORDER BY calcium_score DESC LIMIT 50`,
    );
    const peakRecords = this.rowsToRecords(landmarks);

    // 2. 非地标但有疤痕的记录（疤痕可能出现在晋升地标前）
    const scarredNonLandmarks = this.execSql(
      `SELECT * FROM memories WHERE scar_type IS NOT NULL AND is_landmark = 0`,
    );
    const scarredRecords = this.rowsToRecords(scarredNonLandmarks);

    const allRecords = [...peakRecords, ...scarredRecords];

    return {
      peaks: allRecords.map(r => ({
        id: r.id,
        created_at: r.created_at,
        calcium: r.calcium_score,
        pleasure: r.perception.pleasure,
        intimacy: r.perception.intimacy,
        snippet: r.raw_input.substring(0, 60),
        narrative_tag: r.narrative_tag,
      })),
      scars: allRecords
        .filter(r => r.scar && !r.scar.healed)
        .map(r => ({
          id: r.id,
          created_at: r.created_at,
          calcium: r.calcium_score,
          pleasure: r.perception.pleasure,
          type: r.scar!.type,
          snippet: r.raw_input.substring(0, 60),
        })),
      cluster_count: peakRecords.length,
    };
  }

  /** 晋升为地标 */
  promoteToLandmark(memoryId: string, narrativeTag?: string, sensoryAnchor?: string): boolean {
    this.ensureReady();
    const record = this.findById(memoryId);
    if (!record) return false;

    record.is_landmark = true;
    record.landmarked_at = new Date().toISOString();
    if (narrativeTag) record.narrative_tag = narrativeTag;
    if (sensoryAnchor) record.sensory_anchor = sensoryAnchor;

    this.write(record);
    return true;
  }

  // ─── 状态 ───

  getStatus(): { totalRecords: number; landmarks: number; totalEntities: number } {
    this.ensureReady();
    const cnt = this.execSql(`SELECT
      (SELECT COUNT(*) FROM memories) as totalRecords,
      (SELECT COUNT(*) FROM memories WHERE is_landmark=1) as landmarks,
      (SELECT COUNT(*) FROM entities) as totalEntities`);
    const row = cnt[0]?.values[0];
    return {
      totalRecords: row?.[0] ?? 0,
      landmarks: row?.[1] ?? 0,
      totalEntities: row?.[2] ?? 0,
    };
  }

  /** 更新已存在记忆的 VAD 谱曲字段（异步谱曲完成后调用） */
  updateVadSpectrum(memoryId: string, vad: any): boolean {
    this.ensureReady();
    try {
      const vadJson = JSON.stringify(vad);
      this.runSql(
        `UPDATE memories SET vad_spectrum = ? WHERE id = ?`,
        [vadJson, memoryId],
      );
      this.save();
      return true;
    } catch (err) {
      console.warn(`[SQLite] updateVadSpectrum 失败:`, err);
      return false;
    }
  }

  /**
   * 通过实体重叠查找关联的知识条目。
   * 找到与当前实体同现的过往记忆 → 通过 knowledge_memories 反向查出知识条目。
   * 用于在关键词搜索之外提供"情感关联"维度的知识补充。
   */
  findKnowledgeByEntityOverlap(entityNames: string[], limit = 5): Array<{ id: string; title: string; content: string; source_type: string; tags: string }> {
    this.ensureReady();
    if (entityNames.length === 0) return [];

    const placeholders = entityNames.map(() => '?').join(',');
    try {
      const results = this.execSql(
        `SELECT DISTINCT kb.id, kb.title, kb.content, kb.source_type, kb.tags
         FROM knowledge_base kb
         JOIN knowledge_memories km ON km.knowledge_id = kb.id
         JOIN memories m ON m.id = km.memory_id
         JOIN memory_entities me ON me.memory_id = m.id
         JOIN entities e ON e.id = me.entity_id
         WHERE e.name IN (${placeholders})
         ORDER BY km.relevance DESC
         LIMIT ?`,
        [...entityNames, limit],
      );
      if (results.length === 0) return [];
      const { columns, values } = results[0];
      return values.map((row: any[]) => {
        const obj: Record<string, any> = {};
        columns.forEach((col: string, idx: number) => { obj[col] = row[idx]; });
        return {
          id: obj.id as string,
          title: obj.title as string,
          content: obj.content as string,
          source_type: obj.source_type as string,
          tags: obj.tags as string,
        };
      });
    } catch (err) {
      console.warn('[SQLite] findKnowledgeByEntityOverlap 失败:', err);
      return [];
    }
  }

  /** 直接执行 SQL（关键写入触发防抖落盘） */
  writeRaw(sql: string, ...params: any[]): void {
    this.ensureReady();
    // 兼容两种调用风格：writeRaw(sql, a, b) 与 writeRaw(sql, [a, b])。
    // sql.js 无法把数组绑定到单个 ?，故"单个数组参数"必为数组风格，需展开——否则整个数组被绑到 ?1、
    // 其余 ? 变 NULL，导致 UPDATE ... WHERE id=? 恒不命中（静默无操作）。
    const bind = (params.length === 1 && Array.isArray(params[0])) ? params[0] : params;
    this.runSql(sql, bind.length > 0 ? bind : undefined);
    // C4: 对话组锚点/碎片/黑钻晋升等关键写入触发防抖落盘（同轮突发写入合并为一次 export）
    this.save();
  }

  /** P8: 类型安全查询 — 默认返回 Record<string, unknown>，可显式泛型约束 */
  queryAll<T = Record<string, unknown>>(sql: string, params?: any[]): T[] {
    this.ensureReady();
    const result = this.execSql(sql, params);
    if (result.length === 0) return [];
    const { columns, values } = result[0];
    return values.map((row: any[]) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col: string, idx: number) => { obj[col] = row[idx]; });
      return obj as T;
    });
  }


  // ─── P2: 金库管理 API ───

  /** 获取单条记忆 */
  getMemoryById(id: string): Record<string, unknown> | null {
    this.ensureReady();
    const rows = this.queryAll('SELECT * FROM memories WHERE id = ?', [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  /** 锁定记忆（阻止衰减）*/
  lockMemory(id: string): boolean {
    this.ensureReady();
    try {
      this.runSql('UPDATE memories SET effective_strength = 1.0, strength_updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
      this.save();
      return true;
    } catch { return false; }
  }

  /** 删除记忆 */
  deleteMemory(id: string): boolean {
    this.ensureReady();
    try {
      this.runSql('DELETE FROM memories WHERE id = ?', [id]);
      this.save();
      return true;
    } catch { return false; }
  }

  /** 标记记忆 */
  tagMemory(id: string, tag: string): boolean {
    this.ensureReady();
    try {
      const existing = this.queryAll('SELECT narrative_tag FROM memories WHERE id = ?', [id]);
      if (existing.length > 0) {
        const oldTag = existing[0].narrative_tag || '';
        const newTag = oldTag ? oldTag + ',' + tag : tag;
        this.runSql('UPDATE memories SET narrative_tag = ? WHERE id = ?', [newTag, id]);
        this.save();
      }
      return true;
    } catch { return false; }
  }

  /** 按情绪标签检索 */
  findByEmotion(emotion: string, limit = 20): EmotionalMemoryRecord[] {
    this.ensureReady();
    const res = this.execSql(
      'SELECT * FROM memories WHERE primary_emotion = ? ORDER BY calcium_score DESC LIMIT ?',
      [emotion, limit]
    );
    return this.rowsToRecords(res);
  }

  /** 金库统计 */
  getGoldStats(): Record<string, number | string> {
    this.ensureReady();
    const rows = this.queryAll(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_landmark = 1 THEN 1 ELSE 0 END) as landmarks,
        SUM(CASE WHEN scar_type IS NOT NULL THEN 1 ELSE 0 END) as scarred,
        SUM(CASE WHEN calcium_level >= 2 THEN 1 ELSE 0 END) as highCalcium,
        AVG(effective_strength) as avgStrength,
        MIN(created_at) as oldest,
        MAX(created_at) as newest
      FROM memories`
    );
    const r = rows[0] || {};
    return {
      total: Number(r.total) || 0, landmarks: Number(r.landmarks) || 0,
      scarred: Number(r.scarred) || 0, highCalcium: Number(r.highCalcium) || 0,
      avgStrength: Number(r.avgStrength) || 0,
      oldest: String(r.oldest || ''), newest: String(r.newest || ''),
    };
  }

  // ─── 实体关系检索 ───

  /**
   * 根据当前实体名称，查找实体关系图中关联的其他实体。
   * 例如："加班" → 查到 "累"、"深夜"、"压力"
   */
  findRelatedEntities(entityNames: string[], minStrength = 0.3): Array<{
    name: string;
    relation: string;
    strength: number;
  }> {
    this.ensureReady();
    if (entityNames.length === 0) return [];

    const placeholders = entityNames.map(() => '?').join(',');
    const results = this.execSql(
      `SELECT e.name, er.relation, er.strength
       FROM entity_relations er
       JOIN entities e ON e.id = er.entity_b_id
       WHERE er.entity_a_id IN (SELECT id FROM entities WHERE name IN (${placeholders}))
         AND er.strength >= ?
       UNION
       SELECT e.name, er.relation, er.strength
       FROM entity_relations er
       JOIN entities e ON e.id = er.entity_a_id
       WHERE er.entity_b_id IN (SELECT id FROM entities WHERE name IN (${placeholders}))
         AND er.strength >= ?
       ORDER BY strength DESC
       LIMIT 15`,
      [...entityNames, minStrength, ...entityNames, minStrength],
    );

    if (results.length === 0) return [];
    const { columns, values } = results[0];
    return values.map((row: any[]) => ({
      name: row[columns.indexOf('name')] as string,
      relation: row[columns.indexOf('relation')] as string,
      strength: row[columns.indexOf('strength')] as number,
    }));
  }

  /**
   * P1-3: 多跳实体关联检索（支持 1-3 度扩展）
   * 保护机制：单实体最多返回 8 条，超限截断。
   */
  findRelatedEntitiesN(entityNames: string[], maxHops: 1|2|3 = 1, minStrength = 0.3, maxAgeDays?: number): Array<{
    name: string;
    relation: string;
    strength: number;
    hop: number;
  }> {
    this.ensureReady();
    if (entityNames.length === 0 || maxHops < 1) return [];
    // P0-4: 默认过滤超过2年的弱关联
    const cutoffDate = maxAgeDays !== undefined
      ? new Date(Date.now() - maxAgeDays * 86400000).toISOString()
      : new Date(Date.now() - 730 * 86400000).toISOString();
    const seen = new Set<string>();
    const results: Array<{ name: string; relation: string; strength: number; hop: number }> = [];
    let currentLayer = [...entityNames];
    let hop = 1;
    while (hop <= maxHops && currentLayer.length > 0 && results.length < 8) {
      const placeholders = currentLayer.map(() => "?").join(",");
      const rows = this.execSql(
        `SELECT e.name, er.relation, er.strength
         FROM entity_relations er
         JOIN entities e ON e.id = er.entity_b_id
         WHERE er.entity_a_id IN (SELECT id FROM entities WHERE name IN (${placeholders}))
           AND er.strength >= ?
           AND (er.updated_at IS NULL OR er.updated_at >= ?)
         UNION
         SELECT e.name, er.relation, er.strength
         FROM entity_relations er
         JOIN entities e ON e.id = er.entity_a_id
         WHERE er.entity_b_id IN (SELECT id FROM entities WHERE name IN (${placeholders}))
           AND er.strength >= ?
           AND (er.updated_at IS NULL OR er.updated_at >= ?)
         ORDER BY strength DESC
         LIMIT 15`,
        [...currentLayer, minStrength, cutoffDate, ...currentLayer, minStrength, cutoffDate],
      );
      if (rows.length === 0 || !rows[0].values) break;
      const columns = rows[0].columns;
      const nextLayer: string[] = [];
      for (const row of rows[0].values) {
        const name = row[columns.indexOf("name")] as string;
        if (seen.has(name) || entityNames.includes(name)) continue;
        seen.add(name);
        results.push({ name, relation: row[columns.indexOf("relation")] as string, strength: row[columns.indexOf("strength")] as number, hop });
        nextLayer.push(name);
        if (results.length >= 8) break;
      }
      currentLayer = nextLayer;
      hop++;
    }
    return results;
  }


  /**
   * 通过实体名称查找关联的记忆。
   * 利用 memory_entities 表做 JOIN，比全文搜索 raw_input 更精准。
   */
  findMemoriesByEntityNames(entityNames: string[], limit = 10): EmotionalMemoryRecord[] {
    this.ensureReady();
    if (entityNames.length === 0) return [];

    const placeholders = entityNames.map(() => '?').join(',');
    const results = this.execSql(
      `SELECT DISTINCT m.* FROM memories m
       JOIN memory_entities me ON me.memory_id = m.id
       JOIN entities e ON e.id = me.entity_id
       WHERE e.name IN (${placeholders})
       ORDER BY m.calcium_score DESC
       LIMIT ?`,
      [...entityNames, limit],
    );

    return this.rowsToRecords(results);
  }

  /** 🆕 V5.0: 按实体 UUID 检索记忆（户籍管理体系 TXS-ID 贯穿） */
  findMemoriesByEntityUUIDs(entityUUIDs: string[], limit = 10): EmotionalMemoryRecord[] {
    this.ensureReady();
    if (entityUUIDs.length === 0) return [];

    const placeholders = entityUUIDs.map(() => '?').join(',');
    const results = this.execSql(
      `SELECT DISTINCT m.* FROM memories m
       JOIN memory_entities me ON me.memory_id = m.id
       JOIN entities e ON e.id = me.entity_id
       WHERE e.uuid IN (${placeholders})
       ORDER BY m.calcium_score DESC
       LIMIT ?`,
      [...entityUUIDs, limit],
    );

    return this.rowsToRecords(results);
  }

  /** 获取实体关系图摘要（调试用） */
  getEntityRelationSummary(): Array<{
    entityA: string;
    entityB: string;
    relation: string;
    strength: number;
  }> {
    this.ensureReady();
    const results = this.execSql(
      `SELECT a.name as entityA, b.name as entityB, er.relation, er.strength
       FROM entity_relations er
       JOIN entities a ON a.id = er.entity_a_id
       JOIN entities b ON b.id = er.entity_b_id
       ORDER BY er.strength DESC
       LIMIT 30`,
    );
    if (results.length === 0) return [];
    const { columns, values } = results[0];
    return values.map((row: any[]) => ({
      entityA: row[columns.indexOf('entityA')] as string,
      entityB: row[columns.indexOf('entityB')] as string,
      relation: row[columns.indexOf('relation')] as string,
      strength: row[columns.indexOf('strength')] as number,
    }));
  }

  /**
   * 🆕 V10.7: 按 belong_entity_uuid 直查实体记忆
   * 不区分 memory_kind — 会晤中产生的记忆均属于该实体的合法记录。
   * 走 belong_entity_uuid 列索引，limit=15，性能可控。
   */
  findByEntityUuid(uuid: string, limit = 15): EmotionalMemoryRecord[] {
    this.ensureReady();
    const res = this.execSql(
      `SELECT * FROM memories WHERE belong_entity_uuid = ? ORDER BY seq_pos DESC LIMIT ?`,
      [uuid, limit],
    );
    return this.rowsToRecords(res);
  }

  // ─── 私有方法 ───

  private ensureReady(): void {
    if (!this.ready || !this.db) throw new Error('SQLiteAdapter not initialized');
  }

  /**
   * V16: 修复核心实体与用户的 entity_relations（sql.js session 内执行）。
   * 替代 clean-all-person-edges.cjs / fix-all-entities-final.cjs 中的 better-sqlite3 写入。
   */
  private _fixEntityRelations(): void {
    if (!this.db) return;
    const now = new Date().toISOString();
    const persons: Array<{name:string; rel:string}> = [
      {name:'熊梓铭',rel:'熟人'},{name:'徐诗雨',rel:'熟人'},{name:'徐诗韵',rel:'熟人'},{name:'玉瑶',rel:'灵魂伴侣'}
    ];
    let meId: number|null = null;
    try {
      const sm = this.db.prepare("SELECT id FROM entities WHERE name = '我'");
      if (sm.step()) meId = (sm.getAsObject() as any).id;
      sm.free();
    } catch {}
    if (!meId) return;
    for (const {name, rel} of persons) {
      try {
        const se = this.db.prepare('SELECT id FROM entities WHERE name = ?');
        se.bind([name]);
        let eId: number|null = null;
        if (se.step()) eId = (se.getAsObject() as any).id;
        se.free();
        if (!eId) continue;
        this.db.run('DELETE FROM entity_relations WHERE entity_a_id = ? OR entity_b_id = ?', [eId, eId]);
        const a = Math.min(eId, meId), b = Math.max(eId, meId);
        this.db.run('INSERT OR IGNORE INTO entity_relations (entity_a_id,entity_b_id,relation,strength,updated_at) VALUES (?,?,?,1.0,?)', [a, b, rel, now]);
      } catch {}
    }
    this._dirtyCount++;
  }

  /**
   * V16: 修复 knowledge_base（sql.js session 内执行）。替代 fix-xsy-kb.cjs / fix-all-entities-final.cjs。
   * 🔴 通则化改造(2026-09-02): 去除特定 UUID/人名硬编码（徐诗雨/熊梓铭/徐诗韵个案补丁），
   *    改为通用规则——人物档案重复去重对所有实体生效（UUID 管理通则应适用于所有人群）。
   *    个案数据修复（去归属/补建档案）由数据维护流程处理，不再每次启动执行。
   */
  private _fixKnowledgeBase(): void {
    if (!this.db) return;
    // 通则: 人物档案按 belong_entity_uuid 去重（保留最早一条，适用于所有实体）
    try {
      const d = this.db.exec(
        "SELECT belong_entity_uuid, id FROM knowledge_base " +
        "WHERE classification='人物档案' AND belong_entity_uuid IS NOT NULL AND belong_entity_uuid != '' " +
        "ORDER BY created_at ASC"
      );
      if (d.length && d[0].values) {
        const seen = new Map<string, boolean>();
        let dupCount = 0;
        for (const row of d[0].values as any[][]) {
          const [uuid, id] = row;
          if (seen.has(String(uuid))) {
            this.db.run('DELETE FROM knowledge_base WHERE id=?', [String(id)]);
            dupCount++;
          } else {
            seen.set(String(uuid), true);
          }
        }
        if (dupCount > 0) {
          console.log(`[SQLiteAdapter] KB人物档案去重（通则）: 删除 ${dupCount} 条重复档案`);
          this._dirtyCount++;
        }
      }
    } catch {}
  }

  /** V16: 启动时完整性检查 — 4 项核验，输出 PAS S/FAIL/WARN。 */
  private _runIntegrityChecks(): void {
    if (!this.db) return;
    console.log('[SQLiteAdapter] === 完整性检查 ===');
    try {
      const t = this.db.exec("SELECT COUNT(*) FROM memories");
      const l = this.db.exec("SELECT COUNT(*) FROM memories WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != ''");
      const tt = (t.length&&t[0]?.values?.[0]?.[0])?Number(t[0].values[0][0]):0;
      const ll = (l.length&&l[0]?.values?.[0]?.[0])?Number(l[0].values[0][0]):0;
      const r = tt>0?(ll/tt*100):100;
      console.log(`  ${r>=90?'✅':r>=70?'⚠️':'🔴'} CK-M1 记忆标注: ${ll}/${tt}=${r.toFixed(1)}%`);
    } catch {}
    try {
      const me = this.db.exec("SELECT id FROM entities WHERE name='我'");
      const mid = (me.length&&me[0]?.values?.[0]?.[0])?Number(me[0].values[0][0]):null;
      if (mid) {
        const miss: string[] = [];
        for (const n of ['熊梓铭','徐诗雨','徐诗韵','玉瑶']) {
          const s = this.db.prepare('SELECT id FROM entities WHERE name=?');
          s.bind([n]); let e=null; if(s.step())e=(s.getAsObject()as any).id; s.free();
          if(!e){miss.push(n);continue;}
          const a=Math.min(e,mid),b=Math.max(e,mid);
          const er=this.db.exec(`SELECT 1 FROM entity_relations WHERE entity_a_id=${a} AND entity_b_id=${b}`);
          if(!er.length||!er[0]?.values?.length)miss.push(n);
        }
        console.log(`  ${miss.length===0?'✅':'🔴'} CK-M2 实体关系: ${miss.length===0?'全在':'缺:'+miss.join(',')}`);
      }
    } catch {}
    try {
      const o = this.db.exec("SELECT COUNT(*) FROM memories WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid!='' AND belong_entity_uuid NOT IN (SELECT uuid FROM entities WHERE uuid IS NOT NULL AND uuid!='')");
      const oc = (o.length&&o[0]?.values?.[0]?.[0])?Number(o[0].values[0][0]):0;
      console.log(`  ${oc<=5?'✅':'⚠️'} CK-M3 孤儿记忆: ${oc}条`);
    } catch {}
    try {
      const d = this.db.exec("SELECT belong_entity_uuid,COUNT(*)c FROM knowledge_base WHERE belong_entity_uuid IS NOT NULL GROUP BY belong_entity_uuid HAVING c>1");
      const dc = d.length&&d[0]?.values?.length||0;
      console.log(`  ${dc===0?'✅':'⚠️'} CK-M4 KB重复: ${dc}实体`);
    } catch {}
  }

  /**
   * V15: 从 conversations 重建 memories 锚点（同一 sql.js session）。
   * 消除原 rebuild-memories-from-convs.cjs 绕过 SQLiteAdapter 的双写竞争。
   * 每次启动自动执行，幂等（清理旧 ANCHOR → 重建）。
   */
  /**
   * 🔴 V20: 40D 启动补全 — 在 sql.js 内存态内从 24D 派生 40D 写入 perception_40d。
   * 根治 sql.js 整库覆写：backfill（better-sqlite3）写磁盘的数据被 sql.js 内存态覆盖，
   * 此处改为「内存态内补全」→ flush 时随库持久，不再丢失。
   * 幂等：只处理 perception_40d 为空的行。
   */
  private _backfillPerception40D(): number {
    if (!this.db) return 0;
    try {
      // 确认列存在（新库 schema.sql 已含，旧库由 initialize ALTER 补）
      const cols = this.db.exec("PRAGMA table_info(memories)")[0]?.values ?? [];
      if (!cols.some((c: any) => c[1] === 'perception_40d')) return 0;
      // V12.4 阶段B 根除24D: perception_json 列已删（v14 迁移），无派生数据源 → 静默跳过。
      // 40D 缺失行（金库/记事/锚点）由运行时写入方补写，不在此补全。
      if (!cols.some((c: any) => c[1] === 'perception_json')) return 0;

      // 读取有 24D 感知但无 40D 的记忆
      const rows = this.db.exec(
        "SELECT id, perception_json FROM memories WHERE perception_json IS NOT NULL AND (perception_40d IS NULL OR perception_40d = '')"
      )[0]?.values ?? [];

      const KEYS24 = [
        'pleasure','arousal','dominance','aggression','sincerity','humor',
        'factual','logical','certainty','abstract','temporal_focus','self_ref',
        'intimacy','power_diff','dependency','moral_judgment','etiquette','belonging',
        'sexual_attraction','sensory_craving','energy_merge','possessiveness','ecstasy','safety',
      ];
      // 24D → 40D 映射（dim40 为 1-indexed D 编号）
      const MAP = [
        { k: 'self_ref', d: 9 }, { k: 'pleasure', d: 12 }, { k: 'safety', d: 14 },
        { k: 'intimacy', d: 15 }, { k: 'belonging', d: 17 }, { k: 'etiquette', d: 19 },
        { k: 'sexual_attraction', d: 33 }, { k: 'energy_merge', d: 34 }, { k: 'sincerity', d: 35 },
        { k: 'dominance', d: 36 }, { k: 'moral_judgment', d: 37 }, { k: 'humor', d: 38 },
        { k: 'dependency', d: 39 }, { k: 'possessiveness', d: 40 },
      ];

      let updated = 0;
      for (const [id, pJsonRaw] of rows) {
        try {
          const parsed = JSON.parse(String(pJsonRaw));
          const p24 = Array.isArray(parsed) && parsed.length === 24
            ? (() => { const o: Record<string, number> = {}; for (let i = 0; i < 24; i++) o[KEYS24[i]] = Number(parsed[i]) || 0; return o; })()
            : (parsed && typeof parsed === 'object' ? parsed as Record<string, number> : null);
          if (!p24) continue;
          const p40 = new Array(40).fill(0);
          for (const { k, d } of MAP) {
            const v = Number(p24[k]);
            if (isFinite(v)) p40[d - 1] = v;
          }
          // V12.4: 编码标识 — 40D 带 __v 版本（v2 对象格式），decode 向后兼容 v1 纯数组
          this.db.run("UPDATE memories SET perception_40d = ? WHERE id = ?", [JSON.stringify({ __v: PERCEPTION_40D_ENCODING_VERSION, dims: p40 }), String(id)]);
          updated++;
        } catch { /* 单条失败跳过 */ }
      }
      if (updated > 0) console.log(`[V20] 40D 启动补全: ${updated} 条`);
      return updated;
    } catch (e) {
      console.warn('[V20] 40D 补全异常:', (e as Error)?.message);
      return 0;
    }
  }

  /**
   * 🔴 V21: 三库 40D 启动补全 — state_spines / knowledge_base / black_diamond。
   * 与 _backfillPerception40D 同模式（sql.js 内存态内补全 → flush 随库持久）。
   * 幂等：只处理缺 40D 的行。
   *   1. state_spines: 补 dimension_id 25-40（值 0 占位，待瑶光/瑶灵数据源）
   *   2. knowledge_base: emotion_vector 24 数组 → 40D（14 维映射 + 26 维 0）
   *   3. black_diamond: emotion_vector（存时间戳异常）→ 40D 默认数组
   */
  private _backfillLibs40D(): number {
    if (!this.db) return 0;
    let total = 0;
    try {
      // ── 1. state_spines 补 25-40 维 ──
      try {
        const maxDim = this.db.exec("SELECT MAX(dimension_id) m FROM state_spines")[0]?.values?.[0]?.[0] ?? 0;
        if (Number(maxDim) < 40) {
          const uids = this.db.exec("SELECT DISTINCT global_uid FROM state_spines WHERE dimension_id IN (1,2,3)")[0]?.values ?? [];
          for (const [uid] of uids) {
            for (let d = Number(maxDim) + 1; d <= 40; d++) {
              this.db.run(
                "INSERT OR REPLACE INTO state_spines (global_uid, dimension_id, value, consistency_mark, location_fingerprint, timestamp_ms, checksum) VALUES (?, ?, 0, 'consistent', 'backfill_40d', ?, '')",
                [String(uid), d, Date.now()]
              );
              total++;
            }
          }
          if (total > 0) console.log(`[V21] state_spines 40D 补齐: ${total} 行 (25-40维)`);
        }
      } catch (e) { console.warn('[V21] state_spines 40D 补齐异常:', (e as Error)?.message); }

      // ── 2. knowledge_base emotion_vector 24→40D ──
      try {
        const kbRows = this.db.exec(
          "SELECT id, emotion_vector FROM knowledge_base WHERE emotion_vector IS NOT NULL AND emotion_vector != ''"
        )[0]?.values ?? [];
        const KEYS24 = ['pleasure','arousal','dominance','aggression','sincerity','humor','factual','logical','certainty','abstract','temporal_focus','self_ref','intimacy','power_diff','dependency','moral_judgment','etiquette','belonging','sexual_attraction','sensory_craving','energy_merge','possessiveness','ecstasy','safety'];
        const MAP = [
          { k: 'self_ref', d: 9 }, { k: 'pleasure', d: 12 }, { k: 'safety', d: 14 },
          { k: 'intimacy', d: 15 }, { k: 'belonging', d: 17 }, { k: 'etiquette', d: 19 },
          { k: 'sexual_attraction', d: 33 }, { k: 'energy_merge', d: 34 }, { k: 'sincerity', d: 35 },
          { k: 'dominance', d: 36 }, { k: 'moral_judgment', d: 37 }, { k: 'humor', d: 38 },
          { k: 'dependency', d: 39 }, { k: 'possessiveness', d: 40 },
        ];
        let kbUpdated = 0;
        for (const [id, evRaw] of kbRows) {
          try {
            const parsed = JSON.parse(String(evRaw));
            if (!Array.isArray(parsed) || parsed.length !== 24) continue;
            const p24: Record<string, number> = {};
            for (let i = 0; i < 24; i++) p24[KEYS24[i]] = Number(parsed[i]) || 0;
            const p40 = new Array(40).fill(0);
            for (const { k, d } of MAP) { if (isFinite(p24[k])) p40[d - 1] = p24[k]; }
            this.db.run("UPDATE knowledge_base SET emotion_vector = ? WHERE id = ?", [JSON.stringify(p40), String(id)]);
            kbUpdated++;
          } catch { /* 跳过坏行 */ }
        }
        if (kbUpdated > 0) console.log(`[V21] knowledge_base 40D 补齐: ${kbUpdated} 条`);
      } catch (e) { console.warn('[V21] knowledge_base 40D 补齐异常:', (e as Error)?.message); }

      // ── 3. black_diamond emotion_vector 修复为 40D ──
      try {
        const bdRows = this.db.exec("SELECT id, emotion_vector FROM black_diamond")[0]?.values ?? [];
        let bdUpdated = 0;
        for (const [id, evRaw] of bdRows) {
          try {
            // V12.4 阶段B: 用 decodePerceptionV40 识别 v1纯数组 与 v2对象（{__v:2,dims}）→ 已是 40D 跳过
            const dec = decodePerceptionV40(evRaw ? String(evRaw) : null);
            if (dec) continue;
            // 非 40D（时间戳/24D/空）→ 写 40D 默认数组（v1 纯数组，兼容）
            this.db.run("UPDATE black_diamond SET emotion_vector = ? WHERE id = ?", [JSON.stringify(new Array(40).fill(0)), String(id)]);
            bdUpdated++;
          } catch { /* 空/坏 → 写默认 */ }
        }
        if (bdUpdated > 0) console.log(`[V21] black_diamond 40D 补齐: ${bdUpdated} 条`);
      } catch (e) { console.warn('[V21] black_diamond 40D 补齐异常:', (e as Error)?.message); }

      return total;
    } catch (e) {
      console.warn('[V21] 三库 40D 补齐异常:', (e as Error)?.message);
      return 0;
    }
  }

  /**
   * 🔴 V12.4: 存量 40D 编码升级 — v1 纯数组 → v2 `{__v:2,dims:[...]}`。
   * 幂等：只处理非空且为纯数组格式（v1）的行；已是 v2/命名对象/空 的行跳过。
   * 在 sql.js 内存态内执行，flush 时随库持久。
   */
  private _upgradePerception40DToV2(): number {
    if (!this.db) return 0;
    try {
      const cols = this.db.exec("PRAGMA table_info(memories)")[0]?.values ?? [];
      if (!cols.some((c: any) => c[1] === 'perception_40d')) return 0;
      const rows = this.db.exec(
        "SELECT id, perception_40d FROM memories WHERE perception_40d IS NOT NULL AND perception_40d != ''"
      )[0]?.values ?? [];
      let upgraded = 0;
      let skippedV2 = 0;
      for (const [id, pJsonRaw] of rows) {
        try {
          const parsed = JSON.parse(String(pJsonRaw));
          // 已是 v2 对象（__v / dims）→ 跳过
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.dims)) {
            skippedV2++;
            continue;
          }
          // 纯数组 v1 → 升级为 v2
          if (Array.isArray(parsed) && parsed.length === 40) {
            this.db.run("UPDATE memories SET perception_40d = ? WHERE id = ?", [JSON.stringify({ __v: PERCEPTION_40D_ENCODING_VERSION, dims: parsed }), String(id)]);
            upgraded++;
          }
        } catch { /* 单条解析失败跳过 */ }
      }
      if (upgraded > 0) console.log(`[V12.4] 40D 编码升级 v1→v2: ${upgraded} 条（已 v2 ${skippedV2} 条）`);
      else if (skippedV2 > 0) console.log(`[V12.4] 40D 编码已是 v2: ${skippedV2} 条，无需升级`);
      return upgraded;
    } catch (e) {
      console.warn('[V12.4] 40D 编码升级异常:', (e as Error)?.message);
      return 0;
    }
  }

  private _rebuildMemoryAnchors(): number {
    if (!this.db) return 0;
    const now = new Date().toISOString();
    // 🔴 S2-H1: 移除角色扮演误判 — 系统已只有会晤模式。
    // 原 RP_RE 把含家庭称谓(爸爸/妈妈/哥哥/妹妹)的对话误判为 roleplay → 会晤记忆被正常检索排除
    // (实测: 熊梓铭会晤对话"梓铭。是你吗/介绍一下你自己/说说你的经历"全被标 roleplay)。
    // 系统只有会晤模式后，对话组锚点统一为 normal 记忆。const RP_RE 已删除。

    // V18: 重建前存量空 UUID 锚点统计 — DELETE 之前检测，暴露运行时 flush 写入的空 UUID 锚点
    //     （重建产物恒带 UUID，只有重建前残留的空 UUID 锚点能反映运行时对话闭组未归实体）
    try {
      const preRes = this.db.exec(
        "SELECT COUNT(*) FROM memories WHERE id LIKE '%\\_ANCHOR' ESCAPE '\\' AND (belong_entity_uuid IS NULL OR belong_entity_uuid = '')"
      );
      const preNull = (preRes.length && preRes[0]?.values?.[0]?.[0]) ? Number(preRes[0].values[0][0]) : 0;
      if (preNull > 0) {
        console.warn(`[SQLiteAdapter] ⚠️ ANCHOR存量: 重建前发现 ${preNull} 条空UUID锚点 — 运行时对话闭组未归实体`);
      }
    } catch { /* 统计失败不阻塞 */ }

    // 清理旧 ANCHOR
    try { this.db.run("DELETE FROM memories WHERE id LIKE '%_ANCHOR' OR id LIKE '%_CHUNK%'"); } catch {}

    // 按对话组聚合
    const groups = this.db.exec(
      "SELECT dg.dialog_group_id, dg.belong_entity_uuid, dg.tc, dg.first_ts, dg.last_ts, dg.avg_ca, dg.max_ca " +
      "FROM (SELECT dialog_group_id, belong_entity_uuid, COUNT(*) as tc, MIN(timestamp) as first_ts, " +
      "MAX(timestamp) as last_ts, AVG(COALESCE(calcium_score,0.5)) as avg_ca, " +
      "MAX(COALESCE(calcium_score,0.5)) as max_ca FROM conversations " +
      "WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != '' AND dialog_group_id IS NOT NULL " +
      "GROUP BY dialog_group_id, belong_entity_uuid) dg ORDER BY dg.belong_entity_uuid, dg.first_ts"
    );
    if (!groups.length || !groups[0]?.values?.length) return 0;

    // entity UUID → name
    const entMap = new Map<string, string>();
    try {
      const ents = this.db.exec("SELECT uuid, name FROM entities WHERE type = 'person' AND uuid IS NOT NULL");
      if (ents.length && ents[0].values) {
        for (const [u, n] of ents[0].values) entMap.set(String(u), String(n));
      }
    } catch {}

    // seq_pos 起始值
    let seq = 1;
    try {
      const mx = this.db.exec("SELECT COALESCE(MAX(seq_pos),0)+1 FROM memories");
      if (mx.length && mx[0].values?.[0]?.[0]) seq = Number(mx[0].values[0][0]) || 1;
    } catch {}

    let n = 0, nSkipped = 0;
    for (const [dgId, eUuid, _tc, firstTs, _lastTs, avgCa, maxCa] of (groups[0].values as any[][])) {
      const dg = String(dgId), eu = String(eUuid || '');
      if (!eu) { nSkipped++; continue; }  // 空 UUID 跳过
      const ename = entMap.get(eu) || eu;
      const id = dg + '_ANCHOR';

      const tvs: any[][] = [];
      try {
        const stmt = this.db!.prepare(
          "SELECT role, content FROM conversations WHERE dialog_group_id = ? AND belong_entity_uuid = ? ORDER BY timestamp LIMIT 10"
        );
        stmt.bind([dg, eu]);
        while (stmt.step()) {
          const row = stmt.getAsObject();
          tvs.push([row.role, row.content]);
        }
        stmt.free();
      } catch {}
      if (tvs.length === 0) continue;

      const pts: string[] = ['【核心·' + ename + '】'];
      for (const [role, content] of tvs as any[][]) {
        pts.push((String(role) === 'user' ? '鸿艺' : ename) + '：' + String(content || '').substring(0, 150));
      }
      const raw = pts.join('\n').substring(0, 4000);

      // 🔴 S2-H1: 统一为 normal 记忆（角色扮演误判已移除）
      const kind = 'normal';

      const ca = Math.min(9.99, parseFloat(((Number(maxCa) || Number(avgCa) || 0.5)).toFixed(3)));
      const cl = ca >= 2 ? 3 : ca >= 1 ? 2 : ca >= 0.5 ? 1 : 0;
      const es = Math.min(1.0, ca * 0.8);

      // 🆕 编码健康修复: 从 conversations 继承规范 global_uid/dna_root_id/location_fingerprint（否则重建的锚点无 UID/DNA/fp）
      let anchorGlobalUid = '', anchorDnaRootId = '', anchorLocationFp = '';
      try {
        const guRes = this.execSql(
          "SELECT global_uid, dna_root_id, location_fingerprint FROM conversations WHERE dialog_group_id = ? AND belong_entity_uuid = ? AND length(trim(COALESCE(global_uid,''))) = 23 AND trim(COALESCE(dna_root_id,'')) != '' ORDER BY timestamp LIMIT 1",
          [dg, eu],
        );
        if (guRes.length && guRes[0].values?.[0]) {
          anchorGlobalUid = String(guRes[0].values[0][0] || '');
          anchorDnaRootId = String(guRes[0].values[0][1] || '');
          anchorLocationFp = String(guRes[0].values[0][2] || '');
        }
      } catch (err) {
        console.warn('[SQLiteAdapter] 锚点身份继承查询失败:', (err as Error)?.message);
      }
      try {
        // V12.4 阶段B 根除24D: 锚点不再写 perception_json；默认 40D v2 全零（S4 P1-2 修复：
        //   与 encodeEmptyPerceptionV40/flushDialogGroup 空默认一致，对话组摘要不参与情感余弦）
        const anchor40D = encodeEmptyPerceptionV40();
        this.db!.run(
          "INSERT OR REPLACE INTO memories (id,seq_pos,created_at,perception_40d,calcium_score,calcium_level," +
          "locus_path,leaf_zone,raw_input,memory_kind,lifecycle_state,confidence_score,stability_score," +
          "thread_id,recall_count,promoted_to_diamond,effective_strength,strength_updated_at," +
          "is_landmark,primary_emotion,memory_type,dialog_group_id,belong_entity_uuid," +
          "global_uid,dna_root_id,location_fingerprint," +
          "is_foresight,valid_until_ms,foresight_status,source_type) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,1,?,'dialog',?,?,?,?,?,0,NULL,'none','conversation')",
          [id, seq++, String(firstTs || now),
           anchor40D,
           ca, cl, 'user.misc.default', 'language_semantic_zone', raw, kind,
           cl >= 2 ? 'active' : 'candidate', 0.55, cl >= 2 ? 0.45 : 0.2,
           dg, es, now, '平静', dg, eu,
           anchorGlobalUid, anchorDnaRootId, anchorLocationFp || '0'.repeat(32)]
        );
        n++;
      } catch { /* 单条失败不阻塞 */ }
      if (n % 100 === 0) console.log(`[SQLiteAdapter] memories锚点进度: ${n}条`);
    }
    if (nSkipped > 0) console.log(`[SQLiteAdapter] memories锚点跳过: ${nSkipped}条(空UUID)`);
    if (n > 0) {
      this._dirtyCount += Math.ceil(n / 10);
      // 🔴 V16: 强制立即落盘 — 防止 AlignmentGuard 后续写操作前 server 崩溃丢失数据
      try {
        this.flushNow();
        console.log(`[SQLiteAdapter] memories锚点落盘完成: ${n}条`);
      } catch (e) { console.warn('[SQLiteAdapter] memories锚点落盘失败:', (e as Error)?.message); }
      // 落盘后验证
      try {
        const vfy = this.db.exec("SELECT COUNT(*) FROM memories WHERE id LIKE '%_ANCHOR' AND belong_entity_uuid IS NOT NULL AND belong_entity_uuid != ''");
        const vfyCount = (vfy.length && vfy[0]?.values?.[0]?.[0]) ? Number(vfy[0].values[0][0]) : 0;
        if (vfyCount < n * 0.8) console.warn(`[SQLiteAdapter] ⚠️ 锚点自检异常: 写入${n}条 查询到${vfyCount}条有UUID`);
      } catch {}
    }
    return n;
  }

  /** 将内存数据库持久化到磁盘（批量 flush，非每次写入都落盘） */
  private save(): void {
    if (!this.db) return;
    this._dirtyCount++;

    // 每 _FLUSH_BATCH 次直接落盘
    if (this._dirtyCount >= this._FLUSH_BATCH) {
      this.flushNow();
      return;
    }

    // 否则设定时器兜底（_FLUSH_INTERVAL 内没有再触发 save 则落盘）
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this.flushNow();
      }, this._FLUSH_INTERVAL);
    }
  }

  /**
   * C4: 供共享同一 sql.js 实例的 ConversationDB 委托调用。
   * ConversationDB 写入共享 db 后调用此方法，把 db 标记为脏并调度防抖落盘，
   * 由 SQLiteAdapter 统一 export 一次（避免两个类各自 export 同一个 96MB 库）。
   */
  scheduleFlush(): void {
    this.save();
  }

  /** P0-3: 强制立即落盘（公开方法，供 handleShutdown 和关键路径调用） */
  flushNow(): void {
    if (!this.db || this._dirtyCount === 0) return;
    try {
      const data = (this.db as any).export();
      const buffer = Buffer.from(data);
      writeFileSync(this.dbPath, buffer);
      this._dirtyCount = 0;
    } catch (err) {
      console.error('[SQLiteAdapter] flushNow failed:', err);
    }
    this._clearFlushTimer();
  }

  /** P0-3: 关闭前安全落盘 — 清定时器 → 强制落盘 → 关闭数据库 */
  shutdownFlush(): void {
    this._clearFlushTimer();
    if (this.db && this._dirtyCount > 0) {
      try {
        const data = (this.db as any).export();
        writeFileSync(this.dbPath, Buffer.from(data));
        this._dirtyCount = 0;
        console.log('[SQLiteAdapter] shutdownFlush: 关闭前落盘完成');
      } catch (err) {
        console.error('[SQLiteAdapter] shutdownFlush failed:', err);
      }
    }
    if (this.db) {
      try { this.db.close(); } catch { /* best effort */ }
      this.db = undefined as any;
      this.ready = false;
    }
  }

  private _clearFlushTimer(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }

  /** sql.js 的 run 方法运行时接受 params，但类型定义可能不完整 */
  private runSql(sql: string, params?: any[]): void {
    (this.db as any).run(sql, params);
  }

  /** 带参数的 exec 查询 */
  private execSql(sql: string, params?: any[]): Array<{ columns: string[]; values: any[][] }> {
    if (params) {
      const stmt = (this.db as any).prepare(sql);
      stmt.bind(params);
      const results: any[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      // 包装为 exec 返回格式
      if (results.length === 0) return [];
      const columns = Object.keys(results[0]);
      const values = results.map(r => columns.map(c => r[c]));
      return [{ columns, values }];
    }
    return (this.db as any).exec(sql);
  }

  private rowToRecord(row: any[] | Record<string, any>, columns?: string[]): EmotionalMemoryRecord {
    // 支持 exec() 返回的两种格式
    let obj: Record<string, any>;
    if (Array.isArray(row) && columns) {
      obj = {};
      for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
    } else {
      obj = row as Record<string, any>;
    }

    // V12.4 阶段B 根除24D: 感知向量唯一来源 = perception_40d 列（v2 兼容 decode），
    // 反解 24D 仅 14 维真实、10 维中性 0.5（无槽位字段不落库）。
    const p40 = decodePerceptionV40(obj.perception_40d);
    const perception = perceptionV40To24D(p40);

    return {
      id: obj.id,
      seq_pos: obj.seq_pos,
      created_at: obj.created_at,
      perception,
      // S4 P1-1 根治: 无 40D 行 → 全零 PerceptionV40（而非 undefined）。
      // 全零对象经 cosineSimilarity40D 恒得 0（norm=0 → 返回0），write() 读-改-写也恒写全零，不制造 14×0.5 假签名。
      perceptionV40: decodePerceptionV40(obj.perception_40d) ?? createEmptyPerceptionV40(), // V12.4 40D 唯一落库
      calcium_score: obj.calcium_score,
      calcium_level: obj.calcium_level as 0 | 1 | 2 | 3,
      raw_input: obj.raw_input,
      locus_path: obj.locus_path,
      entity_genes: [], // 实体会在 rowsToRecords 或 findById 中填充
      leaf_zone: obj.leaf_zone,
      memory_kind: obj.memory_kind ?? 'episodic',
      lifecycle_state: obj.lifecycle_state ?? 'candidate',
      confidence_score: obj.confidence_score ?? 0.5,
      stability_score: obj.stability_score ?? 0.5,
      last_verified_at: obj.last_verified_at ?? null,
      promotion_reason: obj.promotion_reason ?? undefined,
      suppression_reason: obj.suppression_reason ?? undefined,
      archived_at: obj.archived_at ?? null,
      healed_at: obj.healed_at ?? null,
      thread_id: obj.thread_id ?? obj.dialog_group_id ?? obj.dna_root_id ?? obj.id,
      session_id: obj.session_id ?? undefined,
      dialog_group_id: obj.dialog_group_id ?? undefined,
      source_conversation_ids: obj.source_conversation_ids ? JSON.parse(obj.source_conversation_ids) : undefined,
      recall_count: obj.recall_count ?? 0,
      last_recalled_at: obj.last_recalled_at ?? null,
      reinforcement_accumulator: obj.reinforcement_accumulator ?? 0,
      effective_strength: obj.effective_strength ?? 1.0,
      strength_updated_at: obj.strength_updated_at ?? obj.created_at,
      is_landmark: obj.is_landmark === 1 || obj.is_landmark === true,
      landmarked_at: obj.landmarked_at ?? null,
      narrative_tag: obj.narrative_tag ?? undefined,
      sensory_anchor: obj.sensory_anchor ?? undefined,
      scar: obj.scar_type ? {
        type: obj.scar_type,
        healed: obj.scar_healed === 1,
        healed_at: null,
      } : undefined,
      vad_spectrum: obj.vad_spectrum ? JSON.parse(obj.vad_spectrum) : null,
      primary_emotion: obj.primary_emotion ?? undefined,
      secondary_emotions: obj.secondary_emotions ? JSON.parse(obj.secondary_emotions) : undefined,
      promoted_to_diamond: obj.promoted_to_diamond === 1 || obj.promoted_to_diamond === true,
      // V13: Foresight 前瞻时态
      isForesight: obj.is_foresight === 1 || obj.is_foresight === true,
      validStartMs: obj.valid_start_ms ?? null,
      validUntilMs: obj.valid_until_ms ?? null,
      foresightStatus: obj.foresight_status ?? null,
      dna_root_id: obj.dna_root_id ?? undefined,
      // 🆕 编码健康修复: 映射 global_uid（此前遗漏 → 读-改-写路径如 promoteToLandmark/runDecayMaintenance
      //   write() 回写时 global_uid=undefined → SQLiteAdapter.write() 走 || fallback 生成 MM+hash8 垃圾 UID）
      global_uid: obj.global_uid ?? undefined,
      // V18: 补齐 belongEntityUuid — 此前 rowToRecord 遗漏该字段，
      //   导致 runDecayMaintenance 等"读-改-写"路径 write() 回写时 belongEntityUuid=undefined→NULL，
      //   全库 memories UUID 被清空（徐诗雨/熊梓铭记忆归零根因）。
      belongEntityUuid: obj.belong_entity_uuid ?? null,
    };
  }

  private rowsToRecords(results: Array<{ columns: string[]; values: any[][] }>): EmotionalMemoryRecord[] {
    if (results.length === 0) return [];
    const { columns, values } = results[0];
    const records = values.map((row: any[]) => this.rowToRecord(row, columns));

    // 批量加载实体关联（替代 N+1 单条查询）
    if (records.length > 0) {
      try {
        const ids = records.map(r => r.id).filter(Boolean);
        if (ids.length > 0) {
          const placeholders = ids.map(() => '?').join(',');
          const entRes = this.execSql(
            `SELECT me.memory_id, e.name, e.type, me.allele, me.phenotype, me.knowledge_type
             FROM memory_entities me JOIN entities e ON me.entity_id = e.id
             WHERE me.memory_id IN (${placeholders})`,
            ids,
          );
          if (entRes.length > 0) {
            // 将实体按 memory_id 分组
            const entityMap = new Map<string, EntityGene[]>();
            for (const rowVals of entRes[0].values) {
              const cols = entRes[0].columns;
              const rowObj: Record<string, any> = {};
              for (let i = 0; i < cols.length; i++) rowObj[cols[i]] = rowVals[i];
              const mid = rowObj.memory_id as string;
              if (!entityMap.has(mid)) entityMap.set(mid, []);
              entityMap.get(mid)!.push({
                name: rowObj.name as string,
                type: rowObj.type as any,
                allele: rowObj.allele as string,
                phenotype: rowObj.phenotype as any,
                knowledge_type: rowObj.knowledge_type as any,
              });
            }
            // 将批量加载的实体应用到每条记录
            for (const rec of records) {
              if (entityMap.has(rec.id)) {
                rec.entity_genes = entityMap.get(rec.id)!;
              }
            }
          }
        }
      } catch (err) {
        console.warn('[SQLite] 批量加载实体失败:', err);
      }
    }

    return records;
  }
}
