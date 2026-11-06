/**
 * 命名空间隔离测试（v2.1.0 / ADR-016 变更 #3 #4）
 *
 * 🔴 语义变更：视图**不再按 namespace 过滤**，只保留生命周期 + roleplay 过滤。
 *   namespace 隔离**下移到查询层显式参数**（QueryContext.namespace + `AND m.namespace = @ns`）。
 *   原因：按角色分 ns 写入的数据在 default 域 **0 条**，视图硬编码 `='default'` 会让生产检索
 *   恒返回 0 条，却因「任何 ns 都命中 0、测不出区别」而看不出隔离已经失效。
 *
 *   故本文件验收项由「视图按 ns 隔离」改为：
 *     ① 视图仍过滤 tombstone/purged 与 roleplay（生命周期语义，与 ns 无关）
 *     ② `v_*_test` 仍只暴露 test 数据（测试代码专用入口）
 *     ③ **查询层必须带 ns 参数** —— 由 retrieval 各腿的 `@ns` SQL 保证
 *        （见 memarch-v2/retrieval/recall/bm25.ts 等），不归视图管
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

describe('命名空间隔离视图（v2.1.0 语义）', () => {
  it('v_conv_real 过滤 roleplay/tombstone；namespace 不再由视图过滤', () => {
    const rows = db.prepare(`SELECT message_id, namespace FROM v_conv_real ORDER BY message_id`).all() as { message_id: string; namespace: string }[];
    const ids = rows.map((r) => r.message_id);
    // default 数据可见
    expect(ids).toContain('test-msg-001');
    expect(ids).toContain('test-msg-002');
    expect(ids).toContain('test-msg-003');
    // 仍必须不可见 —— 这两条与 namespace 无关，是视图保留的过滤职责
    expect(ids).not.toContain('test-msg-r1');   // roleplay_char=王全芬
    expect(ids).not.toContain('test-msg-x1');   // lifecycle_state=tombstone
    // 🔴 v2.1.0 反向断言：namespace 不再由视图过滤，test 数据**会**出现在视图里。
    //    故意断言 toContain —— 若有人把 ns 过滤偷偷加回视图（那正是让生产检索
    //    恒返回 0 条的原因），本用例立刻失败并指向真正该改的地方：查询层 @ns 参数。
    expect(ids).toContain('test-msg-t1');
    expect(ids).toContain('test-msg-t2');
  });

  it('v_mem_real 过滤 tombstone；namespace 由查询层保证', () => {
    const rows = db.prepare(`SELECT id FROM v_mem_real ORDER BY id`).all() as { id: string }[];
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('mem-test-001');
    expect(ids).toContain('mem-test-002');
    expect(ids).not.toContain('mem-test-x1');   // tombstone
    // 同上：ns 不再由视图过滤，反向固化
    expect(ids).toContain('mem-test-t1');
  });

  it('v_conv_test / v_mem_test 仅测试代码使用，可见 test 数据', () => {
    const conv = db.prepare(`SELECT COUNT(*) AS c FROM v_conv_test`).get() as { c: number };
    expect(conv.c).toBe(2);
    const mem = db.prepare(`SELECT COUNT(*) AS c FROM v_mem_test`).get() as { c: number };
    expect(mem.c).toBe(1);
  });

  it('查询层 ns 参数是隔离的唯一边界（视图不再兜底）', () => {
    // 视图不再按 ns 过滤 ⇒ 同一批行会同时出现在 v_conv_real 与 v_conv_test。
    // 这是**预期行为**：隔离责任已移交查询层（`AND m.namespace = @ns`）。
    // 此处固化该事实，避免后人误以为"零重叠"仍是契约而把 ns 过滤加回视图。
    const real = db.prepare(`SELECT COUNT(*) AS c FROM v_conv_real`).get() as { c: number };
    const test = db.prepare(`SELECT COUNT(*) AS c FROM v_conv_test`).get() as { c: number };
    expect(real.c).toBe(5);   // 3 default + 2 test（roleplay/tombstone 已排除）
    expect(test.c).toBe(2);
    const overlap = db.prepare(`
      SELECT COUNT(*) AS c FROM v_conv_real r JOIN v_conv_test t ON r.message_id = t.message_id
    `).get() as { c: number };
    expect(overlap.c).toBe(2);   // 交集非空 = 视图确实不再承担 ns 隔离
  });
});
