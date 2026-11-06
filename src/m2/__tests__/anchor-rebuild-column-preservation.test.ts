/**
 * 锚点重建器「列保留」护栏测试（V22，2026-09-23）
 * ==========================================================
 * 为什么需要这个测试（事故背景）：
 *   `_rebuildMemoryAnchors()` 每次服务启动都会 DELETE 全部 `%_ANCHOR` / `%_CHUNK`
 *   然后重建，而重建只主动写一部分列 → 其余列被静默清 NULL/DEFAULT。
 *   实测代价：2026-09-22 回填的 907 条锚点 anchor_score，次日重启后仅剩 8 条；
 *   topic_label 918/926、time_period 925/926 同样被清零。
 *   历史上 entity_genes 也被同样抹除（当时靠「逐列补清单」修复，因此本轮又复发）。
 *
 * 本测试的断言策略（刻意规避经验 21 的陷阱）：
 *   ✅ 用**能力断言**：任意「非派生列」必须自动进入回填范围（含未来新增列）
 *   ✅ 用**语义清单断言**：被清零过的列必须被归入派生列（即必定被重算）
 *   ❌ 不使用计数断言、不依赖位置、不锁死 SQL 字面形态
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import {
  ANCHOR_REBUILD_DERIVED_COLUMNS,
  computeAnchorRestoreColumns,
  SQLiteAdapter,
} from '../SQLiteAdapter.js';

/** memories 表真实列（取自 2026-09-23 生产库 PRAGMA table_info）——作为固定基线 */
const REAL_TABLE_COLUMNS: readonly string[] = [
  'id', 'seq_pos', 'created_at', 'perception_40d', 'calcium_score', 'calcium_level',
  'locus_path', 'leaf_zone', 'raw_input', 'memory_kind', 'lifecycle_state',
  'confidence_score', 'stability_score', 'last_verified_at', 'promotion_reason',
  'suppression_reason', 'archived_at', 'healed_at', 'thread_id', 'session_id',
  'dialog_group_id', 'source_conversation_ids', 'recall_count', 'promoted_to_diamond',
  'last_recalled_at', 'reinforcement_accumulator', 'effective_strength',
  'strength_updated_at', 'vad_spectrum', 'is_landmark', 'landmarked_at',
  'narrative_tag', 'sensory_anchor', 'scar_type', 'scar_healed', 'primary_emotion',
  'secondary_emotions', 'dna_root_id', 'entity_genes', 'is_promoted',
  'fg_entity_names', 'time_period', 'season', 'lunar_term', 'namespace',
  'source_type', 'belong_entity_uuid', 'is_foresight', 'valid_until_ms',
  'foresight_status', 'round_count', 'topic_label', 'anchor_score', 'perception_v2',
  'dna_full_code', 'l2_norm', 'global_uid', 'location_fingerprint', 'valid_start_ms',
  'foresight_reason', 'work_id', 'memory_type', 'sub_type', 'note_key', 'is_valid',
  'remind_at', 'reminded', 'repeat_rule', 'perception_v40_direct', 'v40_comparison_diff',
];

describe('V22 锚点重建器列保留规则', () => {
  describe('A. 被清零过的列必须被视为「派生列」（即必定被重建重算）', () => {
    // 这些列在 2026-09-23 实测被清零：anchor_score 918/926、topic_label 918/926、
    // time_period 925/926。它们必须由重建器主动写出，否则下次重启照旧清零。
    const MUST_BE_DERIVED = [
      'anchor_score',
      'topic_label',
      'time_period',
      'season',
      'lunar_term',
      'round_count',
      'last_verified_at',
    ];

    for (const col of MUST_BE_DERIVED) {
      it(`派生列清单包含 ${col}（该列曾被静默清零）`, () => {
        expect(ANCHOR_REBUILD_DERIVED_COLUMNS.has(col)).toBe(true);
      });
    }
  });

  describe('B. 能力断言：非派生列自动纳入回填（防未来复发）', () => {
    it('运行期才有值的列必须进入回填清单（否则每次重启丢历史）', () => {
      const restore = computeAnchorRestoreColumns(REAL_TABLE_COLUMNS);
      // 这些列的语义是「运行期累积」，重建无法重新推导 → 只能靠快照回填保住
      const RUNTIME_ACCUMULATED = [
        'recall_count',
        'last_recalled_at',
        'is_promoted',
        'promoted_to_diamond',
        'reinforcement_accumulator',
        'narrative_tag',
        'sensory_anchor',
        'scar_type',
        'scar_healed',
        'source_conversation_ids',
        'session_id',
        'work_id',
        'vad_spectrum',
        'secondary_emotions',
        'perception_v2',
        'perception_v40_direct',
      ];
      for (const col of RUNTIME_ACCUMULATED) {
        expect(restore, `${col} 必须进入回填清单`).toContain(col);
      }
    });

    it('★ 防复发核心：未来任意新增列必须自动纳入回填（无需改代码）', () => {
      // 模拟「以后有人给 memories 加了一列」——这正是 entity_genes / anchor_score
      // 两次事故的共同成因：新增列不在重建器清单里 → 被静默清零。
      const futureColumn = 'zz_future_added_column_2026';
      const restore = computeAnchorRestoreColumns([...REAL_TABLE_COLUMNS, futureColumn]);
      expect(restore).toContain(futureColumn);
    });

    it('回填清单与派生列清单互不重叠（不得用旧值覆盖新算值）', () => {
      const restore = computeAnchorRestoreColumns(REAL_TABLE_COLUMNS);
      for (const col of restore) {
        expect(ANCHOR_REBUILD_DERIVED_COLUMNS.has(col)).toBe(false);
      }
    });

    it('主键 id 不参与回填（回填是 UPDATE ... WHERE id=?，列清单不该含 id）', () => {
      expect(computeAnchorRestoreColumns(REAL_TABLE_COLUMNS)).not.toContain('id');
    });
  });

  describe('C. 健壮性：回填清单只接受合法列名（防 SQL 拼接注入）', () => {
    it('非法列名被过滤，合法列名保留', () => {
      const dirty = ['ok_column', 'bad column', 'x; DROP TABLE memories', '1start', '', 'UPPER_OK'];
      const restore = computeAnchorRestoreColumns(dirty);
      expect(restore).toContain('ok_column');
      expect(restore).not.toContain('bad column');
      expect(restore).not.toContain('x; DROP TABLE memories');
      expect(restore).not.toContain('1start');
      expect(restore).not.toContain('');
    });
  });

  describe('D. 覆盖完整性：生产库真实列中不得存在「既不派生也不回填」的漏网列', () => {
    it('每一列要么被重建重算，要么被快照回填（无第三态）', () => {
      const restore = new Set(computeAnchorRestoreColumns(REAL_TABLE_COLUMNS));
      const orphans = REAL_TABLE_COLUMNS.filter(
        c => !ANCHOR_REBUILD_DERIVED_COLUMNS.has(c) && !restore.has(c),
      );
      expect(orphans, `下列列既不被重算也不被回填，会被静默清零: ${orphans.join(', ')}`).toEqual([]);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// V22 生产**接线**测试（S4 评审 F6）
//
// 为什么必须单独有这一段：上面 A~D 只验证了「规则」（纯函数），无法证明生产代码
// 真的调用了快照回填。实测敏感度：把 `_restoreSnap(p.id)` / `_fillDerived(...)` 任一调用
// 从 `_rebuildMemoryAnchors()` 删掉，上面 A~D 仍**全部绿**。
// 本段用**真实 sql.js 库 + 真实 schema** 驱动生产方法本体，使接线断开时必定变红。
// ══════════════════════════════════════════════════════════════════════════

const SCHEMA_SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');

/** 桩适配器：用真库驱动 `_rebuildMemoryAnchors()`，只截断落盘 */
function makeAdapter(db: any): any {
  const a: any = new SQLiteAdapter('D:/tmp/__unused_v22_wiring_test.db');
  a.db = db;   // 2026-11-06 迁移：写即落盘，不再需要 flush 桩
  return a;
}

/** schema.sql 缺运行时 ALTER 新增列（如 anchor_score/topic_label）——按代码实际需要的列补齐，自维护 */
const NUMERIC_COLS = new Set([
  'anchor_score', 'round_count', 'l2_norm', 'valid_start_ms', 'valid_until_ms',
  'v40_comparison_diff', 'reinforcement_accumulator', 'effective_strength',
]);
function ensureColumns(db: any, table: string, cols: readonly string[]): void {
  const res = db.exec(`PRAGMA table_info(${table})`);
  const have = new Set<string>((res.length ? res[0].values : []).map((r: any[]) => String(r[1])));
  for (const c of cols) {
    if (have.has(c) || !/^[a-z_][a-z0-9_]*$/i.test(c)) continue;
    // 列类型必须与生产一致（REAL/INTEGER vs TEXT）——否则数值列会以字符串返回，造成假阴性
    db.run(`ALTER TABLE ${table} ADD COLUMN ${c} ${NUMERIC_COLS.has(c) ? 'REAL' : 'TEXT'}`);
  }
}

/** 播种子：一个对话组 + （可选）已存在的旧锚点行 */
async function buildFixture(opts: {
  dg: string; uuid: string; existingAnchorPreserved?: Record<string, unknown> | null;
}): Promise<any> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(readFileSync(SCHEMA_SQL, 'utf-8'));
  ensureColumns(db, 'memories', [...ANCHOR_REBUILD_DERIVED_COLUMNS]);
  ensureColumns(db, 'conversations', ['global_uid', 'dna_root_id', 'location_fingerprint']);

  db.run("INSERT INTO entities (uuid, name, type) VALUES (?,?,?)", [opts.uuid, '测试实体', 'person']);
  const ts = '2026-09-23T10:00:00.000Z';
  db.run(
    "INSERT INTO conversations (role,content,timestamp,seq_pos,topic,calcium_score,dna_root_id,dialog_group_id,dialog_round,is_test,belong_entity_uuid) " +
    "VALUES ('user','你好',?,1,'日常',0.60,'DNAX',?,1,0,?)", [ts, opts.dg, opts.uuid]);
  db.run(
    "INSERT INTO conversations (role,content,timestamp,seq_pos,topic,calcium_score,dna_root_id,dialog_group_id,dialog_round,is_test,belong_entity_uuid) " +
    "VALUES ('assistant','在的',?,2,'日常',0.60,'DNAX',?,1,0,?)", [ts, opts.dg, opts.uuid]);

  if (opts.existingAnchorPreserved) {
    const p = opts.existingAnchorPreserved;
    db.run(
      "INSERT INTO memories (id,seq_pos,created_at,calcium_score,calcium_level,locus_path,leaf_zone,raw_input," +
      "strength_updated_at,dialog_group_id,belong_entity_uuid,recall_count,is_promoted,scar_type,session_id,anchor_score) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
      [opts.dg + '_ANCHOR', 1, ts, 0.6, 2, 'old.locus', 'language_semantic_zone', '旧锚点原文', ts,
       opts.dg, opts.uuid,
       p.recall_count ?? null, p.is_promoted ?? null, p.scar_type ?? null, p.session_id ?? null]);
  }
  return db;
}

const readAnchor = (db: any, id: string): Record<string, any> | null => {
  const res = db.exec(`SELECT * FROM memories WHERE id = '${id}'`);
  if (!res.length || !res[0].values.length) return null;
  const cols = res[0].columns as string[];
  const row: Record<string, any> = {};
  res[0].values[0].forEach((v: any, i: number) => { row[cols[i]] = v; });
  return row;
};

describe('[V22] 锚点重建器 —— 生产接线（真库驱动）', () => {
  it('★ 核心：重建后，旧锚点的运行期列被快照回填回来（不是被清 NULL）', async () => {
    const db = await buildFixture({
      dg: 'DGWIRE1', uuid: 'TXS-000090001',
      existingAnchorPreserved: { recall_count: 7, is_promoted: 1, scar_type: 'loss', session_id: 'S-WIRE-1' },
    });
    const a = makeAdapter(db);
    const n = a._rebuildMemoryAnchors();

    expect(n, '应重建出 1 条锚点').toBeGreaterThanOrEqual(1);
    const row = readAnchor(db, 'DGWIRE1_ANCHOR');
    expect(row, '锚点行必须存在').not.toBeNull();
    // 这三列在修复前会被静默清 NULL（召回/晋升/伤痕/溯源）。删掉 _restoreSnap 调用即变红。
    expect(row!.recall_count, 'recall_count 必须由快照回填').toBe(7);
    expect(row!.is_promoted, 'is_promoted 必须由快照回填').toBe(1);
    expect(row!.scar_type, 'scar_type 必须由快照回填').toBe('loss');
    expect(row!.session_id, 'session_id 必须由快照回填').toBe('S-WIRE-1');
  });

  it('★ 核心：重建后派生列非空（anchor_score / topic_label / 时空标签 / round_count）', async () => {
    const db = await buildFixture({ dg: 'DGWIRE2', uuid: 'TXS-000090002', existingAnchorPreserved: {} });
    const a = makeAdapter(db);
    a._rebuildMemoryAnchors();
    const row = readAnchor(db, 'DGWIRE2_ANCHOR');
    expect(row).not.toBeNull();
    // 这 5 列在修复前 100% 为 NULL（实测 918/926、925/926）。删掉 _fillDerived 调用即变红。
    expect(row!.anchor_score, 'anchor_score 必须被派生写入').toBeGreaterThan(0);
    expect(row!.topic_label, 'topic_label 必须从 conversations.topic 派生').toBe('日常');
    expect(row!.time_period, 'time_period 必须被派生写入').toBeTruthy();
    expect(row!.season, 'season 必须被派生写入').toBeTruthy();
    expect(row!.lunar_term, 'lunar_term 必须被派生写入').toBeTruthy();
    expect(Number(row!.round_count), 'round_count 必须被派生写入').toBeGreaterThan(0);
  });

  it('快照为空时不得无中生有（NULL 保持 NULL，不伪造数据）', async () => {
    const db = await buildFixture({
      dg: 'DGWIRE3', uuid: 'TXS-000090003',
      existingAnchorPreserved: { recall_count: null, is_promoted: null, scar_type: null, session_id: null },
    });
    const a = makeAdapter(db);
    a._rebuildMemoryAnchors();
    const row = readAnchor(db, 'DGWIRE3_ANCHOR');
    expect(row).not.toBeNull();
    expect(row!.scar_type ?? null, '原本为 NULL 的列不得被写入值').toBeNull();
    expect(row!.session_id ?? null, '原本为 NULL 的列不得被写入值').toBeNull();
  });

  it('全新对话组（无快照）也能正确派生且不抛错', async () => {
    const db = await buildFixture({ dg: 'DGWIRE4', uuid: 'TXS-000090004', existingAnchorPreserved: null });
    const a = makeAdapter(db);
    const n = a._rebuildMemoryAnchors();
    expect(n).toBeGreaterThanOrEqual(1);
    const row = readAnchor(db, 'DGWIRE4_ANCHOR');
    expect(row).not.toBeNull();
    expect(row!.anchor_score).toBeGreaterThan(0);
    expect(String(row!.entity_genes || ''), '锚点必须带归属实体基因').toContain('测试实体');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// V49（2026-10-11）实体户籍判据 —— S4 独立评审打回清单第 4 项要求的回归测试
//
// 背景：_rebuildMemoryAnchors 每次启动 DELETE 全部 %_ANCHOR 后从 conversations 重建，
//   循环里原本没有归属存在性检查 → 无主实体的锚点每次重启复活（实测 92 条 id 集合 100% 复原）。
//
// 实测敏感度（删掉即红）：
//   · 删 `if (!entUuids.has(eu)) continue;`   → ① 红
//   · 删 `if (!entUuids) return 0;`           → ② 红
//   · 删 `if (this._fgUuids) ... s.add(u)`    → ③ 红
// ══════════════════════════════════════════════════════════════════════════
describe('[V49] 实体户籍判据 —— 无主实体锚点不重建', () => {
  it('① entities 中无该 uuid → 不重建锚点（根治「无主实体锚点每次启动复活」）', async () => {
    const db = await buildFixture({ dg: 'DGV49_1', uuid: 'TXS-000000991', existingAnchorPreserved: null });
    // 保留另一个实体，使判据可用集非空 —— 与 ② 的「集为空」区分开
    db.run("INSERT INTO entities (uuid, name, type) VALUES ('TXS-000000992','别的实体','person')");
    db.run("DELETE FROM entities WHERE uuid = 'TXS-000000991'");

    const a = makeAdapter(db);
    const n = a._rebuildMemoryAnchors();
    expect(n, '无主组不应产出锚点').toBe(0);
    expect(readAnchor(db, 'DGV49_1_ANCHOR'), '无主锚点必须不存在').toBeNull();
  });

  it('② 判据可用集为空 → fail-safe 直接 return 0、不执行 DELETE（旧行原样保留）', async () => {
    const db = await buildFixture({
      dg: 'DGV49_2', uuid: 'TXS-000000993',
      existingAnchorPreserved: { recall_count: 5, is_promoted: 1 },
    });
    db.run('DELETE FROM entities');   // entities 全空；_fgUuids 默认 null ⇒ 可用集为空

    const a = makeAdapter(db);
    const n = a._rebuildMemoryAnchors();
    expect(n, '判据不可用时不得产出新锚点').toBe(0);
    const row = readAnchor(db, 'DGV49_2_ANCHOR');
    expect(row, 'fail-safe：旧行必须原样保留，不得被无条件 DELETE 摧毁').not.toBeNull();
    expect(row!.recall_count, '旧行数据不得被动').toBe(5);
    expect(row!.is_promoted).toBe(1);
  });

  it('③ FG-only uuid（entities 无、FG 有）仍重建 —— 判据必须是 entities ∪ FG', async () => {
    const db = await buildFixture({ dg: 'DGV49_3', uuid: 'TXS-000000994', existingAnchorPreserved: null });
    db.run("INSERT INTO entities (uuid, name, type) VALUES ('TXS-000000995','别的实体','person')");
    db.run("DELETE FROM entities WHERE uuid = 'TXS-000000994'");   // entities 无它

    const a = makeAdapter(db);
    a._fgUuids = new Set(['TXS-000000994']);                        // FG 有它（判据真源之二）
    const n = a._rebuildMemoryAnchors();
    expect(n, 'FG 认领的 uuid 必须重建 —— 否则会误杀活实体的锚点（S4 打回 P0-1）').toBeGreaterThanOrEqual(1);
    expect(readAnchor(db, 'DGV49_3_ANCHOR'), 'FG-only 锚点必须存在').not.toBeNull();
  });

  it('④ FG 载入失败(_fgLoadFailed=true) → fail-safe 整轮不 DELETE（S4 复审 P2-1）', async () => {
    const db = await buildFixture({
      dg: 'DGV49_4', uuid: 'TXS-000000996',
      existingAnchorPreserved: { recall_count: 9, is_promoted: 1 },
    });
    db.run("INSERT INTO entities (uuid, name, type) VALUES ('TXS-000000997','别的实体','person')");

    const a = makeAdapter(db);
    a._fgLoadFailed = true;          // 模拟 _loadFgUuids 的三个失败分支之一
    const n = a._rebuildMemoryAnchors();

    expect(n, 'FG 真源不可用时不得重建').toBe(0);
    const row = readAnchor(db, 'DGV49_4_ANCHOR');
    expect(row, '旧行必须原样保留 —— 不得先 DELETE 再拒收（那会永久丢失）').not.toBeNull();
    expect(row!.recall_count, '旧行数据不得被动').toBe(9);
    expect(row!.is_promoted).toBe(1);
  });

  it('⑤ _loadFgUuids：FG 库不存在 → 置 _fgLoadFailed 且 _fgUuids=null（降级路径覆盖）', async () => {
    // 专门覆盖 P2-2：原 init() 内联的文件载入路径此前零测试
    const a: any = new SQLiteAdapter('D:/tmp/__v49_no_fg_probe__/nonexistent.db');
    await a._loadFgUuids();
    expect(a._fgLoadFailed, 'FG 库不存在必须标记为载入失败').toBe(true);
    expect(a._fgUuids, '载入失败时不得伪造 uuid 集合').toBeNull();

    // 失败标记必须能触发整轮 fail-safe（与 ④ 同一条链路）
    const db = await buildFixture({
      dg: 'DGV49_5', uuid: 'TXS-000000998',
      existingAnchorPreserved: { recall_count: 3 },
    });
    db.run("INSERT INTO entities (uuid, name, type) VALUES ('TXS-000000999','别的实体','person')");
    const b = makeAdapter(db);
    b._fgLoadFailed = a._fgLoadFailed;
    expect(b._rebuildMemoryAnchors()).toBe(0);
    expect(readAnchor(db, 'DGV49_5_ANCHOR'), 'fail-safe 后旧行必须保留').not.toBeNull();
  });
});
