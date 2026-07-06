/**
 * SQLiteStorage — IStorageProvider 的 sql.js 实现
 *
 * 包装现有 SQLiteAdapter，提供统一持久化接口。
 * S3 升级 SQLite Wasm + OPFS 时，只需新增实现类。
 */
import type { IStorageProvider } from './IStorageProvider.js';

interface SQLiteAdapterLike {
  queryAll<T>(sql: string, params?: any[]): T[];
  writeRaw(sql: string, ...params: any[]): void;
  exec(sql: string): void;
  runTransaction<T>(fn: () => T): T;
}

export class SQLiteStorage implements IStorageProvider {
  private adapter: SQLiteAdapterLike;

  constructor(adapter: SQLiteAdapterLike) {
    this.adapter = adapter;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const rows = this.adapter.queryAll<{ key: string; value: string }>(
        'SELECT key, value FROM engine_store WHERE key = ?', [key]
      );
      if (rows.length === 0) return null;
      return JSON.parse(rows[0].value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      this.adapter.writeRaw(
        'INSERT OR REPLACE INTO engine_store (key, value, updated_at) VALUES (?, ?, ?)',
        key,
        JSON.stringify(value),
        new Date().toISOString(),
      );
    } catch (err) {
      // 表不存在时自动创建
      if ((err as Error)?.message?.includes('no such table')) {
        if (typeof this.adapter.exec === 'function') {
          this.adapter.exec(
            'CREATE TABLE IF NOT EXISTS engine_store (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)'
          );
        } else {
          this.adapter.writeRaw(
            'CREATE TABLE IF NOT EXISTS engine_store (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)'
          );
        }
        this.adapter.writeRaw(
          'INSERT OR REPLACE INTO engine_store (key, value, updated_at) VALUES (?, ?, ?)',
          key,
          JSON.stringify(value),
          new Date().toISOString(),
        );
      } else {
        throw err;
      }
    }
  }

  async query<T>(sql: string, params?: any[]): Promise<T[]> {
    return this.adapter.queryAll<T>(sql, params);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.adapter.runTransaction(fn);
  }
}
