/**
 * 步骤5：优先回放集 + STC 行为标记
 * 选出高显著性记忆进入回放集，标记 STC（Systemic Consolidation）
 * 断点续跑核心：此步完成后落 checkpoint
 */

import type { StepContext } from '../types.js';
import { BaseStep, type StepDeps } from './StepBase.js';

export class BuildReplaySetStep extends BaseStep {
  readonly name = 'build_replay_set' as const;
  readonly description = '构建优先回放集 + STC 行为标记';

  constructor(deps: StepDeps) { super(deps); }

  shouldSkipInNap(): boolean { return true; }

  protected async execute(ctx: StepContext): Promise<{ itemsProcessed: number; llmCalls: number; tokensUsed: number }> {
    // 按显著性排序选出 top N 进入回放集
    // STC 标记：高显著性 + 多次引用 → 标记为系统性巩固
    const replaySet = this.deps.db.prepare(`
      SELECT id, salience, n_refs, consolidation, lifecycle_state
      FROM memories
      WHERE namespace = ?
        AND suppressed = 0
        AND salience >= 0.6
      ORDER BY salience DESC, n_refs DESC
      LIMIT 2000
    `).all(this.deps.namespace) as {
      id: string; salience: number; n_refs: number; consolidation: number; lifecycle_state: string;
    }[];

    let stcMarked = 0;
    const traceIds: string[] = [];
    const now = Date.now();

    const updateStmt = this.deps.db.prepare(`
      UPDATE memories SET activation_cache = ? WHERE id = ?
    `);

    const tx = this.deps.db.transaction(() => {
      for (const mem of replaySet) {
        traceIds.push(mem.id);

        // STC 判定：高显著性 + 多次引用 → 系统性巩固标记
        const isSTC = mem.salience >= 0.75 && mem.n_refs >= 3;
        if (isSTC) {
          // 强化巩固度（模拟回放效应）
          const boosted = Math.min(1, mem.consolidation + 0.1);
          updateStmt.run(boosted, mem.id);
          stcMarked++;

          // 记录强化事件
          this.deps.db.prepare(`
            INSERT OR IGNORE INTO reinforcement_events (trace_id, ts_utc, path, signal, delta_c)
            VALUES (?, ?, 'sleep_replay', 'stc_boost', ?)
          `).run(mem.id, now, 0.1);
        }
      }
    });

    tx();

    ctx.replaySet = traceIds;
    ctx.stcMarkedCount = stcMarked;

    return {
      itemsProcessed: traceIds.length,
      llmCalls: 0,
      tokensUsed: 0,
    };
  }
}
