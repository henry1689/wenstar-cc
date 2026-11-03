/**
 * M2 测试辅助：初始化内存数据库
 * 使用 better-sqlite3 内存模式，测试后自动销毁
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 执行 M1 DDL（只跑基础 schema）
  const ddlPath = join(__dirname, '..', '..', '..', 'storage', 'ddl', '01_schema_init.sql');
  const ddl = readFileSync(ddlPath, 'utf-8');
  db.exec(ddl);

  return db;
}

export function resetTestDb(db) {
  db.exec(`
    DELETE FROM conversations;
    DELETE FROM memories;
    DELETE FROM episodes;
    DELETE FROM wm_buffer;
    DELETE FROM prospective_items;
    DELETE FROM trace_entities;
    DELETE FROM entity_edges;
    DELETE FROM semantic_facts;
    DELETE FROM black_diamond_v2;
    DELETE FROM tombstones;
    DELETE FROM forget_requests;
    DELETE FROM sleep_runs;
    DELETE FROM reinforcement_events;
    DELETE FROM audit_ledger;
  `);
}
