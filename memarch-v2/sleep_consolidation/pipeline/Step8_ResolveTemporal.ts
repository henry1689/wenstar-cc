/**
 * 步骤8：双时态冲突消解
 * 处理 semantic_facts 中的时间冲突：
 *   - 同一 subject+predicate 的多条记录，新的标记旧的 valid_to
 *   - 置信度低的被高置信度覆盖
 */

import type { StepContext } from '../types.js';
import { BaseStep, type StepDeps } from './StepBase.js';

export class ResolveTemporalStep extends BaseStep {
  readonly name = 'resolve_temporal' as const;
  readonly description = '双时态语义事实冲突消解';

  constructor(deps: StepDeps) { super(deps); }

  shouldSkipInNap(): boolean { return true; }

  protected async execute(ctx: StepContext): Promise<{ itemsProcessed: number; llmCalls: number; tokensUsed: number }> {
    // 找出同一 subject+predicate 下有多条仍有效的记录
    const conflicts = this.deps.db.prepare(`
      SELECT subject_uuid, predicate, COUNT(*) as cnt
      FROM semantic_facts
      WHERE valid_to IS NULL
      GROUP BY subject_uuid, predicate
      HAVING cnt > 1
      LIMIT ?
    `).all(this.deps.quota.conflictBatchSize) as { subject_uuid: string; predicate: string; cnt: number }[];

    let resolved = 0;
    const now = Date.now();

    for (const conflict of conflicts) {
      // 取最新一条为有效，其余标记 valid_to
      const rows = this.deps.db.prepare(`
        SELECT id, confidence, recorded_at
        FROM semantic_facts
        WHERE subject_uuid = ? AND predicate = ? AND valid_to IS NULL
        ORDER BY confidence DESC, recorded_at DESC
      `).all(conflict.subject_uuid, conflict.predicate) as { id: string; confidence: number; recorded_at: number }[];

      if (rows.length <= 1) continue;

      const winner = rows[0];
      const losers = rows.slice(1);

      const tx = this.deps.db.transaction(() => {
        for (const loser of losers) {
          this.deps.db.prepare(`
            UPDATE semantic_facts
            SET valid_to = ?, invalidated_at = ?, superseded_by = ?
            WHERE id = ?
          `).run(now, now, winner.id, loser.id);
          resolved++;
        }
      });

      tx();
    }

    ctx.resolvedConflictCount = resolved;
    return {
      itemsProcessed: resolved,
      llmCalls: 0,
      tokensUsed: 0,
    };
  }
}
