/**
 * Step 2: 构造旧库状态 → M00 快照 → M01-M05 up 迁移
 * 输出每步审计账本内容
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, '..', 'migrations');
const DB = 'D:/tools/wenstar-cc/data/memarch_acceptance_test.db';

const db = new Database(DB);
db.pragma('foreign_keys = ON');

console.log('='.repeat(70));
console.log('[Step 2.0] 构造旧库"待迁移"状态（20 条样例数据）');
console.log('='.repeat(70));

// 旧 conversations：timestamp 为 ISO 字符串（未填 ts_utc）
const insertConv = db.prepare(`
  INSERT INTO conversations(message_id, namespace, role, content, timestamp, is_summary, is_compacted, created_at)
  VALUES (?, 'default', 'user', ?, ?, ?, ?, ?)
`);
const convSamples = [
  ['legacy-001', '深圳湾散步',       '2026-11-01 09:00:00', 0, 0, 1730000001000],
  ['legacy-002', '喝咖啡习惯',       '2026-11-01 10:00:00', 0, 0, 1730000002000],
  ['legacy-003', '压缩产物-误标摘要', '2026-11-01 11:00:00', 1, 1, 1730000003000],  // M2 误标
  ['legacy-004', '压缩产物-误标摘要2','2026-11-01 11:30:00', 1, 1, 1730000004000],  // M2 误标
  ['legacy-005', '真正的摘要',       '2026-11-01 12:00:00', 1, 0, 1730000005000],  // 真摘要，保留
];
for (const s of convSamples) insertConv.run(...s);

// 旧 memories：calcium_score 三量纲混合 + recall_count + last_recalled_at 本地时间
const insertMem = db.prepare(`
  INSERT INTO memories(id, namespace, summary, calcium_score, recall_count, last_recalled_at, created_at)
  VALUES (?, 'default', ?, ?, ?, ?, ?)
`);
const memSamples = [
  ['mem-legacy-01', '0-1量纲', 0.5, 3, '2026-11-01 20:00:00', 1730000001000],
  ['mem-legacy-02', '1-5量纲', 3.0, 5, '2026-11-01 21:00:00', 1730000002000],
  ['mem-legacy-03', '5-10量纲', 7.0, 8, '2026-11-01 22:00:00', 1730000003000],
  ['mem-legacy-04', '有salience', null, 2, '2026-11-01 23:00:00', 1730000004000],
  ['mem-legacy-05', '歧义行',      99, 0, null,                 1730000005000],
];
for (const s of memSamples) insertMem.run(...s);
// 给 mem-legacy-04 补 salience（M3 首选分支）
db.prepare(`UPDATE memories SET salience=0.7 WHERE id='mem-legacy-04'`).run();

// 旧 black_diamond 表（M5 迁移用）
db.exec(`
  CREATE TABLE IF NOT EXISTS black_diamond (
    id INTEGER PRIMARY KEY,
    trace_id TEXT,
    episode_id TEXT,
    title TEXT,
    reason TEXT,
    created_at INTEGER
  );
  INSERT INTO black_diamond(trace_id, title, reason, created_at) VALUES
    ('mem-legacy-01', '用户自我定义核心', 'auto_promote', 1730000001000),
    ('mem-legacy-02', '重要关系',         'auto_promote', 1730000002000);
`);

console.log(`  插入 conversations: ${convSamples.length} 条（含 2 条 M2 误标）`);
console.log(`  插入 memories:     ${memSamples.length} 条（覆盖 0-1/1-5/5-10/有salience/歧义 5 种分支）`);
console.log(`  插入旧 black_diamond: 2 条`);

// ---- 跑迁移 ----
const migrations = [
  'M00_baseline_snapshot.sql',
  'M01_timestamp_unify.up.sql',
  'M02_is_summary_fix.up.sql',
  'M03_calcium_normalize.up.sql',
  'M04_activation_backfill.up.sql',
  'M05_black_diamond_migrate.up.sql',
];

console.log('');
console.log('='.repeat(70));
console.log('[Step 2.1] 顺序执行 M00-M05 up');
console.log('='.repeat(70));

for (const m of migrations) {
  const t0 = Date.now();
  try {
    const sql = readFileSync(join(MIG_DIR, m), 'utf-8');
    db.exec(sql);
    console.log(`  ✅ ${m.padEnd(38)} (${Date.now() - t0}ms)`);
  } catch (err) {
    console.log(`  ❌ ${m}: ${err.message.split('\n')[0]}`);
  }
}

// ---- 输出审计账本 ----
console.log('');
console.log('='.repeat(70));
console.log('[Step 2.2] audit_ledger 审计账本（哈希链）');
console.log('='.repeat(70));
const ledger = db.prepare(`SELECT seq, actor, action, target_id, meta FROM audit_ledger ORDER BY seq`).all();
for (const r of ledger) {
  console.log(`  #${r.seq} [${r.actor}] ${r.action} ${r.target_id}`);
  if (r.meta) console.log(`       meta: ${r.meta}`);
}

// ---- 验证迁移结果 ----
console.log('');
console.log('='.repeat(70));
console.log('[Step 2.3] 迁移结果抽样验证');
console.log('='.repeat(70));

// M1: ts_utc 是否回填
const m1 = db.prepare(`SELECT message_id, timestamp, ts_utc FROM conversations WHERE message_id LIKE 'legacy-%'`).all();
console.log('  M1 时间戳统一:');
for (const r of m1) console.log(`    ${r.message_id}: ${r.timestamp} → ts_utc=${r.ts_utc}`);

// M2: 误标是否修复
const m2bad = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE message_id='legacy-003' AND is_summary=0`).get();
const m2real = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE message_id='legacy-005' AND is_summary=1`).get();
console.log(`  M2 is_summary 误标修复: legacy-003 is_summary=${m2bad.c===1?0:'?'}（应为0），legacy-005 is_summary=${m2real.c===1?1:'?'}（真摘要保留=1）`);

// M3: consolidation 是否在 [0,1]
const m3 = db.prepare(`SELECT id, calcium_score, calcium_legacy, consolidation, migration_ambiguous FROM memories WHERE id LIKE 'mem-legacy-%'`).all();
console.log('  M3 钙化分归一:');
for (const r of m3) {
  console.log(`    ${r.id}: calcium_score=${r.calcium_score} legacy=${r.calcium_legacy} → consolidation=${r.consolidation?.toFixed(3)} ambiguous=${r.migration_ambiguous}`);
}

// M4: n_refs 回填
const m4 = db.prepare(`SELECT id, recall_count, n_refs, recent_refs FROM memories WHERE id LIKE 'mem-legacy-%'`).all();
console.log('  M4 激活历史回填:');
for (const r of m4) {
  console.log(`    ${r.id}: recall_count=${r.recall_count} → n_refs=${r.n_refs}, recent_refs=${r.recent_refs}`);
}

// M5: 黑钻指针
const m5 = db.prepare(`SELECT id, ref_type, ref_id, title FROM black_diamond_v2`).all();
console.log('  M5 黑钻指针表:');
for (const r of m5) console.log(`    ${r.id}: ${r.ref_type} → ${r.ref_id} (${r.title})`);

db.close();
console.log('\n[Step 2 完成] 迁移 up 路径执行完毕');
