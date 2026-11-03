/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / checkpoint/CheckpointStore
 *
 * 断点续跑机制：每步完成后落 checkpoint 到 sleep_runs 表
 * 重启时从最近完成步骤的下一步继续
 *
 * 验收标准：
 *   - 步骤5中断后重启，从步骤5继续（每步完成后落 checkpoint）
 *   - 幂等性：同一步骤执行两次，数据不产生重复
 */

import type Database from 'better-sqlite3';
import type { SleepStepName, StepContext, StepResult, HarnessMetrics, SleepMode } from '../types.js';
import { SLEEP_STEPS } from '../types.js';

export interface CheckpointData {
  runId: string;
  cycleNo: number;
  startedAt: number;
  /** 已完成到哪一步的索引（-1 = 尚未开始） */
  completedStepIndex: number;
  /** 当前正在执行的步骤名 */
  currentStep: SleepStepName | null;
  /** 步骤间传递的上下文快照 */
  context: Partial<StepContext>;
  /** 已完成步骤的结果列表 */
  stepResults: StepResult[];
  status: 'running' | 'paused' | 'completed' | 'failed';
}

export class CheckpointStore {
  private readonly db: Database.Database;
  private readonly namespace: string;

  constructor(db: Database.Database, namespace: string = 'default') {
    this.db = db;
    this.namespace = namespace;
  }

  /** 创建新睡眠运行记录 */
  createRun(runId: string, mode: SleepMode): CheckpointData {
    const now = Date.now();
    const cycleNo = this.nextCycleNo();
    const checkpoint: CheckpointData = {
      runId,
      cycleNo,
      startedAt: now,
      completedStepIndex: -1,
      currentStep: null,
      context: { runId, mode, namespace: this.namespace },
      stepResults: [],
      status: 'running',
    };
    this.persist(checkpoint);
    return checkpoint;
  }

  /** 查找可恢复的运行（status=running 且未完成） */
  findResumableRun(): CheckpointData | null {
    const row = this.db.prepare(`
      SELECT id, checkpoint, status FROM sleep_runs
      WHERE status = 'running' AND finished_at IS NULL
      ORDER BY started_at DESC LIMIT 1
    `).get() as { id: string; checkpoint: string; status: string } | undefined;

    if (!row) return null;
    try {
      const data = JSON.parse(row.checkpoint) as CheckpointData;
      return data.runId === row.id ? data : null;
    } catch {
      return null;
    }
  }

  /** 标记步骤开始 */
  markStepStart(checkpoint: CheckpointData, step: SleepStepName): void {
    checkpoint.currentStep = step;
    this.persist(checkpoint);
  }

  /** 标记步骤完成（落 checkpoint） */
  markStepComplete(checkpoint: CheckpointData, result: StepResult): void {
    const idx = SLEEP_STEPS.indexOf(result.stepName);
    checkpoint.completedStepIndex = Math.max(checkpoint.completedStepIndex, idx);
    checkpoint.stepResults.push(result);
    checkpoint.currentStep = null;
    this.persist(checkpoint);
  }

  /** 更新步骤间上下文 */
  updateContext(checkpoint: CheckpointData, partial: Partial<StepContext>): void {
    Object.assign(checkpoint.context, partial);
    this.persist(checkpoint);
  }

  /** 标记运行完成 */
  markCompleted(checkpoint: CheckpointData): void {
    checkpoint.status = 'completed';
    checkpoint.currentStep = null;
    const finishedAt = Date.now();
    const stats = JSON.stringify(this.buildStats(checkpoint));
    this.db.prepare(`
      UPDATE sleep_runs
      SET finished_at = ?, current_step = 'completed', status = 'completed', checkpoint = ?, stats = ?
      WHERE id = ?
    `).run(finishedAt, JSON.stringify(checkpoint), stats, checkpoint.runId);
  }

  /** 标记运行失败 */
  markFailed(checkpoint: CheckpointData, error: string): void {
    checkpoint.status = 'failed';
    this.db.prepare(`
      UPDATE sleep_runs
      SET status = 'failed', checkpoint = ?
      WHERE id = ?
    `).run(JSON.stringify(checkpoint), checkpoint.runId);
  }

  /** 标记暂停 */
  markPaused(checkpoint: CheckpointData): void {
    checkpoint.status = 'paused';
    this.persist(checkpoint);
  }

  /** 获取下一个待执行步骤（断点续跑核心） */
  getNextStep(checkpoint: CheckpointData): SleepStepName | null {
    // 如果上一步正在执行中（崩溃恢复），从当前步骤重跑（幂等保证）
    if (checkpoint.currentStep) {
      return checkpoint.currentStep;
    }
    const nextIdx = checkpoint.completedStepIndex + 1;
    if (nextIdx >= SLEEP_STEPS.length) return null;
    return SLEEP_STEPS[nextIdx];
  }

  /** 判断某步骤是否已完成（幂等性检查） */
  isStepCompleted(checkpoint: CheckpointData, step: SleepStepName): boolean {
    const idx = SLEEP_STEPS.indexOf(step);
    return checkpoint.completedStepIndex >= idx;
  }

  /** 持久化到 sleep_runs 表 */
  private persist(checkpoint: CheckpointData): void {
    const checkpointJson = JSON.stringify(checkpoint);
    this.db.prepare(`
      INSERT INTO sleep_runs (id, cycle_no, started_at, current_step, checkpoint, status, stats)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        current_step = excluded.current_step,
        checkpoint = excluded.checkpoint,
        status = excluded.status
    `).run(
      checkpoint.runId,
      checkpoint.cycleNo,
      checkpoint.startedAt,
      checkpoint.currentStep,
      checkpointJson,
      checkpoint.status,
    );
  }

  private nextCycleNo(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(cycle_no), 0) + 1 AS next FROM sleep_runs`).get() as { next: number };
    return row.next;
  }

  private buildStats(checkpoint: CheckpointData): Partial<HarnessMetrics> {
    return {
      stepResults: checkpoint.stepResults,
      currentStep: checkpoint.currentStep,
    };
  }
}
