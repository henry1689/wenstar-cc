/**
 * step2b-inspect-columns.js — 详细看 conversations/memories 列和角色分布
 */
const Database = require('better-sqlite3');
const db = new Database('D:/tools/wenstar-cc/data/webui/fusion_memory.db', { readonly: true });

console.log('=== conversations 完整列 ===');
console.log(db.prepare(`PRAGMA table_info(conversations)`).all().map(c => c.name).join(', '));

console.log('\n=== memories 完整列 ===');
console.log(db.prepare(`PRAGMA table_info(memories)`).all().map(c => c.name).join(', '));

console.log('\n=== conversations 角色分布（role） ===');
console.log(db.prepare(`SELECT role, COUNT(*) c FROM conversations GROUP BY role`).all());

console.log('\n=== conversations 按 dna_root_id 前缀分组（推断角色） ===');
const rows = db.prepare(`
  SELECT substr(dna_root_id, 1, 18) as prefix, COUNT(*) c
  FROM conversations GROUP BY prefix ORDER BY c DESC LIMIT 10
`).all();
console.log(rows);

console.log('\n=== conversations 按 dialog_group_id 前缀分组 ===');
const rows2 = db.prepare(`
  SELECT substr(dialog_group_id, 1, 20) as prefix, COUNT(*) c
  FROM conversations WHERE dialog_group_id IS NOT NULL
  GROUP BY prefix ORDER BY c DESC LIMIT 10
`).all();
console.log(rows2);

console.log('\n=== memories 样本 1 条 ===');
console.log(JSON.stringify(db.prepare(`SELECT * FROM memories LIMIT 1`).get(), null, 2).slice(0, 800));

console.log('\n=== memories.calcium_level 分布 ===');
console.log(db.prepare(`SELECT calcium_level, COUNT(*) c FROM memories GROUP BY calcium_level ORDER BY calcium_level`).all());

console.log('\n=== conversations 最早/最晚时间 ===');
console.log(db.prepare(`SELECT MIN(timestamp) min, MAX(timestamp) max FROM conversations`).get());

db.close();
