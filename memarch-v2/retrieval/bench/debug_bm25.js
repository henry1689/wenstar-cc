const Database = require('better-sqlite3');
const { buildTestDb } = require('../dist/__tests__/helpers/db_factory.js');
const { understandQuery } = require('../dist/query_understanding/index.js');
const { Bm25Recall } = require('../dist/recall/bm25.js');

const db = buildTestDb({ n_memories: 100 });
const q = understandQuery('motor stator winding insulation varnish customer inquiry');
console.log('q.time_range:', q.time_range);
console.log('q.raw_query:', q.raw_query);

const leg = new Bm25Recall(db);
leg.recall(q).then((out) => {
  console.log('bm25 out length:', out.length);
  console.log('first:', out[0]);
}).catch((e) => console.error('err:', e));
