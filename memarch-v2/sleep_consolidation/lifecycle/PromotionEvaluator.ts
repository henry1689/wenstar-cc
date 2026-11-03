/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / lifecycle/PromotionEvaluator
 *
 * 晋升评估器：批量计算记忆的生命周期推进决策
 * 遵循 WriteQueue 小事务 ≤200 行规则
 */

import type Database from 'better-sqlite3';
import { LifecycleStateMachine, type TransitionInput } from './LifecycleStateMachine.js';
import type { SleepQuota } from '../config/quota.js';
import type { LifecycleState } from '../types.js';

export interface PromotionDecision {
  traceId: string;
  oldState: LifecycleState;
  newState: LifecycleState;
  consolidationBefore: number;
  consolidationAfter: number;
  reason: string;
  shouldTombstone: boolean;
}

export interface PromotionResult {
  decisions: PromotionDecision[];
  promotedCount: number;
  demotedCount: number;
  tombstonedCount: number;
  durationMs: number;
}

export class PromotionEvaluator {
  private readonly sm = new LifecycleStateMachine();

  constructor(
    private readonly db: Database.Database,
    private readonly quota: SleepQuota,
  ) {}

  /**
   * 批量评估所有活跃记忆的生命周期推进
   * 每批 ≤200 条，走 WriteQueue 小事务
   */
  async evaluateAll(namespace: string): Promise<PromotionResult> {
    const start = Date.now();
    const decisions: PromotionDecision[] = [];

    // 查询所有非终态记忆
    const traces = this.db.prepare(`
      SELECT
        id, consolidation, activation_cache, sleep_cycles_survived,
        salience, n_refs, is_landmark, created_at, last_recalled_at,
        lifecycle_state
      FROM memories
      WHERE namespace = ?
        AND lifecycle_state NOT IN ('purged')
        AND suppressed = 0
      ORDER BY last_reinforced_at ASC
      LIMIT ?
    `).all(namespace, this.quota.maxFreshPerCycle) as MemoryRow[];

    let promotedCount = 0;
    let demotedCount = 0;
    let tombstonedCount = 0;

    // 分批处理（每批 200 条，小事务）
    for (let i = 0; i < traces.length; i += this.quota.mergeBatchSize) {
      const batch = traces.slice(i, i + this.quota.mergeBatchSize);
      const batchDecisions = this.evaluateBatch(batch);
      decisions.push(...batchDecisions);

      for (const d of batchDecisions) {
        if (d.shouldTombstone) tombstonedCount++;
        else if (d.newState === 'consolidated') promotedCount++;
        else if (this.isDowngrade(d.oldState, d.newState)) demotedCount++;
      }
    }

    return {
      decisions,
      promotedCount,
      demotedCount,
      tombstonedCount,
      durationMs: Date.now() - start,
    };
  }

  /** 对一批记忆做状态机转换计算 */
  private evaluateBatch(rows: MemoryRow[]): PromotionDecision[] {
    const now = Date.now();
    return rows.map((row) => {
      const daysSinceLastRecall = row.last_recalled_at
        ? Math.floor((now - new Date(row.last_recalled_at).getTime()) / 86400000)
        : 999;

      const input: TransitionInput = {
        currentState: row.lifecycle_state as LifecycleState,
        consolidation: row.consolidation ?? 0,
        activation: row.activation_cache ?? 0,
        sleepCyclesSurvived: row.sleep_cycles_survived ?? 0,
        salience: row.salience ?? 0,
        nRefs: row.n_refs ?? 1,
        isLandmark: row.is_landmark === 1,
        anchorExempt: false,
        daysSinceLastRecall,
      };

      const transition = this.sm.transition(input);
      const shouldTombstone = this.sm.shouldEnterTombstone(input);

      return {
        traceId: row.id,
        oldState: row.lifecycle_state as LifecycleState,
        newState: shouldTombstone ? 'tombstone' : transition.nextState,
        consolidationBefore: row.consolidation ?? 0,
        consolidationAfter: Math.min(1, Math.max(0, (row.consolidation ?? 0) + (transition.deltaConsolidation ?? 0))),
        reason: transition.reason,
        shouldTombstone,
      };
    });
  }

  /** 应用晋升决策到数据库（走 WriteQueue） */
  applyDecisions(decisions: PromotionDecision[]): { applied: number; skipped: number } {
    let applied = 0;
    let skipped = 0;

    const updateStmt = this.db.prepare(`
      UPDATE memories
      SET consolidation = ?, lifecycle_state = ?, lifecycle_changed_at = ?, sleep_cycles_survived = sleep_cycles_survived + 1
      WHERE id = ? AND lifecycle_state NOT IN ('purged')
    `);

    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const d of decisions) {
        if (d.oldState === d.newState && Math.abs(d.consolidationAfter - d.consolidationBefore) < 0.001) {
          skipped++;
          continue;
        }
        updateStmt.run(d.consolidationAfter, d.newState, now, d.traceId);
        applied++;
      }
    });

    tx();
    return { applied, skipped };
  }

  private isDowngrade(oldState: LifecycleState, newState: LifecycleState): boolean {
    const order: LifecycleState[] = ['consolidated', 'fresh', 'weakening', 'expiring', 'tombstone', 'purged'];
    return order.indexOf(newState) > order.indexOf(oldState) && oldState !== 'consolidated';
  }
}

interface MemoryRow {
  id: string;
  consolidation: number | null;
  activation_cache: number | null;
  sleep_cycles_survived: number | null;
  salience: number | null;
  n_refs: number | null;
  is_landmark: number;
  created_at: number;
  last_recalled_at: string | null;
  lifecycle_state: string;
}
