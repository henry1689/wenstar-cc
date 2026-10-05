import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { SQLiteAdapter } from '../SQLiteAdapter.js';
import { migrateSchema } from '../MigrationManager.js';

/**
 * [ADR-010 P1-A / 2026-10-06] 「重启不变量」回归守卫
 * ==================================================
 * 本文件锁住一条此前**完全没有测试覆盖**的路径：**服务启动**。
 *
 * 为什么现在才补（S1 诊断的元教训）：
 *   ADR-010 查出的全部缺陷 —— 锚点被替换为截断版、CHUNK 碎片被永久销毁、
 *   roleplay 隔离状态翻转 —— **统统发生在 `_rebuildMemoryAnchors()` 这条启动路径上**，
 *   而现有测试几乎不覆盖它。结果就是：代码注释声明的语义与重启后的实际语义不一致，
 *   而没有任何测试能发现。这与本仓历史上「注释写的才是对的」那类根因是同一族。
 *
 * 不变量（每条都对应一个已发生的真实事故）：
 *   ① `dialog_groups`（块级元数据唯一载体，MigrationManager v16）**不得被启动重建触碰**
 *      —— 把块级元数据挂到锚点行上正是被这条 DELETE 清空的，故必须独立表 + 本守卫。
 *   ② CHUNK 生产者已退役 ⇒ 启动 DELETE 的 `%_CHUNK%` 分支只清残留，不得再出现新行。
 *   ③ `mem_*` 逐轮行与 ANCHOR **不得被误伤**（DELETE 的 LIKE 转义写错就会误伤）。
 *   ④ 归属 `belong_entity_uuid` 在重建前后不翻转 —— 它是当前**唯一**承担角色隔离的判据
 *      （ADR-010 D4：隔离收敛到 UUID，退役 memory_kind==='roleplay' 的读侧排除）。
 *
 * ⚠️ 本测试**不**断言 `memory_kind` 取值。D4 的 kind 归一口径会把运行期写入方
 *    （persistence-stage）一并改动，属独立批次（见 ADR-010 §11）；半途只改一侧
 *    会制造新的口径分歧，比不动更糟。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = join(HERE, '..', 'schema.sql');

/** 桩适配器：用真库驱动 `_rebuildMemoryAnchors()`，只截断落盘 */
function makeAdapter(db: any): any {
  const a: any = new SQLiteAdapter('D:/tmp/__unused_restart_invariant_test.db');
  a.db = db;
  a.flushNow = () => {};
  a.flushNowAsync = () => {};
  a._dirtyCount = 0;
  return a;
}

const NUMERIC_COLS = new Set([
  'anchor_score', 'round_count', 'l2_norm', 'valid_start_ms', 'valid_until_ms',
  'v40_comparison_diff', 'reinforcement_accumulator', 'effective_strength',
]);
function ensureColumns(db: any, table: string, cols: readonly string[]): void {
  const res = db.exec(`PRAGMA table_info(${table})`);
  const have = new Set<string>((res.length ? res[0].values : []).map((r: any[]) => String(r[1])));
  for (const c of cols) {
    if (have.has(c) || !/^[a-z_][a-z0-9_]*$/i.test(c)) continue;
    db.run(`ALTER TABLE ${table} ADD COLUMN ${c} ${NUMERIC_COLS.has(c) ? 'REAL' : 'TEXT'}`);
  }
}

const q = (db: any, sql: string): any[] => {
  const res = db.exec(sql);
  if (!res.length || !res[0].values) return [];
  const cols = res[0].columns as string[];
  return res[0].values.map((v: any[]) => {
    const row: Record<string, any> = {};
    v.forEach((x, i) => { row[cols[i]] = x; });
    return row;
  });
};

/** 建库：真实 schema.sql + 真实 migrateSchema（顺带验证 v16 迁移） */
async function buildDb(): Promise<any> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(readFileSync(SCHEMA_SQL, 'utf-8'));
  // 🔴 schema.sql 是历史快照，缺一批「运行时由迁移/ALTER 补上」的列。
  //   夹具必须补齐 —— 否则 _rebuildMemoryAnchors 的 INSERT 会因缺列抛错，
  //   而该 INSERT 被 `catch { /* 单条失败不阻塞 */ }` **静默吞掉** ⇒ 测试表现为
  //   「锚点没重建」而非「缺列」，极易误判成被测代码有问题。（本文件实测踩过一次）
  ensureColumns(db, 'memories', [
    'memory_type', 'global_uid', 'location_fingerprint',      // 缺则锚点 INSERT 直接失败
    'anchor_score', 'round_count', 'topic_label', 'time_period', 'season', 'lunar_term', 'last_verified_at',
    'fg_entity_names', 'recall_count', 'promoted_to_diamond', 'effective_strength',
  ]);
  ensureColumns(db, 'conversations', ['global_uid', 'dna_root_id', 'location_fingerprint']);
  migrateSchema(db);
  return db;
}

const TS = '2026-10-06T10:00:00.000Z';

/** 播种子：一个对话组（conversations 两行 + 一条 ANCHOR + 可选 CHUNK 残留 + 可选 mem_ 行） */
function seed(db: any, opts: { dg: string; uuid: string; withChunk?: boolean; withMem?: boolean }): void {
  db.run("INSERT INTO entities (uuid, name, type) VALUES (?,?,?)", [opts.uuid, '守卫测试实体', 'person']);
  for (const [role, content, seq] of [['user', '你好', 1], ['assistant', '在的', 2]] as const) {
    db.run(
      "INSERT INTO conversations (role,content,timestamp,seq_pos,topic,calcium_score,dna_root_id,dialog_group_id,dialog_round,is_test,belong_entity_uuid) " +
      "VALUES (?,?,?,?,?,?,?,?,?,0,?)",
      [role, content, TS, seq, '守卫话题', 0.6, 'DNAX', opts.dg, 1, opts.uuid],
    );
  }
  // 注：strength_updated_at 在 schema.sql 里是 NOT NULL，必须显式给值
  const seedMemory = (id: string, seq: number, text: string, zone: string, kind: string): void => {
    db.run(
      "INSERT INTO memories (id,seq_pos,created_at,calcium_score,calcium_level,locus_path,leaf_zone,raw_input," +
      "strength_updated_at,dialog_group_id,belong_entity_uuid,memory_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, seq, TS, 0.6, 2, 'guard.locus', zone, text, TS, opts.dg, opts.uuid, kind],
    );
  };
  seedMemory(opts.dg + '_ANCHOR', 1, '旧锚点原文', 'language_semantic_zone', 'roleplay');
  if (opts.withChunk) seedMemory(opts.dg + '_CHUNK_001', 2, '退役前残留碎片', 'language_semantic_zone', 'episodic');
  if (opts.withMem) seedMemory('mem_guard_001', 3, '逐轮砂金行', 'assistant', 'roleplay');
}

const count = (db: any, sql: string): number => Number(q(db, sql)[0]?.c ?? 0);

describe('[ADR-010 P1-A] 启动重建不变量 —— dialog_groups 不得被触碰', () => {
  it('★ 核心：重建前后 dialog_groups 的块级元数据逐字段不变', async () => {
    const db = await buildDb();
    seed(db, { dg: 'DGGUARD1', uuid: 'TXS-000090101' });
    db.run(
      "INSERT INTO dialog_groups (dialog_group_id,belong_entity_uuid,narrative_tag,primary_emotion," +
      "block_calcium_score,scene_anchor_hash,emotion_curve,block_close_reason,block_summary," +
      "lifecycle_state,is_landmark,turn_count,first_ts,last_ts,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ['DGGUARD1', 'TXS-000090101', 'relational', '愉快', 6.5, 'HASH-ABC',
       '[0.1,0.4,0.9]', 'idle_timeout', '块摘要示例', 'active', 1, 3, TS, TS, TS],
    );

    const before = q(db, "SELECT * FROM dialog_groups WHERE dialog_group_id='DGGUARD1'")[0];
    expect(before, '前置：块行必须已写入').toBeTruthy();

    makeAdapter(db)._rebuildMemoryAnchors();

    const after = q(db, "SELECT * FROM dialog_groups WHERE dialog_group_id='DGGUARD1'")[0];
    expect(after, '🔴 启动重建把 dialog_groups 行删了 —— 块级元数据载体失效').toBeTruthy();
    expect(after, '块级元数据必须逐字段不变（重建不得覆盖真源）').toEqual(before);
    // 显式点名几个关键字段，让失败信息可读
    expect(after.block_calcium_score).toBe(6.5);
    expect(after.scene_anchor_hash).toBe('HASH-ABC');
    expect(after.emotion_curve).toBe('[0.1,0.4,0.9]');
    expect(after.block_close_reason).toBe('idle_timeout');
    expect(after.is_landmark).toBe(1);
  });

  it('★ CHUNK 残留被清除，而 mem_* 逐轮行与 ANCHOR 不得被误伤', async () => {
    const db = await buildDb();
    seed(db, { dg: 'DGGUARD2', uuid: 'TXS-000090102', withChunk: true, withMem: true });

    expect(count(db, "SELECT COUNT(*) c FROM memories WHERE id LIKE '%\\_CHUNK%' ESCAPE '\\'"), '前置：残留碎片应已播种').toBe(1);

    makeAdapter(db)._rebuildMemoryAnchors();

    expect(
      count(db, "SELECT COUNT(*) c FROM memories WHERE id LIKE '%\\_CHUNK%' ESCAPE '\\'"),
      'CHUNK 生产者已退役 ⇒ 启动清理后不得有残留',
    ).toBe(0);
    expect(
      count(db, "SELECT COUNT(*) c FROM memories WHERE id = 'mem_guard_001'"),
      '🔴 逐轮砂金行被误伤 —— DELETE 的 LIKE 转义写错会连带删除 (mem_ 与 _CHUNK 无关)',
    ).toBe(1);
    expect(
      count(db, "SELECT COUNT(*) c FROM memories WHERE id = 'DGGUARD2_ANCHOR'"),
      'ANCHOR 重建必须照常进行（它有真实消费者：MemoryRetriever 通用检索）',
    ).toBe(1);
  });

  it('★ 归属不翻转：重建前后 belong_entity_uuid 仍是同位实体', async () => {
    const db = await buildDb();
    seed(db, { dg: 'DGGUARD3', uuid: 'TXS-000090103', withChunk: true, withMem: true });

    makeAdapter(db)._rebuildMemoryAnchors();

    // 归属是当前唯一承担角色隔离的判据（ADR-010 D4）—— 它翻转 = 跨角色记忆泄漏。
    const anchor = q(db, "SELECT belong_entity_uuid u FROM memories WHERE id='DGGUARD3_ANCHOR'")[0];
    expect(anchor?.u, '🔴 重建把锚点的归属换掉了 —— 隔离判据失效').toBe('TXS-000090103');
    const mem = q(db, "SELECT belong_entity_uuid u FROM memories WHERE id='mem_guard_001'")[0];
    expect(mem?.u).toBe('TXS-000090103');
    const conv = q(db, "SELECT COUNT(*) c FROM conversations WHERE belong_entity_uuid='TXS-000090103'")[0];
    expect(Number(conv.c), 'conversations 原文层不得被启动重建触碰').toBe(2);
  });
});

describe('[ADR-010 P1-A] v16 迁移 —— dialog_groups 建表', () => {
  it('迁移后表与 4 个索引齐备，且归属列为 NOT NULL（户籍法：无户口不得写入）', async () => {
    const db = await buildDb();

    expect(count(db, "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='dialog_groups'")).toBe(1);
    for (const idx of ['idx_dg_belong', 'idx_dg_state', 'idx_dg_landmark', 'idx_dg_hash']) {
      expect(
        count(db, `SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='${idx}'`),
        `索引缺失: ${idx}`,
      ).toBe(1);
    }
    const cols = q(db, 'PRAGMA table_info(dialog_groups)');
    const belong = cols.find((c: any) => c.name === 'belong_entity_uuid');
    expect(belong?.notnull, '🔴 belong_entity_uuid 必须 NOT NULL（户籍法第七条）').toBe(1);

    // 刻意不含的字段（ADR-010 §7）——防止日后被「顺手加回来」
    const names = cols.map((c: any) => c.name);
    expect(names, 'virtual_world_ts 当前无生产者，不得预先建空字段').not.toContain('virtual_world_ts');
    expect(names, '组是 1:N，单数外键语义错误').not.toContain('conversation_id');

    // 幂等：再跑一次不抛错、不重复建
    expect(() => migrateSchema(db)).not.toThrow();
    expect(count(db, "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='dialog_groups'")).toBe(1);
  });
});

describe('[ADR-010 P1-A] 源码守卫 —— 防 CHUNK 生产者被重新引入', () => {
  const codeOf = (p: string) =>
    readFileSync(join(process.cwd(), p), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

  it('dialog-group-stage 不得再写入 *_CHUNK_* 行', () => {
    const src = codeOf('src/webui/chat/dialog-group-stage.ts');
    expect(src, '🔴 CHUNK 写入被重新引入 —— 该层无消费者且内容与 conversations/mem_* 重复').not.toMatch(/_CHUNK_/);
    expect(src, 'CHUNK 的拼接文本构造符也不应残留').not.toMatch(/chunkText/);
  });

  it('SQLiteAdapter 的重建函数不得出现对 dialog_groups 的 DELETE / INSERT', () => {
    const src = codeOf('src/m2/SQLiteAdapter.ts');
    expect(src, '🔴 启动重建不得删除块级元数据真源').not.toMatch(/DELETE\s+FROM\s+dialog_groups/i);
    expect(src, '🔴 启动重建不得写入块级元数据真源（会覆盖运行期产物）').not.toMatch(/INSERT\s+(OR\s+\w+\s+)?INTO\s+dialog_groups/i);
  });
});
