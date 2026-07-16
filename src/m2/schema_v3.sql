-- @deprecated: 历史参考，权威 schema 见 schema.sql
--
-- Schema v3 — 时空环境规则引擎（temporal event + ambient weather）
-- 向前兼容，不破坏现有数据

-- 表1：时序事件档案
CREATE TABLE IF NOT EXISTS temporal_events (
    event_id TEXT PRIMARY KEY,
    belong_entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('phys_cycle','trip','heal','custom')),
    parent_event_id TEXT DEFAULT NULL,
    event_raw_text TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER DEFAULT NULL,
    cycle_ms INTEGER DEFAULT 0,
    max_nest_level TINYINT DEFAULT 3,
    is_cyclic BOOLEAN DEFAULT 0,
    source_mode TEXT DEFAULT 'chat_llm',
    source_url TEXT DEFAULT NULL,
    dna_root_id TEXT NOT NULL,
    status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','canceled','warning')),
    create_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_temporal_events_entity_status ON temporal_events(belong_entity_id, status);
CREATE INDEX IF NOT EXISTS idx_temporal_events_end_ts ON temporal_events(end_ts);

-- 表2：环境气象数据
CREATE TABLE IF NOT EXISTS ambient_weather_context (
    weather_id TEXT PRIMARY KEY,
    belong_area TEXT NOT NULL,
    weather_type TEXT NOT NULL,
    temperature_low INTEGER,
    temperature_high INTEGER,
    weather_desc TEXT,
    alert_info TEXT DEFAULT NULL,
    minute_precip TEXT DEFAULT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER DEFAULT NULL,
    source_mode TEXT DEFAULT 'qweather_api' CHECK(source_mode IN ('qweather_api','chat_llm')),
    source_url TEXT DEFAULT NULL,
    api_last_update_ts INTEGER DEFAULT 0,
    dna_root_id TEXT NOT NULL,
    status TEXT DEFAULT 'effective' CHECK(status IN ('effective','expired','override')),
    create_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ambient_weather_time ON ambient_weather_context(start_ts, end_ts);
CREATE INDEX IF NOT EXISTS idx_ambient_weather_source ON ambient_weather_context(source_mode);
