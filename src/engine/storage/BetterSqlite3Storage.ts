/**
 * BetterSqlite3Storage — better-sqlite3 原生 SQLite 存储实现
 *
 * 替换 sql.js 的高性能方案。
 * - WAL 模式：读写并发不冲突
 * - synchronous = NORMAL：写入性能提升 30%+
 * - busy_timeout = 5000：避免并发写入冲突
 * - 原生 Node.js 绑定，比 WASM 版快 3-5 倍
 *
 * 迁移步骤：
 * 1. 安装 better-sqlite3（已完成）
 * 2. 将现有 fusion_memory.db 数据导入
 * 3. 切换 IStorageProvider 实现类
 */
import Database from 'better-sqlite3';
import type { IStorageProvider } from './IStorageProvider.js';

export class BetterSqlite3Storage implements IStorageProvider {
  private db: any = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** 初始化数据库 + WAL 模式 */
  initialize(): void {
    this.db = new Database(this.dbPath, {
      // WAL 模式 - 读写并发
      nativeBinding: undefined,
    });

    // 开启 WAL 模式
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('cache_size = -8000'); // 8MB 缓存

    // 确保引擎存储表存在
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engine_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      )
    `);

    console.log(`[BetterSqlite3] 初始化完成 (WAL模式): ${this.dbPath}`);
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.db) return null;
    try {
      const row = this.db.prepare('SELECT value FROM engine_store WHERE key = ?').get(key) as any;
      return row ? JSON.parse(row.value) as T : null;
    } catch { return null; }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!this.db) return;
    try {
      this.db.prepare(
        'INSERT OR REPLACE INTO engine_store (key, value, updated_at) VALUES (?, ?, ?)',
      ).run(key, JSON.stringify(value), new Date().toISOString());
    } catch (err) { console.error('[BetterSqlite3] set 失败:', err); }
  }

  async query<T>(sql: string, params?: any[]): Promise<T[]> {
    if (!this.db) return [];
    try {
      return (params ? this.db.prepare(sql).all(...params) : this.db.prepare(sql).all()) as T[];
    } catch (err) { console.error('[BetterSqlite3] query 失败:', err); return []; }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.db) return fn();
    const transaction = this.db.transaction(async () => fn());
    return transaction();
  }

  /** 获取底层 Database 实例（供需要直接 SQL 访问的模块使用） */
  getNativeDb(): any | null {
    return this.db;
  }

  /** 关闭数据库 */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** 执行原始 SQL（迁移/管理用） */
  exec(sql: string): void {
    this.db?.exec(sql);
  }

  /** 导入现有 sql.js 数据库文件 */
  importFromSqlJs(sqlJsDb: any): number {
    if (!this.db) return 0;
    let count = 0;
    const tables = sqlJsDb.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    for (const t of tables) {
      const name = t.values[0][0] as string;
      const createSql = sqlJsDb.exec(
        `SELECT sql FROM sqlite_master WHERE name='${name}'`
      );
      if (createSql.length > 0) {
        this.db.exec(createSql[0].values[0][0] as string);
        const rows = sqlJsDb.exec(`SELECT * FROM [${name}]`);
        if (rows.length > 0 && rows[0].columns.length > 0) {
          const cols = rows[0].columns.join(',');
          const placeholders = rows[0].columns.map(() => '?').join(',');
          const insert = this.db.prepare(`INSERT OR IGNORE INTO [${name}] (${cols}) VALUES (${placeholders})`);
          for (const row of rows[0].values) {
            insert.run(...row);
            count++;
          }
        }
      }
    }
    return count;
  }

  /** 执行备份 */
  backup(backupPath: string): void {
    if (!this.db) return;
    this.db.exec(`VACUUM INTO '${backupPath}'`);
  }
}
