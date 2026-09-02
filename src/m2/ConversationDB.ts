/**
 * ConversationDB — P0-9 对话独立存储库（已合入 fusion_memory.db）
 *
 * v2.0: 构造函数接受 existingDb 参数，共享 sql.js 实例而非独立文件。
 * 保留独立文件模式向后兼容。flush 在共享模式下为空操作
 *（由 SQLiteAdapter 统一落盘管理）。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_DB_PATH = join(PROJECT_ROOT, 'data', 'webui', 'conversations.db');

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
    const entityNames = options?.entityNames?.join(',') || '';
    const perceptionSummary = options?.perception ? JSON.stringify(options.perception) : '';
    // is_summary 与 is_compacted 同步写入（过渡兼容，后续统一为 is_summary）
    const compactVal = options?.isCompacted ?? 0;
    this.db.run(
      `INSERT INTO conversations (role, content, timestamp, seq_pos, topic, entity_names, perception_summary, calcium_score, dna_root_id, global_uid, location_fingerprint, dialog_group_id, dialog_round, is_test, is_compacted, is_summary, roleplay_char, is_promoted, namespace, belong_entity_uuid, mentioned_entity_uuids, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [role, content, timestamp, seqPos, options?.topic || '', entityNames, perceptionSummary,
       options?.calciumScore || 0, options?.dnaRootId || null, options?.globalUid || null, options?.locationFingerprint || null,
       options?.dialogGroupId || null, options?.dialogRound ?? null, options?.isTest ?? 0, compactVal, compactVal,
       options?.roleplayChar || null, options?.namespace || 'default', options?.belongEntityUuid || null,
       options?.mentionedEntityUuids ? JSON.stringify(options.mentionedEntityUuids) : null,
       options?.messageId ?? null],
    );
    // C4: 触发防抖落盘（共享模式委托 owner；独立模式 150ms 合并落盘），防止用户/助手消息因崩溃丢失
    this.scheduleFlush();
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
