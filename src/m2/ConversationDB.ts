/**
 * ConversationDB — P0-9 对话独立存储库（已合入 fusion_memory.db）
 *
 * v2.0: 构造函数接受 existingDb 参数，共享 sql.js 实例而非独立文件。
 * 保留独立文件模式向后兼容。flush 在共享模式下为空操作
 *（由 SQLiteAdapter 统一落盘管理）。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
// C3(2026-09-11): 实体名序列化收口到 EntityNameCodec（唯一事实源）
import { formatNames } from './EntityNameCodec.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_DB_PATH = join(PROJECT_ROOT, 'data', 'webui', 'conversations.db');

// ════════════════════════════════════════════════════════════════════
// 🔴 conversations 列清单的【单一事实源】（2026-09-19 批 2 · arch_structural_defect）
// ════════════════════════════════════════════════════════════════════
// 背景（架构级缺陷，非单点 bug）：conversations 一度有**两个写入点各自手写列清单** ——
//   本文件 insertConversation（22 列 ✅）与 SQLiteAdapter.insertConversation（13 列 ❌）。
// 漂移后果（实测）：
//   ① message_id 仅 4/3949；② belong_entity_uuid 在该路径恒 NULL；
//   ③ entity_names 形态分裂：实库 2786 行为逗号分隔（本文件走 formatNames），
//      而 SQLiteAdapter 侧用 JSON.stringify 写 → 潜在格式污染（实库 JSON 形态 0 行，属未爆雷）；
//   ④ is_compacted 与 is_summary 两个占位符被绑到同一个 compacted 值 →
//      maintenance.ts 的【对话摘要】条目 is_summary 恒 0（13 条摘要实测 2 条为 0）★ V23.1 修复未同步。
//
// 现规定：**任何写入 conversations 的代码必须经 buildConversationInsert()**，
// 禁止再手写列清单（也不得复制本文件里的 SQL 字符串）。
// 同仓先例：EntityNameCodec.ENTITY_NAME_COLUMNS（列名单一事实源）。
// 关键性质：bind 顺序**由列清单本身派生**，故「SQL 占位符数 ≠ bind 数」与「列/值错位」
// 在结构上不可能发生（历史事故 D5/P1 均源于两处各写一份）。
// ════════════════════════════════════════════════════════════════════

export interface ConversationRowInput {
  role: string;
  content: string;
  timestamp: string;
  seqPos?: number | null;
  topic?: string | null;
  /** 实体名数组；序列化统一走 EntityNameCodec.formatNames（逗号分隔，实库既定形态） */
  entityNames?: readonly string[] | null;
  /** 感知快照，以 JSON 文本落 perception_summary 列。
   *  类型放宽为 Record<string, number>：两个调用方的声明本就不同
   *  （ConversationDB 用 Record<string, number>，SQLiteAdapter 用具名三元组 pleasure/arousal/intimacy），
   *  收口到同一构造器后必须能同时接受；列内容语义不变。 */
  perception?: Record<string, number> | null;
  calciumScore?: number | null;
  dnaRootId?: string | null;
  globalUid?: string | null;
  locationFingerprint?: string | null;
  dialogGroupId?: string | null;
  dialogRound?: number | null;
  isTest?: number | null;
  isCompacted?: number | null;
  /** 🔴 V23.1：必须与 is_compacted **独立取值**。摘要是压缩的产物，不应再被归档流程压掉 */
  isSummary?: number | null;
  roleplayChar?: string | null;
  namespace?: string | null;
  belongEntityUuid?: string | null;
  mentionedEntityUuids?: readonly string[] | null;
  /** G1-A3c1: 逻辑消息 canonical atom record ID（原值写入，不 trim/coerce/生成/复用） */
  messageId?: string | null;
}

/** 列清单（写入顺序 = 本数组顺序；新增列必须同步此处） */
export const CONVERSATION_INSERT_COLUMNS = [
  'role', 'content', 'timestamp', 'seq_pos', 'topic', 'entity_names', 'perception_summary',
  'calcium_score', 'dna_root_id', 'global_uid', 'location_fingerprint', 'dialog_group_id',
  'dialog_round', 'is_test', 'is_compacted', 'is_summary', 'roleplay_char', 'is_promoted',
  'namespace', 'belong_entity_uuid', 'mentioned_entity_uuids', 'message_id',
] as const;

/** 无绑定值的固定字面量列（is_promoted 由后续流程置位，写入时恒 0；恪守「只增不删」） */
export const CONVERSATION_FIXED_LITERALS: Readonly<Record<string, string>> = { is_promoted: '0' };

/** 需要绑定的列（= 列清单去掉固定字面量列）；**bind 顺序即此顺序**，供调用方/测试核对而不必自行推导 */
export const CONVERSATION_BOUND_COLUMNS: readonly string[] = CONVERSATION_INSERT_COLUMNS.filter(
  (c) => !(c in CONVERSATION_FIXED_LITERALS),
);

/** 唯一写构造器：同时产出 SQL 与 bind，二者顺序同源 */
export function buildConversationInsert(input: ConversationRowInput): { sql: string; bind: unknown[] } {
  const values: Record<string, unknown> = {
    role: input.role,
    content: input.content,
    timestamp: input.timestamp,
    seq_pos: input.seqPos ?? 0,
    topic: input.topic || '',
    entity_names: formatNames(input.entityNames),
    perception_summary: input.perception ? JSON.stringify(input.perception) : '',
    calcium_score: input.calciumScore || 0,
    dna_root_id: input.dnaRootId || null,
    global_uid: input.globalUid || null,
    location_fingerprint: input.locationFingerprint || null,
    dialog_group_id: input.dialogGroupId || null,
    dialog_round: input.dialogRound ?? null,
    is_test: input.isTest ?? 0,
    is_compacted: input.isCompacted ?? 0,
    is_summary: input.isSummary ?? 0,
    roleplay_char: input.roleplayChar || null,
    namespace: input.namespace || 'default',
    belong_entity_uuid: input.belongEntityUuid || null,
    mentioned_entity_uuids: input.mentionedEntityUuids ? JSON.stringify(input.mentionedEntityUuids) : null,
    message_id: input.messageId ?? null,
  };
  const cols: readonly string[] = CONVERSATION_INSERT_COLUMNS;
  const slot = (c: string): string => (c in CONVERSATION_FIXED_LITERALS ? CONVERSATION_FIXED_LITERALS[c] : '?');
  const sql = `INSERT INTO conversations (${cols.join(', ')}) VALUES (${cols.map(slot).join(', ')})`;
  const bind = cols.filter((c) => !(c in CONVERSATION_FIXED_LITERALS)).map((c) => values[c]);
  return { sql, bind };
}

interface ConversationRow {
  id: number;
  role: string;
  content: string;
  timestamp: string;
  topic?: string;
  entity_names?: string;
  is_summary: number;
  seq_pos: number;
  perception_summary?: string;
  calcium_score?: number;
  /** V12.2: 实体归属UUID — 跨重启保留对话归属 */
  belong_entity_uuid?: string;
}

export class ConversationDB {
  private db: any = null;
  private dbPath: string;
  private initialized = false;
  private sharedMode = false;
  /** C4: 共享模式下，把落盘委托给共享 db 的 owner（SQLiteAdapter），避免重复 export 同一 96MB 库 */
  private _flushCoordinator: (() => void) | null = null;
  /** C4: 独立模式的防抖落盘状态 */
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _dirty = false;
  private readonly _FLUSH_INTERVAL = 150;

  constructor(dbPath?: string, existingDb?: any, flushCoordinator?: () => void) {
    if (existingDb) {
      this.db = existingDb;        // 共享 fusion_memory.db 实例
      this.sharedMode = true;
      this.initialized = true;
      // C4: 共享模式下仍需知道真实路径以便独立落盘兜底
      this.dbPath = dbPath || DEFAULT_DB_PATH;
      // C4: 委托给 owner 统一落盘（未提供则回退独立防抖落盘，仍然正确只是可能重复 export）
      this._flushCoordinator = flushCoordinator || null;
      return;
    }
    this.dbPath = dbPath || DEFAULT_DB_PATH;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      if (this.sharedMode) {
        // 共享模式下确保新字段存在（ALTER TABLE 兼容旧库）
        this.ensureFields();
      }
      return;
    }
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();

    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(this.dbPath)) {
      const buf = readFileSync(this.dbPath);
      this.db = new SQL.Database(buf);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
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
        namespace TEXT DEFAULT 'default',
        belong_entity_uuid TEXT,
        mentioned_entity_uuids TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_seq ON conversations(seq_pos)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_dna_root ON conversations(dna_root_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_dg ON conversations(dialog_group_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_promoted ON conversations(is_promoted)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_message_id ON conversations(message_id)`);
    // 🆕 V10.0 P0-3: 独立模式也确保新字段存在（global_uid, location_fingerprint 等）
    this.ensureFields();
    this.initialized = true;
    console.log('[ConversationDB] 初始化完成: ' + this.dbPath);
  }

  /** 共享模式下兼容旧库字段 */
  private ensureFields(): void {
    if (!this.db) return;
    try { this.db.run("ALTER TABLE conversations ADD COLUMN dna_root_id TEXT"); } catch {}
    try { this.db.run("ALTER TABLE conversations ADD COLUMN dialog_group_id TEXT"); } catch {}
    try { this.db.run("ALTER TABLE conversations ADD COLUMN dialog_round INTEGER DEFAULT 0"); } catch {}
    try { this.db.run("ALTER TABLE conversations ADD COLUMN is_compacted INTEGER DEFAULT 0"); } catch {}
    try { this.db.run("ALTER TABLE conversations ADD COLUMN is_test INTEGER DEFAULT 0"); } catch {}
    try { this.db.run("ALTER TABLE conversations ADD COLUMN is_summary INTEGER DEFAULT 0"); } catch {}
    try { this.db.run("ALTER TABLE conversations ADD COLUMN is_promoted INTEGER DEFAULT 0"); } catch {}
    try { this.db.run("ALTER TABLE conversations ADD COLUMN summary_of_range TEXT"); } catch {}
    try { this.db.run("ALTER TABLE conversations ADD COLUMN roleplay_char TEXT"); } catch {} // 🎭 角色扮演标记
    try { this.db.run("ALTER TABLE conversations ADD COLUMN message_id TEXT"); } catch {}
    try { this.db.run("ALTER TABLE conversations ADD COLUMN namespace TEXT DEFAULT 'default'"); } catch {}
    try { this.db.run("ALTER TABLE conversations ADD COLUMN belong_entity_uuid TEXT"); } catch {} /* V3.2 */
    try { this.db.run("ALTER TABLE conversations ADD COLUMN mentioned_entity_uuids TEXT"); } catch {} /* P0-2 */
    try { this.db.run("ALTER TABLE conversations ADD COLUMN global_uid TEXT"); } catch {} /* V10.0 P0-3 */
    try { this.db.run("ALTER TABLE conversations ADD COLUMN location_fingerprint TEXT"); } catch {} /* V10.0 P0-3 */
    try { this.db.run("ALTER TABLE knowledge_base ADD COLUMN belong_entity_uuid TEXT"); } catch {} /* V3.2 */
  }

  insertConversation(role: string, content: string, options?: {
    seqPos?: number;
    topic?: string;
    entityNames?: string[];
    perception?: Record<string, number>;
    calciumScore?: number;
    dnaRootId?: string;
    globalUid?: string;
    locationFingerprint?: string;
    dialogGroupId?: string;
    dialogRound?: number;
    isTest?: number;
    isCompacted?: number;
    /**
     * V23.1(2026-09-13) 摘要条目标记 —— **与 isCompacted 独立**。
     *
     * 原实现没有本字段，写入时把 `is_compacted` 的值同时赋给 `is_summary`（注释称"过渡兼容"），
     * 导致摘要条目**永远落不了 `is_summary=1`** —— 生产实测 11 条 `【对话摘要】` 记录
     * 全部 `is_summary=0`，砂金库的"压缩→摘要"通道形同虚设。
     *
     * 语义：摘要条目应 `is_summary=1` 且 `is_compacted=0` —— 它本身是压缩的**产物**，
     * 不应再被归档流程压掉（归档 SQL 也已同步加 `is_summary=0` 豁免）。
     */
    isSummary?: number;
    roleplayChar?: string;
    namespace?: string;
    /** V3.2: 户籍卷宗归档 — 此对话归属的实体 UUID */
    belongEntityUuid?: string;
    /** P0-2: 消息内提到的人/实体 UUID 集合（FG 图谱旁路，不参与记忆归属与检索） */
    mentionedEntityUuids?: string[];
    /** G1-A3c1: 逻辑消息的 canonical atom record ID；与 GlobalUID/DNA root 独立。原值写入，不 trim/coerce/生成/复用 */
    messageId?: string;
  }): number {
    this.ensureReady();
    const seqPos = options?.seqPos ?? 0;
    const timestamp = new Date().toISOString();
    // 🔴 2026-09-19 批 2：列清单 + 绑定顺序 + 序列化格式全部收口到 buildConversationInsert（单一事实源）。
    //   原实现在此处内联 22 列 SQL 与 bind 数组 —— 与 SQLiteAdapter 那份 13 列 SQL 形成双通道漂移。
    //   V23.1 的 is_summary/is_compacted 独立性说明已随实现移入构造器（那里是 is_summary 的真身）。
    const { sql, bind } = buildConversationInsert({
      role, content, timestamp, seqPos,
      topic: options?.topic,
      entityNames: options?.entityNames,
      perception: options?.perception,
      calciumScore: options?.calciumScore,
      dnaRootId: options?.dnaRootId,
      globalUid: options?.globalUid,
      locationFingerprint: options?.locationFingerprint,
      dialogGroupId: options?.dialogGroupId,
      dialogRound: options?.dialogRound,
      isTest: options?.isTest,
      isCompacted: options?.isCompacted,
      isSummary: options?.isSummary,
      roleplayChar: options?.roleplayChar,
      namespace: options?.namespace,
      belongEntityUuid: options?.belongEntityUuid,
      mentionedEntityUuids: options?.mentionedEntityUuids,
      messageId: options?.messageId,
    });
    this.db.run(sql, bind);
    // 🔴 D5 修复(2026-09-11): 返回真实 conversations.id（原实现返回 seqPos）。
    // 调用方 persistence-stage 把返回值当作主键用于增量索引 source_id
    // （注释原文即「P1-C 修复: source_id 用真实 conversations.id（与 rebuildAllIndexes 一致）」），
    // 而 rebuildAllIndexes 用的是 `SELECT id ... String(id)` —— 口径不一致导致
    // search_index.source_id 越过 conversations.id 上限（实测 18121 条）。
    //
    // ⚠️ P1(S4 独立评审发现并实证): rowid 必须在 scheduleFlush() **之前**读取。
    // 共享模式下 scheduleFlush() 会同步委托 SQLiteAdapter.save()，累计到 _FLUSH_BATCH 时
    // 同步 flushNow() → db.export()；而 sql.js 的 export() 会关闭并重开连接，
    // last_insert_rowid() 是**连接级**状态 → 重开后恒为 0（已实测: export 前=1、后=0）。
    // 若先 flush 再取，约每 _FLUSH_BATCH 次写入就静默降级为 seqPos，D5 缺陷当场复活。
    let _rid = 0;
    try {
      _rid = Number(this.queryAll('SELECT last_insert_rowid() AS id')?.[0]?.id);
    } catch { /* 降级为 seqPos */ }

    // C4: 触发防抖落盘（共享模式委托 owner；独立模式 150ms 合并落盘），防止用户/助手消息因崩溃丢失
    this.scheduleFlush();

    if (Number.isFinite(_rid) && _rid > 0) return _rid;
    // 降级必须可见：否则 search_index.source_id 会静默回到与主键口径不一致的状态
    console.warn(
      `[ConversationDB] last_insert_rowid 不可用(id=${_rid})，降级返回 seqPos=${seqPos} — ` +
        'search_index.source_id 将与本表主键口径不一致（D5 复现）',
    );
    return seqPos;
  }

  getRecentConversations(limit = 100): ConversationRow[] {
    this.ensureReady();
    const stmt = this.db.prepare(
      `SELECT id, role, content, timestamp, topic, is_summary, belong_entity_uuid FROM conversations WHERE is_compacted = 0 AND (roleplay_char IS NULL OR roleplay_char = '') ORDER BY timestamp DESC LIMIT ?`,
    );
    stmt.bind([limit]);
    const rows: ConversationRow[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as any);
    stmt.free();
    return rows.reverse();
  }

  /** 搜索对话记录 */
  searchConversations(keyword: string, limit = 10, excludeRoleplay = true): ConversationRow[] {
    this.ensureReady();
    // 🏗️ P0-4: 非角色扮演时自动过滤角色扮演对话（避免记忆污染）
    const sql = excludeRoleplay
      ? `SELECT id, role, content, timestamp, topic FROM conversations WHERE content LIKE ? AND is_compacted = 0 AND (roleplay_char IS NULL OR roleplay_char = '') ORDER BY timestamp DESC LIMIT ?`
      : `SELECT id, role, content, timestamp, topic FROM conversations WHERE content LIKE ? AND is_compacted = 0 ORDER BY timestamp DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    stmt.bind([`%${keyword}%`, limit]);
    const rows: ConversationRow[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as any);
    stmt.free();
    return rows;
  }

  findByTimeRange(start: string, end: string, limit = 10, entityUuids?: string[]): ConversationRow[] {
    this.ensureReady();
    // 🔴 P0-A4 修复: 时间导航（"昨天/上周说了什么"）原无 UUID 过滤，跨实体拉对话。
    //   新增 entityUuids 白名单过滤（deny-by-default，无归属记录在会晤场景不放行）。
    let sql = `SELECT id, role, content, timestamp, belong_entity_uuid FROM conversations WHERE timestamp >= ? AND timestamp <= ? AND (roleplay_char IS NULL OR roleplay_char = '')`;
    const params: any[] = [start, end];
    if (entityUuids && entityUuids.length > 0) {
      const marks = entityUuids.map(() => '?').join(',');
      sql += ` AND belong_entity_uuid IN (${marks})`;
      params.push(...entityUuids);
    } else {
      // 户主场景（无活跃实体）→ 放行无归属 + 全部（户主最高权限），不额外过滤
    }
    sql += ` ORDER BY timestamp ASC LIMIT ?`;
    params.push(limit);
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: ConversationRow[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as any);
    stmt.free();
    return rows;
  }

  getConversationStats(): { total: number; userCount: number; assistantCount: number; oldest: string; newest: string } {
    this.ensureReady();
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) as userCount,
              SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) as assistantCount,
              MIN(timestamp) as oldest, MAX(timestamp) as newest FROM conversations`,
    );
    stmt.bind([]);
    const result: any = stmt.step() ? stmt.getAsObject() : { total: 0, userCount: 0, assistantCount: 0, oldest: '', newest: '' };
    stmt.free();
    return result;
  }

  writeRaw(sql: string, ...params: any[]): void {
    this.ensureReady();
    // 兼容 writeRaw(sql, a, b) 与 writeRaw(sql, [a, b])：单个数组参数展开为绑定值列表
    const bind = (params.length === 1 && Array.isArray(params[0])) ? params[0] : params;
    this.db.run(sql, bind.length > 0 ? bind : undefined);
    // C4: 关键写入触发防抖落盘（对话组回填等）
    this.scheduleFlush();
  }

  queryAll(sql: string, params?: any[]): any[] {
    this.ensureReady();
    const stmt = this.db.prepare(sql);
    if (params) stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  /** P0-3: 关闭前安全落盘（清定时器 + 强制落盘，不关闭共享 db） */
  shutdownFlush(): void {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (!this.db) return;
    if (this.sharedMode) {
      // 共享 db：落盘后不关闭数据库（owner 负责关闭）
      try {
        writeFileSync(this.dbPath, Buffer.from(this.db.export()));
      } catch (err) {
        console.error('[ConversationDB] shutdownFlush 落盘失败:', err);
      }
      return;
    }
    // 独立模式：落盘
    try {
      writeFileSync(this.dbPath, Buffer.from(this.db.export()));
    } catch (err) {
      console.error('[ConversationDB] shutdownFlush 落盘失败:', err);
    }
  }

  close(): void {
    if (!this.db) return;
    if (this.sharedMode) {
      // C4: 共享 db 由 owner(SQLiteAdapter) 负责关闭；这里同步 export 一次作为兜底，
      // 保证无论 owner 关闭顺序如何，最新的对话写入都已落盘，绝不 close 共享实例
      try {
        writeFileSync(this.dbPath, Buffer.from(this.db.export()));
      } catch (err) {
        console.error('[ConversationDB] 关闭落盘失败:', err);
      }
      this.db = null;
      return;
    }
    // 独立模式：同步落盘后关闭
    this.flushNow();
    this.db.close();
    this.db = null;
  }

  /**
   * C4: 防抖落盘调度。
   * - 共享模式：委托 owner(SQLiteAdapter) 统一 export，避免两个类各自 export 同一 96MB 库
   * - 独立模式：150ms 内的写入合并为一次 export（崩溃窗口 ~150ms）
   */
  private scheduleFlush(): void {
    if (this._flushCoordinator) { this._flushCoordinator(); return; }
    if (!this.db) return;
    this._dirty = true;
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flushNow(), this._FLUSH_INTERVAL);
    }
  }

  /** 独立模式立即落盘（共享模式由 owner 负责，此处不导出共享库） */
  private flushNow(): void {
    if (!this.db || this.sharedMode || !this._dirty) return;
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
      this._dirty = false;
    } catch (err) {
      console.error('[ConversationDB] 落盘失败:', err);
    }
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
  }

  private ensureReady(): void {
    if (!this.db) throw new Error('ConversationDB not initialized');
  }
}
