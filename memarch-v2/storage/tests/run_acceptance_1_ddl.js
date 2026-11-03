/**
 * M1-Storage 验收执行脚本（业主裁决 better-sqlite3 后）
 * 步骤 1: 建测试库，顺序执行 01→05 DDL，输出表/索引/视图/触发器清单
 */
import Database from 'better-sqlite3';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DDL_DIR = join(__dirname, '..', 'ddl');
const TEST_DB = 'D:/tools/wenstar-cc/data/memarch_acceptance_test.db';

// 清理旧测试库
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  if (existsSync(f)) unlinkSync(f);
}

console.log('='.repeat(70));
console.log('[Step 1] 创建测试库:', TEST_DB);
console.log('='.repeat(70));

const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const ddlFiles = ['01_schema_init.sql', '02_indexes.sql', '03_fts5.sql', '04_vector_index.sql', '05_views.sql'];
for (const f of ddlFiles) {
  const t0 = Date.now();
  try {
    const sql = readFileSync(join(DDL_DIR, f), 'utf-8');
    db.exec(sql);
    console.log(`  ✅ ${f}  (${Date.now() - t0}ms)`);
  } catch (err) {
    console.log(`  ⚠️  ${f}  (${Date.now() - t0}ms): ${err.message.split('\n')[0]}`);
    if (f === '04_vector_index.sql') {
      console.log('     [预期] vec0 扩展未加载，vec0 虚表待业主放置 vec0.dll 后再建');
    }
  }
}

console.log('');
console.log('='.repeat(70));
console.log('[Step 1.1] 表清单（应为 14 张业务表 + 2 张系统表）');
console.log('='.repeat(70));
const tables = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='table' AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`).all();
for (const t of tables) console.log(`  - ${t.name}`);
console.log(`  共 ${tables.length} 张`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 1.2] 索引清单');
console.log('='.repeat(70));
const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
for (const i of idx) console.log(`  - ${i.name}`);
console.log(`  共 ${idx.length} 个`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 1.3] 视图清单');
console.log('='.repeat(70));
const views = db.prepare(`SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`).all();
for (const v of views) console.log(`  - ${v.name}`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 1.4] 触发器清单（审计账本 append-only + FTS 同步）');
console.log('='.repeat(70));
const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).all();
for (const t of triggers) console.log(`  - ${t.name}`);

// 关闭句柄，留给后续步骤
db.close();
console.log('\n[Step 1 完成] 测试库已就绪，后续迁移脚本将直接写入本库');
