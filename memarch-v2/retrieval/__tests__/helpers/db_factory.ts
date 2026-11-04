// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / __tests__/helpers/db_factory.ts
// In-memory SQLite factory for tests/bench.
// =====================================================================

import Database from 'better-sqlite3';

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE,
  namespace TEXT NOT NULL DEFAULT 'default',
  roleplay_char TEXT,
  ts_utc INTEGER,
  role TEXT,
  content TEXT NOT NULL,
  is_summary INTEGER DEFAULT 0,
  episode_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'fresh',
  sensitivity INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  gist TEXT,
  participants TEXT,
  salience REAL,
  consolidation REAL DEFAULT 0,
  is_landmark INTEGER DEFAULT 0,
  lifecycle_state TEXT DEFAULT 'fresh'
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  raw_input TEXT,
  summary TEXT,
  consolidation REAL DEFAULT 0,
  n_refs INTEGER DEFAULT 1,
  first_ref_at INTEGER,
  last_reinforced_at INTEGER,
  salience REAL,
  importance REAL,
  arousal REAL,
  novelty REAL,
  self_relevance REAL,
  activation_cache REAL,
  lifecycle_state TEXT DEFAULT 'fresh',
  episode_id TEXT,
  version INTEGER DEFAULT 1,
  suppressed INTEGER DEFAULT 0,
  sensitivity INTEGER DEFAULT 0,
  exposures_7d INTEGER DEFAULT 0,
  recall_count INTEGER DEFAULT 0,
  is_landmark INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_facts (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL CHECK (domain IN ('fg','dossier','kb','relation','preference')),
  subject_uuid TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_text TEXT,
  object_uuid TEXT,
  valid_from INTEGER,
  valid_to INTEGER,
  recorded_at INTEGER NOT NULL,
  invalidated_at INTEGER,
  confidence REAL DEFAULT 0.7,
  source_ids TEXT NOT NULL,
  sensitivity INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entity_edges (
  src_uuid TEXT NOT NULL,
  dst_uuid TEXT NOT NULL,
  rel TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  trace_id TEXT,
  updated_at INTEGER,
  PRIMARY KEY (src_uuid, dst_uuid, rel, trace_id)
);

CREATE TABLE IF NOT EXISTS trace_entities (
  trace_id TEXT NOT NULL,
  entity_uuid TEXT NOT NULL,
  PRIMARY KEY (trace_id, entity_uuid)
);

CREATE TABLE IF NOT EXISTS black_diamond_v2 (
  id TEXT PRIMARY KEY,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('episode','trace','fact')),
  ref_id TEXT NOT NULL,
  title TEXT,
  entry_channel TEXT NOT NULL CHECK (entry_channel IN ('auto','manual','user_confirmed')),
  entry_reason TEXT,
  self_defining REAL,
  user_confirmed INTEGER DEFAULT 0,
  snapshot_hash TEXT,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prospective_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('promise','reminder','plan','anniversary')),
  content TEXT,
  owner TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('time','event','entity')),
  due_at INTEGER,
  trigger_entity TEXT,
  status TEXT DEFAULT 'pending',
  source_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE VIEW IF NOT EXISTS v_conv_real AS
  SELECT * FROM conversations
  WHERE COALESCE(namespace,'default')='default'
    AND (roleplay_char IS NULL OR roleplay_char='')
    AND COALESCE(lifecycle_state,'fresh') NOT IN ('tombstone','purged');

CREATE VIEW IF NOT EXISTS v_mem_real AS
  SELECT * FROM memories
  WHERE COALESCE(namespace,'default')='default'
    AND lifecycle_state NOT IN ('tombstone','purged')
    AND suppressed = 0;

CREATE VIEW IF NOT EXISTS v_ep_real AS
  SELECT * FROM episodes
  WHERE COALESCE(namespace,'default')='default'
    AND lifecycle_state NOT IN ('tombstone','purged');

CREATE VIEW IF NOT EXISTS v_fact_real AS
  SELECT * FROM semantic_facts
  WHERE COALESCE(sensitivity,0) < 2
    AND (valid_to IS NULL OR valid_to > strftime('%s','now')*1000);

CREATE VIEW IF NOT EXISTS v_bd_active AS
  SELECT * FROM black_diamond_v2 WHERE status='active';

-- M4 self-owned FTS index on memories (not external content; stores trace_id explicitly)
CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(
  trace_id UNINDEXED,
  raw_input,
  summary,
  tokenize='trigram'
);
`;

const TOPICS = [
  'motor stator winding insulation varnish process',
  'customer inquiry Deheng motor delivery',
  'morning workout machine squat knee medial pain',
  'Lexus NA engine commuting fuel economy',
  'WenStar OS memory UUID calcium storage',
  'tai chi balance training all-cause mortality',
  'protein powder multivitamin supplement strategy',
  'intermittent fasting calorie restriction lifespan',
  'babbling reduplication tone experiment',
  'customer complaint bearing noise replacement',
  'weekend mountain hike Screen Lake',
  'PWA offline cache Service Worker strategy',
  'TypeScript strict mode type narrowing',
  'better-sqlite3 FTS5 trigram tokenizer',
  'sqlite-vec vec0 vector extension load',
];

const ENTITIES = [
  'ent:deheng-motor', 'ent:customer-A', 'ent:knee-medial', 'ent:lexus-250',
  'ent:wenstar-os', 'ent:taichi', 'ent:protein-powder', 'ent:if-16-8',
  'ent:bearing-noise', 'ent:screen', 'ent:sw-cache',
];

export interface DbFactoryOptions {
  n_memories?: number;
  n_facts?: number;
  n_blackdiamond?: number;
  n_prospective?: number;
  now?: number;
}

export function buildTestDb(opts: DbFactoryOptions = {}): Database.Database {
  const {
    n_memories = 1000,
    n_facts = 50,
    n_blackdiamond = 10,
    n_prospective = 5,
    now = Date.now(),
  } = opts;

  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);

  const DAY = 24 * 3600 * 1000;

  const insertMem = db.prepare(`
    INSERT INTO memories (
      id, namespace, raw_input, summary, consolidation, activation_cache,
      salience, importance, arousal, novelty, self_relevance,
      lifecycle_state, episode_id, created_at, last_reinforced_at,
      is_landmark, recall_count, exposures_7d
    ) VALUES (
      @id, 'default', @raw_input, @summary, @consolidation, @activation_cache,
      @salience, @importance, @arousal, @novelty, @self_relevance,
      'fresh', @episode_id, @created_at, @last_reinforced_at,
      @is_landmark, @recall_count, @exposures_7d
    )
  `);

  const insertTE = db.prepare(`INSERT OR IGNORE INTO trace_entities (trace_id, entity_uuid) VALUES (?, ?)`);
  const insertFts = db.prepare(`INSERT INTO fts_memories(trace_id, raw_input, summary) VALUES (?, ?, ?)`);

  const tx = db.transaction(() => {
    for (let i = 0; i < n_memories; i++) {
      const id = `mem-${String(i).padStart(6, '0')}`;
      const topic = TOPICS[i % TOPICS.length];
      const recency = Math.random() * 180;
      const created = now - recency * DAY;
      const consolidation = Math.random();
      const activation = Math.random();
      const rawInput = `${topic} #${i} details: parameter tuning and customer feedback, process improvement and cost accounting.`;
      const summary = `${topic} (summary)`;
      insertMem.run({
        id,
        raw_input: rawInput,
        summary,
        consolidation,
        activation_cache: activation,
        salience: Math.random(),
        importance: Math.random(),
        arousal: Math.random(),
        novelty: Math.random(),
        self_relevance: Math.random(),
        episode_id: `ep-${i % 50}`,
        created_at: created,
        last_reinforced_at: created + Math.random() * 30 * DAY,
        is_landmark: i % 100 === 0 ? 1 : 0,
        recall_count: Math.floor(Math.random() * 10),
        exposures_7d: Math.floor(Math.random() * 5),
      });
      insertFts.run(id, rawInput, summary);
      const entCount = 1 + Math.floor(Math.random() * 2);
      for (let k = 0; k < entCount; k++) {
        insertTE.run(id, ENTITIES[Math.floor(Math.random() * ENTITIES.length)]);
      }
    }

    const insertFact = db.prepare(`
      INSERT INTO semantic_facts (
        id, domain, subject_uuid, predicate, object_text,
        valid_from, valid_to, recorded_at, confidence, source_ids, sensitivity
      ) VALUES (
        @id, @domain, @subject_uuid, @predicate, @object_text,
        @valid_from, NULL, @recorded_at, @confidence, '[]', 0
      )
    `);
    const domains: Array<'dossier' | 'preference' | 'kb'> = ['dossier', 'preference', 'kb'];
    for (let i = 0; i < n_facts; i++) {
      const domain = domains[i % 3];
      insertFact.run({
        id: `fact-${i}`,
        domain,
        subject_uuid: `ent:user-${i % 5}`,
        predicate: ['likes', 'lives_in', 'works_at', 'knows'][i % 4],
        object_text: `${TOPICS[i % TOPICS.length]} (fact entry ${i})`,
        valid_from: now - 30 * DAY,
        recorded_at: now - Math.random() * 60 * DAY,
        confidence: 0.5 + Math.random() * 0.5,
      });
    }

    const insertEdge = db.prepare(`
      INSERT OR IGNORE INTO entity_edges (src_uuid, dst_uuid, rel, weight, trace_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < 200; i++) {
      const s = ENTITIES[Math.floor(Math.random() * ENTITIES.length)];
      const d = ENTITIES[Math.floor(Math.random() * ENTITIES.length)];
      if (s !== d) insertEdge.run(s, d, 'rel', 1.0, `edge-${i}`, now);
    }

    const insertBD = db.prepare(`
      INSERT INTO black_diamond_v2 (id, ref_type, ref_id, title, entry_channel, self_defining, status, created_at)
      VALUES (?, 'trace', ?, ?, 'auto', ?, 'active', ?)
    `);
    const updHigh = db.prepare(`UPDATE memories SET consolidation=0.85, activation_cache=0.8 WHERE id=?`);
    for (let i = 0; i < n_blackdiamond; i++) {
      const id = `mem-${String(i * 137).padStart(6, '0')}`;
      updHigh.run(id);
      insertBD.run(`bd-${i}`, id, `landmark-${i}`, 0.7 + Math.random() * 0.3, now);
    }

    const insertPros = db.prepare(`
      INSERT INTO prospective_items (id, kind, content, owner, trigger_type, due_at, status, created_at)
      VALUES (?, ?, ?, 'assistant', 'time', ?, 'pending', ?)
    `);
    for (let i = 0; i < n_prospective; i++) {
      insertPros.run(
        `pros-${i}`,
        ['reminder', 'plan', 'promise'][i % 3],
        `reminder item ${i}: follow up customer order ${i}`,
        now + (i + 1) * 2 * DAY,
        now
      );
    }
  });
  tx();

  return db;
}
