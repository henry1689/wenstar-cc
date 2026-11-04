/**
 * step2c-namespace-distribution.js — 看旧库 roleplay_char / namespace 分布
 */
const Database = require('better-sqlite3');
const db = new Database('D:/tools/wenstar-cc/data/webui/fusion_memory.db', { readonly: true });

console.log('=== conversations.namespace 分布 ===');
console.log(db.prepare(`
  SELECT COALESCE(namespace,'(null)') ns, COUNT(*) c
  FROM conversations GROUP BY namespace ORDER BY c DESC
`).all());

console.log('\n=== conversations.roleplay_char 分布 ===');
console.log(db.prepare(`
  SELECT COALESCE(roleplay_char,'(null)') ch, COUNT(*) c
  FROM conversations GROUP BY roleplay_char ORDER BY c DESC LIMIT 20
`).all());

console.log('\n=== conversations.namespace × roleplay_char 交叉 ===');
console.log(db.prepare(`
  SELECT COALESCE(namespace,'(null)') ns, COALESCE(roleplay_char,'(null)') ch, COUNT(*) c
  FROM conversations GROUP BY namespace, roleplay_char ORDER BY c DESC LIMIT 20
`).all());

console.log('\n=== memories.namespace 分布 ===');
console.log(db.prepare(`
  SELECT COALESCE(namespace,'(null)') ns, COUNT(*) c
  FROM memories GROUP BY namespace ORDER BY c DESC
`).all());

console.log('\n=== memories.belong_entity_uuid 分布 top10 ===');
console.log(db.prepare(`
  SELECT COALESCE(belong_entity_uuid,'(null)') e, COUNT(*) c
  FROM memories GROUP BY belong_entity_uuid ORDER BY c DESC LIMIT 10
`).all());

db.close();
