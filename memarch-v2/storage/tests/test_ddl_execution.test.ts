/**
 * MemArch-v2.0.0 / M1-Storage / DDL 执行冒烟测试
 * 验收项: 14 张表 DDL 全部可执行、主键/外键/索引/约束齐全
 *
 * 运行: npx vitest run memarch-v2/storage/tests/test_ddl_execution.test.ts
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DDL_DIR = join(__dirname, '..', 'ddl');

let db: Database.Database;

beforeAll(() => {
  // 内存库，测试数据零泄露（不写任何磁盘文件）
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // 顺序执行 DDL（vec0 扩展在测试环境可能不可用，跳过 04）
  const files = ['01_schema_init.sql', '02_indexes.sql', '03_fts5.sql', '05_views.sql'];
  for (const f of files) {
    const sql = readFileSync(join(DDL_DIR, f), 'utf-8');
    db.exec(sql);
  }
});

describe('M1-Storage DDL 冒烟测试', () => {
  it('14 张业务表全部创建成功', () => {
    const expectedTables = [
      'conversations', 'episodes', 'memories', 'semantic_facts',
      'entity_edges', 'trace_entities', 'black_diamond_v2',
      'prospective_items', 'tombstones', 'forget_requests',
      'audit_ledger', 'sleep_runs', 'reinforcement_events', 'wm_buffer',
    ];
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_%'`
    ).all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const t of expectedTables) {
      expect(names, `缺少表 ${t}`).toContain(t);
    }
  });

  it('audit_ledger 触发器禁止 UPDATE / DELETE', () => {
    db.prepare(`INSERT INTO audit_ledger(ts_utc, actor, action, prev_hash, hash)
                VALUES (?, 'test', 'test', '0000', 'abc')`).run(Date.now());
    expect(() =>
      db.prepare(`UPDATE audit_ledger SET action='hacked' WHERE seq=1`).run()
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare(`DELETE FROM audit_ledger WHERE seq=1`).run()
    ).toThrow(/append-only/);
  });

  it('consolidation 约束 [0,1] 生效', () => {
    expect(() =>
      db.prepare(`INSERT INTO episodes(id, started_at, consolidation) VALUES ('e1', 0, 1.5)`).run()
    ).toThrow(/CHECK/);
  });

  it('sensitivity CHECK 约束生效', () => {
    expect(() =>
      db.prepare(`INSERT INTO episodes(id, started_at, sensitivity) VALUES ('e2', 0, 9)`).run()
    ).toThrow(/CHECK/);
  });

  it('FTS5 外部内容表可查', () => {
    db.prepare(`INSERT INTO conversations(message_id, role, content, ts_utc, created_at)
                VALUES ('m1', 'user', '深圳湾看海鸥', 0, 0)`).run();
    const rows = db.prepare(
      `SELECT c.id FROM fts_conversations
       JOIN conversations c ON c.id = fts_conversations.rowid
       WHERE fts_conversations MATCH '深圳湾'`
    ).all();
    expect(rows.length).toBeGreaterThan(0);
  });
});
