/**
 * anchor-rebuild-guard.test.ts — 3b 重建器修复回归测试（2026-10-19，D003授权 / R012标准）
 * ============================================================
 * 被守的缺陷（I003/I004 实锤）：`_rebuildMemoryAnchors()` 按 (dialog_group_id, belong_entity_uuid)
 * 分组，混合组产生多行，但循环内所有行共用同一主键 `id = dg + '_ANCHOR'` + INSERT OR REPLACE
 * ⇒ 锚点最终归属 = UUID 字典序最大者（与多数决无关），每次启动都错写一遍。
 *   （天气窜记忆的存量错配来源：DG_11824 玉瑶10轮+阿珍6轮 → 归阿珍，因为 '8' > '1'。）
 *
 * 修复：
 *   3a 分组查询收编为模块级导出 ANCHOR_REBUILD_GROUPS_SQL —— 每组只返回**多数决归属**行，
 *      判据与 resolveAnchorOwnership 完全同源（COUNT DESC, MIN(seq_pos) ASC LIMIT 1 + is_test 过滤）。
 *      生产与本测试共用同一 SQL 字符串（防判据漂移）。
 *   3b(b) perception_40d 移出 ANCHOR_REBUILD_DERIVED_COLUMNS —— 重建时旧行非零 40D 由
 *      _restoreSnap 快照回填恢复（原分类为"派生列"导致恒写全零，实测 10-16 事件锚点 108 条被覆盖）。
 *
 * R012 覆盖要求：混合组 / 单一组 / 空组 / 新建组 / 重启后再重启（幂等）。
 * 判据来源：ANCHOR_REBUILD_GROUPS_SQL（生产同源字符串）+ ANCHOR_REBUILD_DERIVED_COLUMNS。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  ANCHOR_REBUILD_GROUPS_SQL,
  ANCHOR_REBUILD_DERIVED_COLUMNS,
  computeAnchorRestoreColumns,
} from '../SQLiteAdapter.js';

/** 内存库夹具：memories/conversations 最小列集（只含分组查询引用的列） */
function makeFixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY, dialog_group_id TEXT, belong_entity_uuid TEXT,
      seq_pos INTEGER, role TEXT, content TEXT, timestamp TEXT, calcium_score REAL,
      topic TEXT, global_uid TEXT, dna_root_id TEXT, is_test INTEGER
    );
  `);
  return db;
}

function ins(db: any, dg: string, eu: string | null, seq: number, opts: { test?: number; ca?: number; topic?: string; ts?: string } = {}): void {
  db.prepare(`INSERT INTO conversations (dialog_group_id, belong_entity_uuid, seq_pos, role, content, timestamp, calcium_score, topic, is_test)
    VALUES (?, ?, ?, 'user', '内容', ?, ?, ?, ?)`)
    .run(dg, eu, seq, opts.ts ?? `2026-10-0${seq}T00:00:00Z`, opts.ca ?? 0.5, opts.topic ?? null, opts.test ?? 0);
}

describe('3a — ANCHOR_REBUILD_GROUPS_SQL 多数决分组（生产同源）', () => {
  it('混合组：只返回多数决归属行（同数取 MIN(seq_pos) 最早轮）——I003/I004 精确反转', () => {
    const db = makeFixtureDb();
    // 玉瑶 3 轮 + 阿珍 2 轮（玉瑶多数；若按字典序 'TXS-9' 会赢，多数决不看字典序）
    ins(db, 'DG_MIX', 'TXS-000000001', 1); ins(db, 'DG_MIX', 'TXS-000000001', 2); ins(db, 'DG_MIX', 'TXS-000000001', 3);
    ins(db, 'DG_MIX', 'TXS-000000009', 4); ins(db, 'DG_MIX', 'TXS-000000009', 5);
    const rows = db.prepare(ANCHOR_REBUILD_GROUPS_SQL).all() as any[];
    expect(rows.length).toBe(1);                       // 每组只有一行（主键不再互相覆盖）
    expect(rows[0].belong_entity_uuid).toBe('TXS-000000001'); // 多数决胜出（字典序大的9落选）

    // 同数平局：取 MIN(seq_pos) 最早轮的归属
    const db2 = makeFixtureDb();
    ins(db2, 'DG_TIE', 'TXS-000000009', 1); ins(db2, 'DG_TIE', 'TXS-000000009', 2);
    ins(db2, 'DG_TIE', 'TXS-000000001', 3); ins(db2, 'DG_TIE', 'TXS-000000001', 4);
    const tie = db2.prepare(ANCHOR_REBUILD_GROUPS_SQL).all() as any[];
    expect(tie.length).toBe(1);
    expect(tie[0].belong_entity_uuid).toBe('TXS-000000009'); // 最早轮属9
    db.close(); db2.close();
  });

  it('单一组：正常返回（行为不变性）', () => {
    const db = makeFixtureDb();
    ins(db, 'DG_SINGLE', 'TXS-000000003', 1); ins(db, 'DG_SINGLE', 'TXS-000000003', 2);
    const rows = db.prepare(ANCHOR_REBUILD_GROUPS_SQL).all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].belong_entity_uuid).toBe('TXS-000000003');
    expect(rows[0].tc).toBe(2);
    db.close();
  });

  it('空组：belong 为 NULL/空串的组不返回（宁拒不放）', () => {
    const db = makeFixtureDb();
    ins(db, 'DG_NULL', null, 1); ins(db, 'DG_EMPTY', '', 2);
    const rows = db.prepare(ANCHOR_REBUILD_GROUPS_SQL).all() as any[];
    expect(rows.length).toBe(0);
    db.close();
  });

  it('新建组：单轮组正常返回（重建器会为其新建锚点）', () => {
    const db = makeFixtureDb();
    ins(db, 'DG_NEW', 'TXS-000000005', 1);
    const rows = db.prepare(ANCHOR_REBUILD_GROUPS_SQL).all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].tc).toBe(1);
    expect(rows[0].belong_entity_uuid).toBe('TXS-000000005');
    db.close();
  });

  it('is_test=1 的行不参与多数决（隔离区不回流，与外层聚合同口径）', () => {
    const db = makeFixtureDb();
    // 玉瑶 2 轮真实 + 阿珍 2 轮测试行 → 多数决仍是玉瑶（测试行被过滤）
    ins(db, 'DG_TEST', 'TXS-000000001', 1); ins(db, 'DG_TEST', 'TXS-000000001', 2);
    ins(db, 'DG_TEST', 'TXS-000000009', 3, { test: 1 }); ins(db, 'DG_TEST', 'TXS-000000009', 4, { test: 1 });
    const rows = db.prepare(ANCHOR_REBUILD_GROUPS_SQL).all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].belong_entity_uuid).toBe('TXS-000000001');
    db.close();
  });

  it('幂等：同一库连跑两次，结果完全一致（重启后再重启）', () => {
    const db = makeFixtureDb();
    ins(db, 'DG_MIX', 'TXS-000000001', 1); ins(db, 'DG_MIX', 'TXS-000000001', 2); ins(db, 'DG_MIX', 'TXS-000000001', 3);
    ins(db, 'DG_MIX', 'TXS-000000009', 4); ins(db, 'DG_MIX', 'TXS-000000009', 5);
    ins(db, 'DG_NEW', 'TXS-000000005', 6);
    const r1 = JSON.stringify(db.prepare(ANCHOR_REBUILD_GROUPS_SQL).all());
    const r2 = JSON.stringify(db.prepare(ANCHOR_REBUILD_GROUPS_SQL).all());
    expect(r1).toBe(r2);
    db.close();
  });

  it('生产函数引用该导出常量（防内联回退）', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'SQLiteAdapter.ts'), 'utf8');
    const fnStart = src.indexOf('private _rebuildMemoryAnchors');
    expect(fnStart).toBeGreaterThan(-1);
    // 函数体很长（前置 V22 快照段），取到下一个成员方法定义为止
    const fnNext = src.indexOf('\n  private ', fnStart + 10);
    const fnBody = src.substring(fnStart, fnNext > 0 ? fnNext : fnStart + 20000);
    expect(fnBody).toMatch(/this\.db\.exec\(ANCHOR_REBUILD_GROUPS_SQL\)/);
    // 不得再内联旧的多行同主键分组查询
    expect(fnBody).not.toMatch(/GROUP BY dialog_group_id, belong_entity_uuid\)/);
  });
});

describe('3b(b) — perception_40D 快照回填列归位', () => {
  it('perception_40d 不在派生列集合中（重建时由快照回填恢复旧行非零40D）', () => {
    expect(ANCHOR_REBUILD_DERIVED_COLUMNS.has('perception_40d')).toBe(false);
  });

  it('真正由其他列计算的派生列仍在集合中（防止过度移除）', () => {
    for (const c of ['anchor_score', 'topic_label', 'time_period', 'round_count', 'calcium_score', 'belong_entity_uuid']) {
      expect(ANCHOR_REBUILD_DERIVED_COLUMNS.has(c)).toBe(true);
    }
  });

  it('computeAnchorRestoreColumns 输出包含 perception_40d（表列 - 派生列）', () => {
    const cols = ['id', 'seq_pos', 'created_at', 'perception_40d', 'anchor_score', 'recall_count'];
    const restore = computeAnchorRestoreColumns(cols);
    expect(restore).toContain('perception_40d');   // 回填覆盖 40D
    expect(restore).toContain('recall_count');     // 其他快照列不受影响
    expect(restore).not.toContain('anchor_score'); // 派生列仍走 _fillDerived
  });
});
