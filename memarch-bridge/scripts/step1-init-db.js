/**
 * step1-init-db.js — M1 DDL 建库（纯 JS 版，避免 ts-node 依赖）
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DDL_DIR = 'D:/tools/wenstar-cc/memarch-v2/storage/ddl';
const DB_PATH = 'D:/tools/wenstar-cc/data/memarch-v2.db';

console.log('=== Step 1: M1 DDL 建库 ===');
console.log('目标库:', DB_PATH);

const db = new Database(DB_PATH);

const files = [
  '01_schema_init.sql',
  '02_indexes.sql',
  '03_fts5.sql',
  '04_vector_index.sql',
  '05_views.sql',
];

for (const f of files) {
  const sql = fs.readFileSync(path.join(DDL_DIR, f), 'utf-8');
  try {
    db.exec(sql);
    console.log(`  ✓ ${f} OK`);
  } catch (e) {
    if (f === '04_vector_index.sql') {
      console.log(`  ⚠ ${f} 跳过（vec0 扩展未加载，不阻塞主流程）`);
    } else {
      console.error(`  ✗ ${f} 失败:`, e.message);
      process.exit(1);
    }
  }
}

// bridge 辅助表
db.exec(`
  CREATE TABLE IF NOT EXISTS namespace_registry (
    namespace TEXT PRIMARY KEY,
    roleplay_name TEXT NOT NULL,
    role_uuid TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS migration_checkpoint (
    old_table TEXT NOT NULL,
    old_pk TEXT NOT NULL,
    new_pk TEXT NOT NULL,
    namespace TEXT NOT NULL,
    migrated_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY (old_table, old_pk)
  );
`);
console.log('  ✓ bridge 辅助表 OK');

const tables = db.prepare(`
  SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name
`).all();
console.log(`\n建库完成，共 ${tables.length} 个表/视图:`);
for (const t of tables) console.log('  -', t.name);

// 注册玉瑶
const now = Date.now();
db.prepare(`
  INSERT OR IGNORE INTO namespace_registry (namespace, roleplay_name, role_uuid, created_at, note)
  VALUES (?, ?, ?, ?, ?)
`).run('ns_yuyao', '玉瑶', 'role-yuyao-001', now, '灰度首发角色');
console.log('\n已注册玉瑶 namespace: ns_yuyao');

db.close();
console.log('\n✅ Step 1 完成');
