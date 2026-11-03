/**
 * M3 单元测试：Checkpoint 断点续跑
 * 需要 better-sqlite3 内存数据库
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CheckpointStore } from '../checkpoint/CheckpointStore.js';
import { SLEEP_STEPS } from '../types.js';

function createTestDb() {
  const db = new Database(':memory:');
  // 建 sleep_runs 表（最小化）
  db.exec(`
    CREATE TABLE sleep_runs (
      id TEXT PRIMARY KEY,
      cycle_no INTEGER,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      current_step TEXT,
      checkpoint TEXT,
      status TEXT DEFAULT 'running',
      stats TEXT
    );
  `);
  return db;
}

describe('CheckpointStore', () => {
  let db: Database.Database;
  let store: CheckpointStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CheckpointStore(db, 'test');
  });

  it('创建新运行记录', () => {
    const cp = store.createRun('run-001', 'main');
    expect(cp.runId).toBe('run-001');
    expect(cp.completedStepIndex).toBe(-1);
    expect(cp.status).toBe('running');
  });

  it('步骤完成后更新 checkpoint', () => {
    const cp = store.createRun('run-002', 'main');
    store.markStepStart(cp, 'scan_pending');
    expect(cp.currentStep).toBe('scan_pending');

    store.markStepComplete(cp, {
      stepName: 'scan_pending',
      status: 'success',
      durationMs: 100,
      itemsProcessed: 100,
      llmCalls: 0,
      tokensUsed: 0,
    });
    expect(cp.completedStepIndex).toBe(0);
    expect(cp.currentStep).toBeNull();
  });

  it('断点续跑：步骤5中断后重启，从步骤5继续', () => {
    const cp = store.createRun('run-003', 'main');

    // 模拟前4步已完成
    for (let i = 0; i < 4; i++) {
      store.markStepComplete(cp, {
        stepName: SLEEP_STEPS[i],
        status: 'success',
        durationMs: 50,
        itemsProcessed: 10,
        llmCalls: 0,
        tokensUsed: 0,
      });
    }

    // 步骤5执行中崩溃
    store.markStepStart(cp, 'build_replay_set');
    expect(cp.currentStep).toBe('build_replay_set');

    // 重启后查找可恢复的运行
    const resumed = store.findResumableRun();
    expect(resumed).not.toBeNull();
    expect(resumed!.currentStep).toBe('build_replay_set');

    // getNextStep 应该返回当前中断步骤（重跑，幂等）
    const nextStep = store.getNextStep(resumed!);
    expect(nextStep).toBe('build_replay_set');
  });

  it('幂等性：isStepCompleted 正确判断', () => {
    const cp = store.createRun('run-004', 'main');
    expect(store.isStepCompleted(cp, 'scan_pending')).toBe(false);

    store.markStepComplete(cp, {
      stepName: 'scan_pending',
      status: 'success',
      durationMs: 10,
      itemsProcessed: 0,
      llmCalls: 0,
      tokensUsed: 0,
    });
    expect(store.isStepCompleted(cp, 'scan_pending')).toBe(true);
    expect(store.isStepCompleted(cp, 'seal_episodes')).toBe(false);
  });
});
