/**
 * step2-inspect-old-db.js — 探查旧库 schema 和行数
 */
const Database = require('better-sqlite3');

const OLD_DB = 'D:/tools/wenstar-cc/data/webui/fusion_memory.db';
const db = new Database(OLD_DB, { readonly: true });

console.log('=== 旧库探查 ===');
console.log('路径:', OLD_DB);

// 所有表
const tables = db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
`).all();
console.log(`\n共 ${tables.length} 张表:`);

for (const t of tables) {
  try {
    const count = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c;
    const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all().map(c => c.name);
    console.log(`  ${t.name.padEnd(30)} ${String(count).padStart(8)} 行  列: ${cols.slice(0,8).join(',')}${cols.length>8?'...':''}`);
  } catch (e) {
    console.log(`  ${t.name.padEnd(30)} ERROR: ${e.message.slice(0,50)}`);
  }
}

// 特别看 conversations / memories 相关表的前几行
console.log('\n=== 抽样：找最像 conversations / memories 的表 ===');
for (const t of tables) {
  if (/conversation|message|chat|dialog/i.test(t.name)) {
    const row = db.prepare(`SELECT * FROM "${t.name}" LIMIT 1`).get();
    if (row) console.log(`\n[${t.name}] 样本:`, JSON.stringify(row).slice(0, 300));
  }
}

db.close();
