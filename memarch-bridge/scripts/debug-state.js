const db = require('better-sqlite3')('D:/tools/wenstar-cc/data/memarch-v2.db', {readonly:true});
console.log('=== episodes sample ===');
console.log(db.prepare(`SELECT id, namespace, status, gist FROM episodes LIMIT 5`).all());
console.log('\n=== episodes count by ns ===');
console.log(db.prepare(`SELECT namespace, COUNT(*) c FROM episodes GROUP BY namespace`).all());
console.log('\n=== namespace_registry ===');
console.log(db.prepare(`SELECT * FROM namespace_registry`).all());
console.log('\n=== migration_checkpoint by table ===');
console.log(db.prepare(`SELECT old_table, COUNT(*) c FROM migration_checkpoint GROUP BY old_table`).all());
