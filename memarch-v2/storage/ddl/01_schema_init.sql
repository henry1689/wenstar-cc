-- =====================================================================
-- MemArch-v2.0.0 / M1-Storage / 01_schema_init.sql
-- 14 张表 DDL（SQLite 3.40+ 方言，含 FTS5 / vec0 假设）
-- 基线: MemArch-v2.0.0-Baseline (MD5: C3DCBFC83B96EBE88D06D230F26CF503)
-- 严格遵循主设计文档第二章数据模型，不自行扩展第十六章以外的接口
-- =====================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA encoding = 'UTF-8';

-- =====================================================================
-- T1 / L1 原文：conversations（改造，含 v2 新增列）
-- =====================================================================
CREATE TABLE IF NOT EXISTS conversations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id        TEXT UNIQUE,                 -- 业务幂等键
  namespace         TEXT NOT NULL DEFAULT 'default',  -- default / test / roleplay
  roleplay_char     TEXT,                        -- 角色扮演角色名（隔离用）
  timestamp         TEXT,                        -- 旧 ISO 时间字符串（迁移期保留）
  ts_utc            INTEGER,                     -- v2: 统一时间口径 epoch ms
  role              TEXT,                        -- user / assistant / system
  content           TEXT NOT NULL,
  is_summary        INTEGER DEFAULT 0,
  is_compacted      INTEGER DEFAULT 0,
  episode_id        TEXT,                        -- v2: 所属事件
  lifecycle_state   TEXT NOT NULL DEFAULT 'fresh'
                    CHECK (lifecycle_state IN ('fresh','raw_only','weakening','expiring','tombstone','purged')),
  sensitivity       INTEGER NOT NULL DEFAULT 0 CHECK (sensitivity IN (0,1,2)),
  created_at        INTEGER NOT NULL
);

-- =====================================================================
-- T2 / L2 事件：episodes（新建）
-- =====================================================================
CREATE TABLE IF NOT EXISTS episodes (
  id                TEXT PRIMARY KEY,
  namespace         TEXT NOT NULL DEFAULT 'default',
  started_at        INTEGER NOT NULL,            -- epoch ms
  ended_at          INTEGER,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','sealed')),
  gist              TEXT,                        -- 要点（睡眠期生成）
  gist_version      INTEGER DEFAULT 0,
  participants      TEXT,                        -- JSON: entity uuid[]
  arousal_peak      REAL,
  valence_mean      REAL,
  affect_curve      TEXT,                        -- JSON: [[ts, arousal, valence], ...]
  salience          REAL,
  consolidation     REAL DEFAULT 0 CHECK (consolidation BETWEEN 0 AND 1),
  is_landmark       INTEGER DEFAULT 0,
  lifecycle_state   TEXT DEFAULT 'fresh'
                    CHECK (lifecycle_state IN ('fresh','weakening','expiring','consolidated','tombstone','purged')),
  anchor_exempt     INTEGER DEFAULT 0,           -- A 层豁免
  raw_available     INTEGER DEFAULT 1,           -- 原文是否还在
  suppressed        INTEGER DEFAULT 0,
  sensitivity       INTEGER DEFAULT 0 CHECK (sensitivity IN (0,1,2)),
  dna_root_id       TEXT
);

-- =====================================================================
-- T3 / L3 痕迹：memories（改造，含 18 个 v2 新列）
-- =====================================================================
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  namespace         TEXT NOT NULL DEFAULT 'default',
  raw_input         TEXT,
  summary           TEXT,
  -- v2 巩固度与激活（统一量纲 [0,1]）
  consolidation     REAL DEFAULT 0 CHECK (consolidation BETWEEN 0 AND 1),
  n_refs            INTEGER DEFAULT 1,
  first_ref_at      INTEGER,
  recent_refs       TEXT,                        -- JSON: 最近 k=5 次强化时间戳
  last_reinforced_at INTEGER,
  distinct_recall_days INTEGER DEFAULT 0,
  last_recall_day   TEXT,                        -- 'YYYY-MM-DD'（本地日）
  sleep_cycles_survived INTEGER DEFAULT 0,
  -- 显著性五维
  salience          REAL,
  importance        REAL,                        -- LLM 打分 [0,1]
  arousal           REAL,
  novelty           REAL,
  self_relevance    REAL,
  activation_cache  REAL,                        -- 睡眠期刷新
  -- 生命周期与版本
  lifecycle_state   TEXT DEFAULT 'fresh'
                    CHECK (lifecycle_state IN ('fresh','weakening','expiring','consolidated','tombstone','purged')),
  lifecycle_changed_at INTEGER,
  episode_id        TEXT,
  version           INTEGER DEFAULT 1,
  supersedes_id     TEXT,                        -- 再巩固新版本指向旧版本
  suppressed        INTEGER DEFAULT 0,
  sensitivity       INTEGER DEFAULT 0 CHECK (sensitivity IN (0,1,2)),
  exposures_7d      INTEGER DEFAULT 0,
  -- 迁移留档
  calcium_legacy    REAL,                        -- 迁移前原值，只读
  calcium_score     REAL,                        -- 旧三量纲列（迁移期保留）
  recall_count      INTEGER DEFAULT 0,
  last_recalled_at  TEXT,                        -- 旧本地时间字符串（迁移期保留，Asia/Shanghai 无时区）
  migration_ambiguous INTEGER DEFAULT 0,         -- M3 迁移标记：量纲无法判定
  dna_root_id       TEXT,
  is_landmark       INTEGER DEFAULT 0,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE SET NULL
);

-- =====================================================================
-- T4 / L4 双时态语义事实：semantic_facts（新建）
-- =====================================================================
CREATE TABLE IF NOT EXISTS semantic_facts (
  id                TEXT PRIMARY KEY,
  domain            TEXT NOT NULL CHECK (domain IN ('fg','dossier','kb','relation','preference')),
  subject_uuid      TEXT NOT NULL,
  predicate         TEXT NOT NULL,                -- lives_in / likes / works_at ...
  object_text       TEXT,
  object_uuid       TEXT,
  valid_from        INTEGER,                      -- 世界时间
  valid_to          INTEGER,                      -- 世界时间，NULL=仍为真
  recorded_at       INTEGER NOT NULL,             -- 系统时间
  invalidated_at    INTEGER,
  superseded_by     TEXT,
  confidence        REAL DEFAULT 0.7,
  source_ids        TEXT NOT NULL,                -- JSON: 溯源链
  sensitivity       INTEGER DEFAULT 0 CHECK (sensitivity IN (0,1,2))
);

-- =====================================================================
-- T5 / 实体图边表：entity_edges（新建，供 PPR 检索）
-- =====================================================================
CREATE TABLE IF NOT EXISTS entity_edges (
  src_uuid          TEXT NOT NULL,
  dst_uuid          TEXT NOT NULL,
  rel               TEXT NOT NULL,
  weight            REAL DEFAULT 1.0,
  trace_id          TEXT,
  updated_at        INTEGER,
  PRIMARY KEY (src_uuid, dst_uuid, rel, trace_id)
);

-- =====================================================================
-- T6 / 痕迹-实体多对多：trace_entities（新建）
-- =====================================================================
CREATE TABLE IF NOT EXISTS trace_entities (
  trace_id         TEXT NOT NULL,
  entity_uuid      TEXT NOT NULL,
  PRIMARY KEY (trace_id, entity_uuid)
);

-- =====================================================================
-- T7 / L5 黑钻指针表：black_diamond_v2（新建，只存引用不存内容）
-- =====================================================================
CREATE TABLE IF NOT EXISTS black_diamond_v2 (
  id                TEXT PRIMARY KEY,
  ref_type          TEXT NOT NULL CHECK (ref_type IN ('episode','trace','fact')),
  ref_id            TEXT NOT NULL,
  title             TEXT,                        -- 展示短标题，不承载内容
  entry_channel     TEXT NOT NULL CHECK (entry_channel IN ('auto','manual','user_confirmed')),
  entry_reason      TEXT,
  self_defining     REAL,                        -- 自我定义度评分
  user_confirmed    INTEGER DEFAULT 0,
  snapshot_hash     TEXT,                        -- 引用内容哈希，防静默篡改
  status            TEXT DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at        INTEGER NOT NULL
);

-- =====================================================================
-- T8 / 前瞻记忆：prospective_items（新建）
-- =====================================================================
CREATE TABLE IF NOT EXISTS prospective_items (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('promise','reminder','plan','anniversary')),
  content           TEXT,
  owner             TEXT,                        -- user / assistant
  trigger_type      TEXT NOT NULL CHECK (trigger_type IN ('time','event','entity')),
  due_at            INTEGER,
  trigger_entity    TEXT,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending','fired','done','expired','cancelled')),
  source_id         TEXT,
  created_at        INTEGER NOT NULL
);

-- =====================================================================
-- T9 / 墓碑表：tombstones（新建，记录已删除记忆元数据）
-- =====================================================================
CREATE TABLE IF NOT EXISTS tombstones (
  id                TEXT PRIMARY KEY,
  target_type       TEXT NOT NULL,               -- conversation / memory / episode / fact
  deleted_at        INTEGER NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN ('decay','user_request','merge','test_cleanup')),
  dna_root_id        TEXT,
  consolidation     REAL,
  last_recall       INTEGER,
  content_hash      TEXT,
  purge_after       INTEGER NOT NULL             -- epoch ms，过此时刻可物理清除
);

-- =====================================================================
-- T10 / 遗忘请求：forget_requests（新建）
-- =====================================================================
CREATE TABLE IF NOT EXISTS forget_requests (
  id                TEXT PRIMARY KEY,
  mode              TEXT NOT NULL CHECK (mode IN ('suppress','forget')),
  query             TEXT,
  matched_ids       TEXT,                        -- JSON
  confirmed         INTEGER DEFAULT 0,
  created_at        INTEGER NOT NULL,
  executed_at       INTEGER
);

-- =====================================================================
-- T11 / 哈希链审计账本：audit_ledger（新建，永久只追加）
-- =====================================================================
CREATE TABLE IF NOT EXISTS audit_ledger (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_utc            INTEGER NOT NULL,
  actor             TEXT NOT NULL,                -- system / sleep_run:<id> / user / owner
  action            TEXT NOT NULL,                -- promote / tombstone / purge / restore / migrate ...
  target_type       TEXT,
  target_id         TEXT,
  meta              TEXT,                         -- JSON：只放元数据，绝不放内容原文
  prev_hash         TEXT NOT NULL,
  hash              TEXT NOT NULL                 -- sha256(prev_hash || 本行规范化序列)
);

-- 触发器：禁止 UPDATE / DELETE（append-only 红线）
CREATE TRIGGER IF NOT EXISTS ledger_no_update
BEFORE UPDATE ON audit_ledger
BEGIN
  SELECT RAISE(ABORT, 'audit_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS ledger_no_delete
BEFORE DELETE ON audit_ledger
BEGIN
  SELECT RAISE(ABORT, 'audit_ledger is append-only');
END;

-- =====================================================================
-- T12 / 睡眠运行记录：sleep_runs（新建，断点续跑）
-- =====================================================================
CREATE TABLE IF NOT EXISTS sleep_runs (
  id                TEXT PRIMARY KEY,
  cycle_no          INTEGER,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  current_step      TEXT,                        -- 十个步骤的进度标记
  checkpoint        TEXT,                        -- JSON: 断点状态
  status            TEXT DEFAULT 'running' CHECK (status IN ('running','paused','completed','failed')),
  stats             TEXT                         -- JSON: 运行统计
);

-- =====================================================================
-- T13 / 强化事件遥测：reinforcement_events（新建，滚动保留 180 天）
-- =====================================================================
CREATE TABLE IF NOT EXISTS reinforcement_events (
  trace_id          TEXT NOT NULL,
  ts_utc            INTEGER NOT NULL,
  path              TEXT,                        -- A_confirm / A_engaged / B_engaged / sleep_replay / stc
  signal            TEXT,
  delta_c           REAL,
  PRIMARY KEY (trace_id, ts_utc, path)
);

-- =====================================================================
-- T14 / 工作记忆缓冲：wm_buffer（新建/改造，崩溃恢复用）
-- =====================================================================
CREATE TABLE IF NOT EXISTS wm_buffer (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  payload           TEXT NOT NULL,               -- JSON: WorkingEntry
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  gate              TEXT,                        -- WRITE / RAW_ONLY / DISCARD
  ts_utc            INTEGER NOT NULL
);

-- =====================================================================
-- schema_version（迁移跟踪表，所有模块共用）
-- =====================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  name              TEXT PRIMARY KEY,
  applied_at        INTEGER NOT NULL,
  checksum          TEXT NOT NULL,
  direction         TEXT NOT NULL DEFAULT 'up' CHECK (direction IN ('up','down'))
);
