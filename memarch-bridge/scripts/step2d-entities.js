/**
 * step2d-entities.js — 看 entities 表，TXS-xxx 对应哪些角色
 */
const Database = require('better-sqlite3');
const db = new Database('D:/tools/wenstar-cc/data/webui/fusion_memory.db', { readonly: true });

console.log('=== entities 表样本 ===');
console.log(db.prepare(`PRAGMA table_info(entities)`).all().map(c=>c.name).join(', '));

console.log('\n=== entities top 20 ===');
console.log(db.prepare(`SELECT * FROM entities ORDER BY rowid LIMIT 20`).all());

console.log('\n=== dialog_groups.belong_entity_uuid 分布 top10 ===');
console.log(db.prepare(`
  SELECT belong_entity_uuid, COUNT(*) c FROM dialog_groups
  GROUP BY belong_entity_uuid ORDER BY c DESC LIMIT 10
`).all());

db.close();
