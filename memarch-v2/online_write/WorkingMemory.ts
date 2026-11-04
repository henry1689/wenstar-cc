/**
 * MemArch-v2.0.0 / M2-OnlineWrite / WorkingMemory
 *
 * 工作记忆缓冲（重写版）
 * 修复旧版三大问题：
 *   1. 强制毕业 → 改为三岔门控决定是否写 L3（门控在 GateDecider）
 *   2. 并发重入 → flushing 标志互斥
 *   3. 崩溃丢失 → wm_buffer 持久化表，启动时 recover()
 *
 * 职责边界：
 *   - 只负责 wm_buffer 表的持久化与状态管理
 *   - 门控决策、痕迹写入、conversation 更新由 MemoryWriter 编排
 *   - 崩溃恢复时重新处理 pending 条目（回调注入）
 *
 * 设计依据：主设计文档 §4.3
 */

import type Database from 'better-sqlite3';
import type { WriteQueue } from '../storage/write_queue/WriteQueue.js';
import { M2_CONFIG } from './config.js';
import type { WorkingEntry, Gate } from './types.js';

/** 崩溃恢复回调：由 MemoryWriter 注入，负责重新处理单条 entry */
export type RecoverHandler = (entry: WorkingEntry, bufferId: number) => Promise<void>;

export class WorkingMemory {
  private flushing = false;           // 互斥标志，防止 sweep 重入
  private recoverHandler: RecoverHandler | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly writer: WriteQueue,
  ) {}

  /**
   * 注入崩溃恢复处理器（由 MemoryWriter 调用）
   */
  setRecoverHandler(handler: RecoverHandler): void {
    this.recoverHandler = handler;
  }

  /**
   * 进程启动时恢复未处理条目
   * 从 wm_buffer 表读取所有 status='pending' 的条目，逐条回调处理
   */
  async recover(): Promise<{ recovered: number; failed: number }> {
    if (!this.recoverHandler) {
      console.warn('[WorkingMemory] recoverHandler not set, skip recovery');
      return { recovered: 0, failed: 0 };
    }

    const rows = this.db.prepare(
      `SELECT id, payload FROM wm_buffer WHERE status = 'pending' ORDER BY id ASC`
    ).all() as Array<{ id: number; payload: string }>;

    let recovered = 0;
    let failed = 0;
    const batchSize = M2_CONFIG.working_memory.recover_batch_size;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      for (const row of batch) {
        try {
          const entry = JSON.parse(row.payload) as WorkingEntry;
          await this.recoverHandler(entry, row.id);
          recovered++;
        } catch (err) {
          console.error(`[WorkingMemory] recover failed for buffer id=${row.id}:`, err);
          // 标记为 failed，避免无限重试
          this.db.prepare(`UPDATE wm_buffer SET status = 'failed' WHERE id = ?`).run(row.id);
          failed++;
        }
      }
    }

    return { recovered, failed };
  }

  /**
   * 推入一条新编码条目（只持久化，不处理）
   * 返回 bufferId，供后续状态更新使用
   */
  async push(entry: WorkingEntry): Promise<number> {
    const bufferId = await this.writer.pushWorkingBuffer(JSON.stringify(entry));
    return bufferId;
  }

  /**
   * 标记条目处理完成（由 MemoryWriter 在门控判定后调用）
   * 通过 WriteQueue 入队执行，遵守统一写入口红线
   */
  async markDone(bufferId: number, gate: Gate): Promise<void> {
    await this.writer.enqueue((db) => {
      db.prepare(
        `UPDATE wm_buffer SET status = 'done', gate = ? WHERE id = ?`
      ).run(gate, bufferId);
    }, 'high', `wm_markDone:${bufferId}`);
  }

  /**
   * 标记条目处理失败（崩溃恢复出错时调用）
   */
  async markFailed(bufferId: number): Promise<void> {
    await this.writer.enqueue((db) => {
      db.prepare(
        `UPDATE wm_buffer SET status = 'failed' WHERE id = ?`
      ).run(bufferId);
    }, 'high', `wm_markFailed:${bufferId}`);
  }

  /**
   * 定时清理已完成条目（互斥，防止重入）
   * 清理超过保留期的 done 状态条目
   */
  async sweep(): Promise<{ deleted: number }> {
    if (this.flushing) return { deleted: 0 };  // 互斥：正在清理中直接返回
    this.flushing = true;

    try {
      const cutoff = Date.now() - M2_CONFIG.working_memory.sweep_retention_ms;
      const info = this.db.prepare(
        `DELETE FROM wm_buffer WHERE status = 'done' AND ts_utc < ?`
      ).run(cutoff);
      return { deleted: info.changes };
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 获取当前 pending 条目数（Harness 监控指标）
   */
  pendingCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM wm_buffer WHERE status = 'pending'`
    ).get() as { cnt: number };
    return row.cnt;
  }
}
