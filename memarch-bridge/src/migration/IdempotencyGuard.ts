/**
 * IdempotencyGuard.ts — 迁移幂等控制
 *
 * 【机制】
 *   1. 迁移前在新库记录 migration_checkpoint 表，记录 (old_table, old_pk, migrated_at)
 *   2. 每次迁移先查 checkpoint，已存在则跳过（幂等）
 *   3. 整批在事务里跑，失败回滚到 checkpoint
 */

import type Database from 'better-sqlite3';

export interface MigrationCheckpoint {
  oldTable: string;
  oldPk: string;
  newPk: string;
  namespace: string;
  migratedAt: number;
  status: 'success' | 'failed';
  error?: string;
}

export class IdempotencyGuard {
  constructor(private readonly db: Database.Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migration_checkpoint (
        old_table TEXT NOT NULL,
        old_pk TEXT NOT NULL,
        new_pk TEXT NOT NULL,
        namespace TEXT NOT NULL,
        migrated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        PRIMARY KEY (old_table, old_pk)
      )
    `);
  }

  /** 查某条旧记录是否已迁移成功 */
  isMigrated(oldTable: string, oldPk: string): boolean {
    const row = this.db
      .prepare(`SELECT status FROM migration_checkpoint WHERE old_table = ? AND old_pk = ?`)
      .get(oldTable, oldPk) as { status: string } | undefined;
    return row?.status === 'success';
  }

  /** 记录迁移成功 */
  markSuccess(cp: Omit<MigrationCheckpoint, 'migratedAt' | 'status'>): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO migration_checkpoint (old_table, old_pk, new_pk, namespace, migrated_at, status)
      VALUES (?, ?, ?, ?, ?, 'success')
    `).run(cp.oldTable, cp.oldPk, cp.newPk, cp.namespace, Date.now());
  }

  /** 记录迁移失败 */
  markFailure(oldTable: string, oldPk: string, namespace: string, error: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO migration_checkpoint (old_table, old_pk, new_pk, namespace, migrated_at, status, error)
      VALUES (?, ?, ?, ?, ?, 'failed', ?)
    `).run(oldTable, oldPk, '', namespace, Date.now(), error);
  }

  /** 统计 */
  stats(): { total: number; success: number; failed: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
      FROM migration_checkpoint
    `).get() as { total: number; success: number; failed: number };
    return { total: row.total, success: row.success, failed: row.failed };
  }

  /** 清空 checkpoint（重跑前） */
  reset(): void {
    this.db.exec(`DELETE FROM migration_checkpoint`);
  }
}
