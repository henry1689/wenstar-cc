const { buildTestDb } = require('../dist/__tests__/helpers/db_factory.js');
const db = buildTestDb({ n_memories: 100 });

// 直接查 v_mem_real
const v = db.prepare("SELECT id FROM v_mem_real LIMIT 3").all();
console.log('v_mem_real sample:', v);

// 直接 JOIN 查
const j = db.prepare(`
  SELECT m.id, fts_memories.trace_id
  FROM fts_memories
  JOIN v_mem_real m ON m.id = fts_memories.trace_id
  WHERE fts_memories MATCH 'motor'
  LIMIT 5
`).all();
console.log('join result:', j);

// 检查 fts_memories.trace_id 格式
const t = db.prepare("SELECT trace_id FROM fts_memories LIMIT 3").all();
console.log('trace_ids:', t);

const m = db.prepare("SELECT id FROM memories LIMIT 3").all();
console.log('mem ids:', m);
