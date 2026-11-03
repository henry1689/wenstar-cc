/**
 * 步骤10：墓碑清理 + 索引维护
 * - 将 tombstone 状态的记录写入 tombstones 表
 * - 过 purge_after 的物理删除（受 MEMORY_FORGET_ENABLED 控制）
 * - 每日 purge 配额：达 500 条自动停止
 * - 索引维护：ANALYZE / VACUUM
 */

import type { StepContext } from '../types.js';
import { BaseStep, type StepDeps } from './StepBase.js';

export class PurgeTombstonesStep extends BaseStep {
  readonly name = 'purge_tombstones' as const;
  readonly description = '墓碑清理 + 索引维护';

  constructor(deps: StepDeps) { super(deps); }

  shouldSkipInNap(): boolean { return false; }

  protected async execute(ctx: StepContext): Promise<{ itemsProcessed: number; llmCalls: number; tokensUsed: number }> {
    const now = Date.now();
    const forgetEnabled = this.deps.flags.MEMORY_FORGET_ENABLED === 1;

    // 1. 将 lifecycle_state=tombstone 的记忆写入 tombstones 表（无论总开关）
    const tombstoneCandidates = this.deps.db.prepare(`
      SELECT id, consolidation, last_reinforced_at
      FROM memories
      WHERE lifecycle_state = 'tombstone'
        AND namespace = ?
    `).all(this.deps.namespace) as { id: string; consolidation: number; last_reinforced_at: number | null }[];

    let tombstoned = 0;
    for (const row of tombstoneCandidates) {
      // 检查是否已在 tombstones 表（幂等）
      const exists = this.deps.db.prepare(`SELECT 1 FROM tombstones WHERE id = ?`).get(row.id);
      if (exists) continue;

      const purgeAfter = now + 7 * 24 * 3600 * 1000; // 7 天后可物理删除
      this.deps.db.prepare(`
        INSERT OR IGNORE INTO tombstones (id, target_type, deleted_at, reason, consolidation, last_recall, purge_after)
        VALUES (?, 'memory', ?, 'decay', ?, ?, ?)
      `).run(row.id, now, row.consolidation ?? 0, row.last_reinforced_at ?? now, purgeAfter);
      tombstoned++;
    }

    // 2. 物理 purge：过 purge_after 的记录（受总开关 + 配额控制）
    let purged = 0;
    if (forgetEnabled) {
      // 检查今日已 purge 数量
      const todayStart = new Date().toISOString().slice(0, 10);
      const todayPurgeCount = (this.deps.db.prepare(`
        SELECT COUNT(*) as cnt FROM tombstones
        WHERE reason = 'decay' AND date(deleted_at / 1000, 'unixepoch') = ?
      `).get(todayStart) as { cnt: number }).cnt;

      const remainingQuota = this.deps.quota.dailyPurgeLimit - todayPurgeCount;
      if (remainingQuota > 0) {
        const expired = this.deps.db.prepare(`
          SELECT id FROM tombstones
          WHERE purge_after < ?
          LIMIT ?
        `).all(now, Math.min(remainingQuota, this.deps.quota.dailyPurgeLimit)) as { id: string }[];

        const tx = this.deps.db.transaction(() => {
          for (const row of expired) {
            // 物理删除 memories 主表
            this.deps.db.prepare(`DELETE FROM memories WHERE id = ?`).run(row.id);
            // 删除 tombstones 记录
            this.deps.db.prepare(`DELETE FROM tombstones WHERE id = ?`).run(row.id);
            purged++;
          }
        });
        tx();
      }
    }

    // 3. 索引维护（轻量：ANALYZE，不做全量 VACUUM）
    this.deps.db.exec('ANALYZE');

    ctx.purgedCount = purged;
    return {
      itemsProcessed: tombstoned + purged,
      llmCalls: 0,
      tokensUsed: 0,
    };
  }
}
