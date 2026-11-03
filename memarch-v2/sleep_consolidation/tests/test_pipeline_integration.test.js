/**
 * M3 集成测试：完整睡眠流水线
 * 使用内存 SQLite，验证十步流水线端到端运行
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SleepOrchestrator } from '../pipeline/SleepOrchestrator.js';
import { loadSleepConfig } from '../config/index.js';

function createTestDb() {
  const db = new Database(':memory:');

  // 创建最小化表结构（测试用）
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      namespace TEXT NOT NULL DEFAULT 'default',
      role TEXT,
      content TEXT NOT NULL,
      ts_utc INTEGER,
      episode_id TEXT,
      lifecycle_state TEXT DEFAULT 'fresh'
    );

    CREATE TABLE episodes (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL DEFAULT 'default',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT DEFAULT 'open',
      gist TEXT,
      gist_version INTEGER DEFAULT 0,
      arousal_peak REAL,
      salience REAL,
      consolidation REAL DEFAULT 0,
      lifecycle_state TEXT DEFAULT 'fresh',
      raw_available INTEGER DEFAULT 1
    );

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL DEFAULT 'default',
      raw_input TEXT,
      summary TEXT,
      consolidation REAL DEFAULT 0,
      n_refs INTEGER DEFAULT 1,
      first_ref_at INTEGER,
      last_reinforced_at INTEGER,
      salience REAL,
      importance REAL,
      arousal REAL,
      novelty REAL,
      self_relevance REAL,
      activation_cache REAL,
      lifecycle_state TEXT DEFAULT 'fresh',
      lifecycle_changed_at INTEGER,
      episode_id TEXT,
      version INTEGER DEFAULT 1,
      supersedes_id TEXT,
      suppressed INTEGER DEFAULT 0,
      is_landmark INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE semantic_facts (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL DEFAULT 'kb',
      subject_uuid TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_text TEXT,
      valid_from INTEGER,
      valid_to INTEGER,
      recorded_at INTEGER NOT NULL,
      invalidated_at INTEGER,
      superseded_by TEXT,
      confidence REAL DEFAULT 0.7,
      source_ids TEXT NOT NULL
    );

    CREATE TABLE tombstones (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      consolidation REAL,
      last_recall INTEGER,
      purge_after INTEGER NOT NULL
    );

    CREATE TABLE reinforcement_events (
      trace_id TEXT NOT NULL,
      ts_utc INTEGER NOT NULL,
      path TEXT,
      signal TEXT,
      delta_c REAL,
      PRIMARY KEY (trace_id, ts_utc, path)
    );

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

function seedTestData(db: Database.Database) {
  const now = Date.now();

  // 插入 50 条 fresh memories
  const insertMem = db.prepare(`
    INSERT INTO memories (id, namespace, raw_input, consolidation, salience, lifecycle_state, created_at, last_reinforced_at)
    VALUES (?, 'test', ?, ?, ?, 'fresh', ?, ?)
  `);

  for (let i = 0; i < 50; i++) {
    insertMem.run(
      `trace_${i}`,
      `测试记忆内容 ${i}：关于某个话题的描述`,
      0.1 + Math.random() * 0.3,
      0.3 + Math.random() * 0.5,
      now - i * 60000,
      now - i * 60000,
    );
  }

  // 插入 5 个 open episodes
  const insertEp = db.prepare(`
    INSERT INTO episodes (id, namespace, started_at, status)
    VALUES (?, 'test', ?, 'open')
  `);
  for (let i = 0; i < 5; i++) {
    insertEp.run(`ep_${i}`, now - 3600000 * (i + 3)); // 都超过2小时前
  }
}

describe('Sleep Pipeline Integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  it('完整主睡眠流水线端到端运行', async () => {
    const config = loadSleepConfig({
      MEMARCH_NAMESPACE: 'test',
      MEMORY_FORGET_ENABLED: '1',
      LLM_SALIENCE_ENABLED: '0', // 关闭 LLM，纯规则测试
      LLM_GIST_ENABLED: '0',
    });

    const orchestrator = new SleepOrchestrator(db, config);
    const metrics = await orchestrator.execute('main', false);

    expect(metrics.status).toBe('completed');
    expect(metrics.stepResults.length).toBeGreaterThan(0);
    expect(metrics.runId).toBeTruthy();
  });

  it('小睡模式只跑轻量步骤', async () => {
    const config = loadSleepConfig({
      MEMARCH_NAMESPACE: 'test',
      MEMORY_FORGET_ENABLED: '0',
    });

    const orchestrator = new SleepOrchestrator(db, config);
    const metrics = await orchestrator.execute('nap', false);

    expect(metrics.mode).toBe('nap');
    // 小睡应该跳过了 LLM 相关步骤
    const skippedSteps = metrics.stepResults.filter(r => r.status === 'skipped');
    expect(skippedSteps.length).toBeGreaterThan(0);
  });

  it('MEMORY_FORGET_ENABLED=0 时 purge 不执行', async () => {
    const config = loadSleepConfig({
      MEMARCH_NAMESPACE: 'test',
      MEMORY_FORGET_ENABLED: '0',
    });

    const orchestrator = new SleepOrchestrator(db, config);
    const metrics = await orchestrator.execute('main', false);

    // 遗忘关闭，purge 数量应为 0
    expect(metrics.purgeCount).toBe(0);
  });

  it('Harness 指标看板数据结构完整', async () => {
    const config = loadSleepConfig({
      MEMARCH_NAMESPACE: 'test',
      MEMORY_FORGET_ENABLED: '1',
    });

    const orchestrator = new SleepOrchestrator(db, config);
    const metrics = await orchestrator.execute('main', false);

    // 验证看板结构
    expect(metrics).toHaveProperty('runId');
    expect(metrics).toHaveProperty('stepResults');
    expect(metrics).toHaveProperty('llmBudget');
    expect(metrics).toHaveProperty('purgeCount');
    expect(metrics).toHaveProperty('dailyPurgeCount');
    expect(metrics).toHaveProperty('checkpoint');
    expect(metrics).toHaveProperty('promotionStats');
    expect(metrics.llmBudget).toHaveProperty('usedTokens');
    expect(metrics.llmBudget).toHaveProperty('totalBudget');
  });
});
