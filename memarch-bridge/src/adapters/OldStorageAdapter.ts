/**
 * OldStorageAdapter.ts — 旧 memory-vault/MemoryVault → 新 M1 Storage
 *
 * 【适配关系】
 *   旧：src/app/memory-vault/MemoryVault.ts
 *   新：memarch-v2/storage/WriteQueue + DDL（SQLite + FTS5 + 向量索引）
 */

import type Database from 'better-sqlite3';
import type { MemoryStoragePort } from '../core/MemoryPort.js';
import { NamespaceManager } from '../namespace/NamespaceManager.js';

export class OldStorageAdapter implements MemoryStoragePort {
  constructor(
    private readonly db: Database.Database,
    private readonly nsManager: NamespaceManager
  ) {}

  async rawRead(table: string, namespace: string, where: Record<string, unknown>): Promise<unknown[]> {
    this.nsManager.assertValid(namespace);
    const whereClauses = Object.keys(where).map((k) => `${k} = ?`).join(' AND ');
    const sql = `SELECT * FROM ${table} WHERE namespace = ? AND ${whereClauses} LIMIT 100`;
    return this.nsManager.safeQuery(sql, namespace, Object.values(where));
  }

  async rawWrite(table: string, namespace: string, rows: Record<string, unknown>[]): Promise<void> {
    this.nsManager.assertValid(namespace);
    const stmt = this.db.transaction((rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        row.namespace = namespace; // 强制注入 namespace，防漏
        const cols = Object.keys(row).join(', ');
        const placeholders = Object.keys(row).map(() => '?').join(', ');
        this.db.prepare(
          `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`
        ).run(...Object.values(row));
      }
    });
    stmt(rows);
  }

  async count(table: string, namespace: string): Promise<number> {
    this.nsManager.assertValid(namespace);
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM ${table} WHERE namespace = ?`)
      .get(namespace) as { c: number };
    return row.c;
  }

  async listNamespaces(): Promise<string[]> {
    return this.nsManager.list().map((e) => e.namespace);
  }
}
