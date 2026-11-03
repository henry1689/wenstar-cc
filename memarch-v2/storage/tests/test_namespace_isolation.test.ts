/**
 * 命名空间隔离测试
 * 验收项: namespace='test' / roleplay_char / tombstone 数据在 v_conv_real/v_mem_real 中不可见
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
let db: Database.Database;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['01_schema_init.sql', '02_indexes.sql', '03_fts5.sql', '05_views.sql']) {
    db.exec(readFileSync(join(__dirname, '..', 'ddl', f), 'utf-8'));
  }
  db.exec(readFileSync(join(__dirname, 'fixtures', 'test_data.sql'), 'utf-8'));
});

describe('命名空间隔离视图', () => {
  it('v_conv_real 只暴露 default 且非角色非 tombstone 数据', () => {
    const rows = db.prepare(`SELECT message_id FROM v_conv_real ORDER BY message_id`).all() as { message_id: string }[];
    const ids = rows.map((r) => r.message_id);
    expect(ids).toContain('test-msg-001');
    expect(ids).toContain('test-msg-002');
    expect(ids).toContain('test-msg-003');
    // 以下必须不可见
    expect(ids).not.toContain('test-msg-t1');   // namespace=test
    expect(ids).not.toContain('test-msg-t2');
    expect(ids).not.toContain('test-msg-r1');   // roleplay_char=王全芬
    expect(ids).not.toContain('test-msg-x1');   // lifecycle_state=tombstone
  });

  it('v_mem_real 隔离 test/tombstone', () => {
    const rows = db.prepare(`SELECT id FROM v_mem_real ORDER BY id`).all() as { id: string }[];
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('mem-test-001');
    expect(ids).toContain('mem-test-002');
    expect(ids).not.toContain('mem-test-t1');   // namespace=test
    expect(ids).not.toContain('mem-test-x1');   // tombstone
  });

  it('v_conv_test / v_mem_test 仅测试代码使用，可见 test 数据', () => {
    const conv = db.prepare(`SELECT COUNT(*) AS c FROM v_conv_test`).get() as { c: number };
    expect(conv.c).toBe(2);
    const mem = db.prepare(`SELECT COUNT(*) AS c FROM v_mem_test`).get() as { c: number };
    expect(mem.c).toBe(1);
  });

  it('生产视图与测试视图完全零重叠', () => {
    const real = db.prepare(`SELECT COUNT(*) AS c FROM v_conv_real`).get() as { c: number };
    const test = db.prepare(`SELECT COUNT(*) AS c FROM v_conv_test`).get() as { c: number };
    expect(real.c + test.c).toBe(5); // 3 default + 2 test（tombstone/roleplay 不计）
  });
});
