/**
 * migrate-v2-graph — 把主库的实体关系与黑钻迁进 MemArch v2
 *
 * 为什么需要：
 *   v2 的 `entity_edges`（PPR 多跳联想的数据基础）与 `black_diamond_v2`
 *   （黑钻晋升的目标表）都是**零行**。没有数据，这两条召回腿永远返回空——
 *   不是慢，是没有。
 *
 * 用法：
 *   npx tsx scripts/migrate-v2-graph.ts                 # 增量（幂等，跳过已存在）
 *   npx tsx scripts/migrate-v2-graph.ts --dry-run       # 只统计不写
 *
 * 🔴 主库以 readonly 打开（sql.js 独占，delete journal），只读不写。
 * 🔴 幂等设计见两个 write 函数内的判定注释。
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const V2_DB = join(ROOT, 'data', 'memarch-v2.db');
const MAIN_DB = join(ROOT, 'data', 'webui', 'fusion_memory.db');
const DRY = process.argv.includes('--dry-run');

const log = (m: string): void => console.log(m);
const fmt = (n: number): string => n.toLocaleString('en-US');

/** ISO 字符串 / 数字 / null → epoch ms */
function toEpochMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

// ─────────────────────────────────────────────────────────────
// ① entity_relations (INTEGER id) → entity_edges (TEXT uuid)
// ─────────────────────────────────────────────────────────────
function migrateEdges(v2: Database.Database, main: Database.Database): void {
  // 主库用 INTEGER 主键，v2 用 uuid —— 必须先建 id→uuid 映射
  const uuidMap = new Map<number, string>();
  // 🔴 SQLite 里双引号是标识符，字符串字面量必须用单引号
  for (const r of main.prepare("SELECT id, uuid FROM entities WHERE uuid IS NOT NULL AND uuid <> ''").all() as Array<{ id: number; uuid: string }>) {
    uuidMap.set(r.id, r.uuid);
  }
  log(`\n[entity_edges] entities 映射表：${fmt(uuidMap.size)} 条带 uuid`);

  const rows = main.prepare('SELECT entity_a_id, entity_b_id, relation, strength, updated_at FROM entity_relations').all() as Array<{
    entity_a_id: number; entity_b_id: number; relation: string; strength: number | null; updated_at: string | null;
  }>;
  log(`[entity_edges] 主库关系：${fmt(rows.length)} 行`);

  // 幂等判定：主键含 trace_id，而 trace_id 为 NULL 时 SQLite 不视为重复，
  // 所以不能用 INSERT OR IGNORE 兜底 —— 必须显式查存在性（trace_id IS NULL 分支）。
  const exists = v2.prepare(
    'SELECT 1 FROM entity_edges WHERE src_uuid = ? AND dst_uuid = ? AND rel = ? AND trace_id IS NULL',
  );
  const ins = v2.prepare(
    'INSERT INTO entity_edges(src_uuid, dst_uuid, rel, weight, trace_id, updated_at) VALUES (?,?,?,?,NULL,?)',
  );

  const existing = (v2.prepare('SELECT COUNT(*) AS c FROM entity_edges').get() as { c: number }).c;
  log(`[entity_edges] v2 现有：${fmt(existing)} 行`);

  // 判定与写入分开：DRY-RUN 也要真实统计，否则报出来的数全是 0
  let skip = 0, bad = 0;
  const todo: Array<[string, string, string, number, number | null]> = [];
  for (const r of rows) {
    const a = uuidMap.get(r.entity_a_id);
    const b = uuidMap.get(r.entity_b_id);
    if (!a || !b || !r.relation) { bad++; continue; }
    if (existing > 0 && exists.get(a, b, r.relation)) { skip++; continue; }
    todo.push([a, b, r.relation, r.strength ?? 1.0, toEpochMs(r.updated_at)]);
  }

  if (DRY) {
    log(`[entity_edges] DRY-RUN：将写入 ${fmt(todo.length)}，跳过 ${fmt(skip)}，缺 uuid/relation ${fmt(bad)}`);
    return;
  }
  const tx = v2.transaction(() => {
    for (const [a, b, rel, w, ts] of todo) ins.run(a, b, rel, w, ts);
  });
  tx();
  log(`[entity_edges] ✅ 写入 ${fmt(todo.length)}，跳过 ${fmt(skip)}，缺映射 ${fmt(bad)}`);
}

// ─────────────────────────────────────────────────────────────
// ② black_diamond → black_diamond_v2
// ─────────────────────────────────────────────────────────────
function migrateDiamonds(v2: Database.Database, main: Database.Database): void {
  log('\n[black_diamond_v2] 开始');
  const rows = main.prepare(
    `SELECT id, source_id, summary, notes, entry_channel, entry_reason,
            stabilization_score, status, created_at
     FROM black_diamond`,
  ).all() as Array<{
    id: string; source_id: string | null; summary: string | null; notes: string | null;
    entry_channel: string | null; entry_reason: string | null;
    stabilization_score: number | null; status: string | null; created_at: string | null;
  }>;
  log(`[black_diamond_v2] 主库黑钻：${fmt(rows.length)} 行`);

  // v2 的 CHECK 只接受 episode/trace/fact 与 auto/manual/user_confirmed。
  // 主库的 'fg_sync'（FG 人物档案快照，254 行）不是记忆黑钻，迁进去会污染晋升体系。
  const CHANNEL_OK = new Set(['auto', 'manual', 'user_confirmed']);
  const STATUS_OK = new Set(['active', 'revoked']);

  const exists = v2.prepare('SELECT 1 FROM black_diamond_v2 WHERE id = ?');
  const ins = v2.prepare(
    `INSERT INTO black_diamond_v2
       (id, ref_type, ref_id, title, entry_channel, entry_reason, self_defining,
        user_confirmed, snapshot_hash, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,NULL,?,?)`,
  );

  let skip = 0, noSource = 0, badChannel = 0;
  const existing = (v2.prepare('SELECT COUNT(*) AS c FROM black_diamond_v2').get() as { c: number }).c;
  log(`[black_diamond_v2] v2 现有：${fmt(existing)} 行`);

  const todo: Array<[string, string, string, string, string | null, number | null, string, number]> = [];
  for (const r of rows) {
    if (!r.source_id) { noSource++; continue; }               // 无源记忆 → 无法建 ref，不进黑钻
    const ch = r.entry_channel || 'auto';
    if (!CHANNEL_OK.has(ch)) { badChannel++; continue; }      // fg_sync 等非记忆通道
    if (existing > 0 && exists.get(r.id)) { skip++; continue; }
    const st = r.status && STATUS_OK.has(r.status) ? r.status : 'active';
    todo.push([
      r.id,
      r.source_id,
      (r.summary || r.notes || '').slice(0, 80),   // title 只做展示，不承载内容
      ch,
      r.entry_reason ?? null,
      r.stabilization_score ?? null,
      st,
      toEpochMs(r.created_at) ?? Date.now(),
    ]);
  }

  if (DRY) {
    log(`[black_diamond_v2] DRY-RUN：将写入 ${fmt(todo.length)}，跳过 ${fmt(skip)}，无 source_id ${fmt(noSource)}，非记忆通道 ${fmt(badChannel)}`);
    return;
  }
  const tx = v2.transaction(() => {
    for (const [id, refId, title, ch, reason, sd, st, ts] of todo) {
      // user_confirmed 恒 0：迁移数据一律视为未经用户确认（§7.3 的确认必须是真实交互）
      ins.run(id, 'trace', refId, title, ch, reason, sd, 0, st, ts);
    }
  });
  tx();
  log(`[black_diamond_v2] ✅ 写入 ${fmt(todo.length)}，跳过 ${fmt(skip)}，无 source_id ${fmt(noSource)}，非记忆通道 ${fmt(badChannel)}`);
}

// ─────────────────────────────────────────────────────────────
// ③ memory_entities (INTEGER entity_id) → trace_entities (TEXT uuid)
// ─────────────────────────────────────────────────────────────
function migrateTraceEntities(v2: Database.Database, main: Database.Database): void {
  log('\n[trace_entities] 开始');
  const uuidMap = new Map<number, string>();
  for (const r of main.prepare("SELECT id, uuid FROM entities WHERE uuid IS NOT NULL AND uuid <> ''").all() as Array<{ id: number; uuid: string }>) {
    uuidMap.set(r.id, r.uuid);
  }
  const rows = main.prepare('SELECT memory_id, entity_id FROM memory_entities').all() as Array<{ memory_id: string; entity_id: number }>;
  log(`[trace_entities] 主库关联：${fmt(rows.length)} 行，uuid 可映射实体 ${fmt(uuidMap.size)} 个`);

  const existing = (v2.prepare('SELECT COUNT(*) AS c FROM trace_entities').get() as { c: number }).c;
  log(`[trace_entities] v2 现有：${fmt(existing)} 行`);

  const ins = v2.prepare('INSERT OR IGNORE INTO trace_entities(trace_id, entity_uuid) VALUES (?,?)');
  let bad = 0;
  const todo: Array<[string, string]> = [];
  for (const r of rows) {
    const u = uuidMap.get(r.entity_id);
    if (!u) { bad++; continue; }
    todo.push([r.memory_id, u]);
  }

  if (DRY) {
    log(`[trace_entities] DRY-RUN：将写入 ${fmt(todo.length)}，缺 uuid ${fmt(bad)}`);
    return;
  }
  const tx = v2.transaction(() => { for (const [t, u] of todo) ins.run(t, u); });
  tx();
  log(`[trace_entities] ✅ 写入/已存在 ${fmt(todo.length)}，缺 uuid ${fmt(bad)}`);
}

// ─────────────────────────────────────────────────────────────
function main(): void {
  if (!existsSync(V2_DB) || !existsSync(MAIN_DB)) {
    console.error('❌ 库文件缺失'); process.exit(1);
  }
  const v2 = new Database(V2_DB, { allowExtension: true });
  v2.pragma('busy_timeout = 30000');
  const main = new Database(MAIN_DB, { readonly: true });
  try {
    migrateEdges(v2, main);
    migrateDiamonds(v2, main);
    migrateTraceEntities(v2, main);
    log('\n=== 最终统计 ===');
    for (const t of ['entity_edges', 'black_diamond_v2', 'trace_entities']) {
      const c = (v2.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
      log(`  ${t}: ${fmt(c)}`);
    }
  } finally {
    main.close(); v2.close();
  }
}

main();
