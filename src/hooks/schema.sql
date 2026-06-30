-- Hooks 后台存储表结构
-- S4.1 三张表: hooks_events(原始数据), hooks_stats(聚合统计), hooks_commands(调度指令)

-- 原始采集数据
CREATE TABLE IF NOT EXISTS hooks_events (
  id TEXT PRIMARY KEY,
  dna_code TEXT,
  operation_type TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'success',
  input_tags TEXT,
  source_tier TEXT,
  target_tier TEXT,
  payload_size INTEGER DEFAULT 0,
  match_count INTEGER DEFAULT 0,
  error_info TEXT,
  created_at TEXT NOT NULL
);

-- 聚合统计（定时计算写入）
CREATE TABLE IF NOT EXISTS hooks_stats (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  period TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  total_calls INTEGER DEFAULT 0,
  avg_duration REAL DEFAULT 0,
  max_duration REAL DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  p50 REAL DEFAULT 0,
  p90 REAL DEFAULT 0,
  p99 REAL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 调度指令
CREATE TABLE IF NOT EXISTS hooks_commands (
  id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  target_dna TEXT,
  target_module TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  source_analysis TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  done_at TEXT
);
