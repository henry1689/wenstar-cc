const db = require('better-sqlite3')('D:/tools/wenstar-cc/data/memarch-v2.db');
try {
  db.prepare(`INSERT INTO conversations (message_id, namespace, role, content, ts_utc, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('test-001', 'ns_yuyao', 'user', 'test content', Date.now(), Date.now());
  console.log('insert ok');
  console.log('count:', db.prepare('SELECT COUNT(*) c FROM conversations').get());
  db.prepare(`DELETE FROM conversations WHERE message_id = 'test-001'`).run();
  console.log('cleanup ok');
} catch(e) { console.error('insert failed:', e.message); }
