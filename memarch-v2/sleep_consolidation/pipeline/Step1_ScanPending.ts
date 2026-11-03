/**
 * 步骤1：扫描待处理条目
 * 收集本周期需要处理的 fresh / raw_only 状态记忆
 */

import type { StepContext } from '../types.js';
import { BaseStep, type StepDeps } from './StepBase.js';

export class ScanPendingStep extends BaseStep {
  readonly name = 'scan_pending' as const;
  readonly description = '扫描待处理的 fresh / raw_only 记忆条目';

  constructor(deps: StepDeps) { super(deps); }

  shouldSkipInNap(): boolean { return false; }

  protected async execute(ctx: StepContext): Promise<{ itemsProcessed: number; llmCalls: number; tokensUsed: number }> {
    // 查询 fresh 状态的 memories 条目
    const rows = this.deps.db.prepare(`
      SELECT id FROM memories
      WHERE namespace = ?
        AND lifecycle_state IN ('fresh', 'raw_only')
        AND suppressed = 0
      ORDER BY created_at ASC
      LIMIT ?
    `).all(this.deps.namespace, this.deps.quota.maxFreshPerCycle) as { id: string }[];

    ctx.pendingTraceIds = rows.map(r => r.id);

    return {
      itemsProcessed: rows.length,
      llmCalls: 0,
      tokensUsed: 0,
    };
  }
}
