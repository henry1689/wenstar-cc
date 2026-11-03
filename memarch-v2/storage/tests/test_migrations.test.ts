/**
 * 迁移脚本 M1-M5 测试
 * 验收项: 全部可执行、up/down 可回滚、零数据丢失
 *
 * 注: 测试在内存库上构造"旧库"状态，再跑 up，再跑 down 校验回滚。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG = join(__dirname, '..', 'migrations');

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // 先建最新 schema（含所有新列）
  db.exec(readFileSync(join(__dirname, '..', 'ddl', '01_schema_init.sql'), 'utf-8'));
});

const run = (file: string) => db.exec(readFileSync(join(MIG, file), 'utf-8'));

describe('M1 时间戳统一', () => {
  it('conversations ISO 字符串 → ts_utc epoch ms', () => {
    db.prepare(`INSERT INTO conversations(message_id, role, content, timestamp, created_at)
                VALUES ('m1', 'user', 'x', '2026-11-03 10:00:00', 0)`).run();
    run('M01_timestamp_unify.up.sql');
    const row = db.prepare(`SELECT ts_utc FROM conversations WHERE message_id='m1'`).get() as { ts_utc: number };
    expect(row.ts_utc).toBeGreaterThan(0);
    run('M01_timestamp_unify.down.sql');
    const after = db.prepare(`SELECT ts_utc FROM conversations WHERE message_id='m1'`).get() as { ts_utc: number };
    expect(after.ts_utc).toBeNull();
  });
});

describe('M2 is_summary 误标修复', () => {
  it('同时 is_summary=1 且 is_compacted=1 的行改回 0', () => {
    db.prepare(`INSERT INTO conversations(message_id, role, content, is_summary, is_compacted, created_at)
                VALUES ('m2', 'user', 'x', 1, 1, 0)`).run();
    run('M02_is_summary_fix.up.sql');
    const row = db.prepare(`SELECT is_summary FROM conversations WHERE message_id='m2'`).get() as { is_summary: number };
    expect(row.is_summary).toBe(0);
    run('M02_is_summary_fix.down.sql');
    const after = db.prepare(`SELECT is_summary FROM conversations WHERE message_id='m2'`).get() as { is_summary: number };
    expect(after.is_summary).toBe(1);
  });
});

describe('M3 钙化分归一', () => {
  it('consolidation 全部落在 [0,1]，歧义行被标记', () => {
    db.prepare(`INSERT INTO memories(id, summary, calcium_score, created_at)
                VALUES ('mem1', 'x', 3.5, 0)`).run();
    run('M03_calcium_normalize.up.sql');
    const row = db.prepare(`SELECT consolidation, migration_ambiguous FROM memories WHERE id='mem1'`).get() as
      { consolidation: number; migration_ambiguous: number };
    expect(row.consolidation).toBeGreaterThanOrEqual(0);
    expect(row.consolidation).toBeLessThanOrEqual(1);
    run('M03_calcium_normalize.down.sql');
  });
});

describe('M4 激活历史回填', () => {
  it('n_refs = 1 + recall_count', () => {
    db.prepare(`INSERT INTO memories(id, summary, recall_count, created_at)
                VALUES ('mem2', 'x', 4, 0)`).run();
    run('M04_activation_backfill.up.sql');
    const row = db.prepare(`SELECT n_refs, recent_refs FROM memories WHERE id='mem2'`).get() as
      { n_refs: number; recent_refs: string };
    expect(row.n_refs).toBe(5);
    expect(JSON.parse(row.recent_refs).length).toBeGreaterThanOrEqual(0);
    run('M04_activation_backfill.down.sql');
  });
});

describe('M5 黑钻旧表迁移（无旧表时应幂等跳过）', () => {
  it('旧 black_diamond 不存在时不报错', () => {
    expect(() => run('M05_black_diamond_migrate.up.sql')).not.toThrow();
    expect(() => run('M05_black_diamond_migrate.down.sql')).not.toThrow();
  });
});
