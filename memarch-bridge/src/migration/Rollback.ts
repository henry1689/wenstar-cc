/**
 * Rollback.ts — 迁移回滚
 *
 * 【回滚策略】
 *   1. 软回滚：按 migration_checkpoint 表，删除本次迁移写入新库的所有行
 *   2. 硬回滚：恢复迁移前备份的新库 .bak 文件
 *   3. 业务回滚：FeatureFlag.rollback() 一键切回旧系统（最快）
 */

import type Database from 'better-sqlite3';
import { IdempotencyGuard } from './IdempotencyGuard.js';

export class Rollback {
  private guard: IdempotencyGuard;

  constructor(private readonly newDb: Database.Database) {
    this.guard = new IdempotencyGuard(newDb);
  }

  /**
   * 软回滚：删除本次迁移写入新库的所有行
   * 基于 migration_checkpoint，按 old_table 分组删
   */
  softRollback(): { deleted: number } {
    const cp = this.guard.stats();
    if (cp.success === 0) return { deleted: 0 };

    const tables = this.newDb
      .prepare(`SELECT DISTINCT old_table FROM migration_checkpoint WHERE status = 'success'`)
      .all() as Array<{ old_table: string }>;

    let deleted = 0;
    const tx = this.newDb.transaction(() => {
      for (const t of tables) {
        const newTable = t.old_table; // 同名表
        const rows = this.newDb.prepare(
          `SELECT new_pk FROM migration_checkpoint WHERE old_table = ? AND status = 'success'`
        ).all(t.old_table) as Array<{ new_pk: string }>;

        for (const r of rows) {
          // conversations 主键是 message_id，memories 主键是 id
          const pkCol = t.old_table === 'conversations' ? 'message_id' : 'id';
          this.newDb.prepare(`DELETE FROM ${newTable} WHERE ${pkCol} = ?`).run(r.new_pk);
          deleted++;
        }
      }
      // 清空 checkpoint
      this.guard.reset();
    });
    tx();
    return { deleted };
  }

  /**
   * 业务层一键回滚（最快，推荐）
   * 不删数据，只切流量回旧系统
   */
  businessRollback(): void {
    // 这里只做提示，实际调用 FeatureFlag.rollback()
    // 见 scripts/rollback.ps1
  }
}
