-- Hermes Fusion Memory Schema v2.0
-- v2: 新增 P0-1 时空标签字段 + P0-4 幂等字段 + P1-4 namespace

-- 核心记忆表
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    seq_pos INTEGER UNIQUE NOT NULL,
    created_at TEXT NOT NULL,

    -- 24维情感向量 (JSON数组)
    perception_json TEXT NOT NULL,

    -- 钙化
    calcium_score REAL NOT NULL,
    calcium_level INTEGER NOT NULL CHECK(calcium_level BETWEEN 0 AND 3),

    -- 内容次级索引
    locus_path TEXT NOT NULL,
    leaf_zone TEXT NOT NULL,
    raw_input TEXT NOT NULL,
    memory_kind TEXT DEFAULT 'episodic',
    lifecycle_state TEXT DEFAULT 'candidate',
    confidence_score REAL DEFAULT 0.5,
    stability_score REAL DEFAULT 0.5,
    last_verified_at TEXT,
    promotion_reason TEXT,
    suppression_reason TEXT,
    archived_at TEXT,
    healed_at TEXT,
    thread_id TEXT,
    session_id TEXT,
    dialog_group_id TEXT,
    source_conversation_ids TEXT,

    -- 记忆动力学
    recall_count INTEGER DEFAULT 0,
    promoted_to_diamond INTEGER DEFAULT 0,
    last_recalled_at TEXT,
    reinforcement_accumulator REAL DEFAULT 0.0,
    effective_strength REAL DEFAULT 1.0,
    strength_updated_at TEXT NOT NULL,

    -- VAD 谱曲
    vad_spectrum TEXT,

    -- 年轮/地标
    is_landmark INTEGER DEFAULT 0,
    landmarked_at TEXT,
    narrative_tag TEXT,
    sensory_anchor TEXT,
    scar_type TEXT,
    scar_healed INTEGER,
    primary_emotion TEXT,
    secondary_emotions TEXT,

    -- 三段关联
    dna_root_id TEXT,
    entity_genes TEXT,
    is_promoted INTEGER DEFAULT 0,

    -- P0-1: 家族图谱实体名列表（逗号分隔，用于多维检索）
    fg_entity_names TEXT,
    -- P0-1: 时空标签
    time_period TEXT,
    season TEXT,
    lunar_term TEXT,

    -- P1-4: 多租户命名空间
    namespace TEXT DEFAULT 'default',

    -- V4.0: 来源类型 (conversation | knowledge_vault | manual)
    source_type TEXT DEFAULT 'conversation'
);

CREATE INDEX IF NOT EXISTS idx_memories_calcium ON memories(calcium_score DESC);
CREATE INDEX IF NOT EXISTS idx_memories_strength ON memories(effective_strength DESC);
CREATE INDEX IF NOT EXISTS idx_memories_locus ON memories(locus_path);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_landmarks ON memories(is_landmark) WHERE is_landmark = 1;
CREATE INDEX IF NOT EXISTS idx_memories_calcium_strength ON memories(calcium_level, effective_strength);
-- P0-1: 多维检索索引
CREATE INDEX IF NOT EXISTS idx_memories_fg_entity ON memories(fg_entity_names);
CREATE INDEX IF NOT EXISTS idx_memories_time_period ON memories(time_period);
CREATE INDEX IF NOT EXISTS idx_memories_season ON memories(season);
-- P1-4: 多租户索引
CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(memory_kind);
CREATE INDEX IF NOT EXISTS idx_memories_lifecycle ON memories(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_memories_thread ON memories(thread_id);
CREATE INDEX IF NOT EXISTS idx_memories_source_type ON memories(source_type);

-- 实体表
CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('person','place','event','emotion','object','self')),
    UNIQUE(name, type)
);

-- 记忆-实体关联
CREATE TABLE IF NOT EXISTS memory_entities (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    allele TEXT,
    phenotype TEXT CHECK(phenotype IN ('enhance','conflict','neutral')),
    knowledge_type TEXT CHECK(knowledge_type IN ('private','family','world')),
    PRIMARY KEY (memory_id, entity_id)
);

-- 实体关系图
CREATE TABLE IF NOT EXISTS entity_relations (
    entity_a_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    entity_b_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    strength REAL DEFAULT 1.0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (entity_a_id, entity_b_id, relation)
);

-- 高阶归纳
CREATE TABLE IF NOT EXISTS inductions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_type TEXT NOT NULL CHECK(period_type IN ('daily','weekly','monthly','hourly')),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    source_record_count INTEGER,
    dominant_mood TEXT,
    trait_updates TEXT,
    created_at TEXT NOT NULL
);

-- 知识库
CREATE TABLE IF NOT EXISTS knowledge_base (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'text',
    source_name TEXT,
    file_size INTEGER DEFAULT 0,
    tags TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    locked INTEGER DEFAULT 0,
    classification TEXT,
    classification_pending INTEGER DEFAULT 1,
    dna_id TEXT,
    scene_tags TEXT,
    interaction_type TEXT DEFAULT 'other',
    emotion_vector TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge_base(created_at DESC);

-- 知识-记忆关联
CREATE TABLE IF NOT EXISTS knowledge_memories (
    knowledge_id TEXT NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relevance REAL DEFAULT 1.0,
    PRIMARY KEY (knowledge_id, memory_id)
);

-- 知识分块
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY,
    kn_id TEXT NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_kn_id ON knowledge_chunks(kn_id);

-- 衰减日志
CREATE TABLE IF NOT EXISTS decay_log (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL,
    strength_before REAL,
    strength_after REAL,
    days_elapsed REAL,
    PRIMARY KEY (memory_id, checked_at)
);

-- 黑钻库
CREATE TABLE IF NOT EXISTS black_diamond (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    emotion_tag TEXT,
    source_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
    calcium_level INTEGER DEFAULT 1,
    recall_count INTEGER DEFAULT 0,
    tags TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    emotion_vector TEXT DEFAULT NULL,
    namespace TEXT DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS idx_black_diamond_emotion ON black_diamond(emotion_tag);
CREATE INDEX IF NOT EXISTS idx_black_diamond_created ON black_diamond(created_at DESC);
-- V4.0: 黑钻库增强字段
ALTER TABLE black_diamond ADD COLUMN entry_channel TEXT DEFAULT 'auto';
ALTER TABLE black_diamond ADD COLUMN entry_reason TEXT;
ALTER TABLE black_diamond ADD COLUMN stabilization_score REAL DEFAULT 1.0;
ALTER TABLE black_diamond ADD COLUMN manual_quota_consumed INTEGER DEFAULT 0;
ALTER TABLE black_diamond ADD COLUMN status TEXT DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_black_diamond_namespace ON black_diamond(namespace);

-- 黑钻倒排索引
CREATE TABLE IF NOT EXISTS black_diamond_terms (
    term TEXT NOT NULL,
    bd_id TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    PRIMARY KEY (term, bd_id)
);
CREATE INDEX IF NOT EXISTS idx_bd_terms_term ON black_diamond_terms(term);
CREATE INDEX IF NOT EXISTS idx_bd_terms_bd_id ON black_diamond_terms(bd_id);

-- AQC质检表
CREATE TABLE IF NOT EXISTS aqc_records (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK(source_type IN ('sand','gold')),
    source_id TEXT NOT NULL,
    content_snippet TEXT,
    calcium_level INTEGER DEFAULT 0,
    entity_count INTEGER DEFAULT 0,
    recall_count INTEGER DEFAULT 0,
    score REAL DEFAULT 0.0,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    tags TEXT,
    created_at TEXT NOT NULL,
    evaluated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_aqc_status ON aqc_records(status);
CREATE INDEX IF NOT EXISTS idx_aqc_source ON aqc_records(source_type, status);

-- 三库操作日志
CREATE TABLE IF NOT EXISTS vault_log (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    source_type TEXT,
    source_id TEXT,
    target_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_log_op ON vault_log(operation);
CREATE INDEX IF NOT EXISTS idx_vault_log_time ON vault_log(created_at);

-- 砂金库 — 全量对话活档案
-- P0-4: 新增 message_id 唯一索引用于幂等写入
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    seq_pos INTEGER,
    topic TEXT,
    entity_names TEXT,
    perception_summary TEXT,
    calcium_score REAL DEFAULT 0,
    dna_root_id TEXT,
    dialog_group_id TEXT,
    dialog_round INTEGER DEFAULT 0,
    is_compacted INTEGER DEFAULT 0,
    is_test INTEGER DEFAULT 0,
    is_summary INTEGER DEFAULT 0,
    is_promoted INTEGER DEFAULT 0,
    roleplay_char TEXT,
    summary_of_range TEXT,
    -- P0-4: 消息唯一ID（业务幂等键）
    message_id TEXT UNIQUE,
    -- P1-4: 多租户命名空间
    namespace TEXT DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp);
CREATE INDEX IF NOT EXISTS idx_conv_topic ON conversations(topic);
CREATE INDEX IF NOT EXISTS idx_conv_seq ON conversations(seq_pos);
CREATE INDEX IF NOT EXISTS idx_conv_summary ON conversations(is_summary);
CREATE INDEX IF NOT EXISTS idx_conv_dna_root ON conversations(dna_root_id);
CREATE INDEX IF NOT EXISTS idx_conv_dg ON conversations(dialog_group_id);
CREATE INDEX IF NOT EXISTS idx_conv_promoted ON conversations(is_promoted);
CREATE INDEX IF NOT EXISTS idx_conv_message_id ON conversations(message_id);

-- 主人大脑镜像
CREATE TABLE IF NOT EXISTS master_profile (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    subcategory TEXT,
    content TEXT NOT NULL,
    source TEXT,
    confidence REAL DEFAULT 0.5,
    calcium_score REAL DEFAULT 0,
    mention_count INTEGER DEFAULT 1,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    tags TEXT
);
CREATE INDEX IF NOT EXISTS idx_profile_category ON master_profile(category);
CREATE INDEX IF NOT EXISTS idx_profile_confidence ON master_profile(confidence DESC);

CREATE TABLE IF NOT EXISTS master_affairs (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    description TEXT,
    related_persons TEXT,
    priority TEXT DEFAULT 'medium',
    start_date TEXT,
    end_date TEXT,
    next_action TEXT,
    source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_affairs_status ON master_affairs(status);
CREATE INDEX IF NOT EXISTS idx_affairs_category ON master_affairs(category);

CREATE TABLE IF NOT EXISTS master_network (
    id TEXT PRIMARY KEY,
    person_name TEXT NOT NULL,
    relation_type TEXT,
    organization TEXT,
    role TEXT,
    context TEXT,
    importance INTEGER DEFAULT 3,
    last_contact TEXT,
    tags TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_network_name ON master_network(person_name);
CREATE INDEX IF NOT EXISTS idx_network_importance ON master_network(importance DESC);

CREATE TABLE IF NOT EXISTS master_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    date TEXT,
    emotion_tag TEXT,
    calcium_score REAL,
    summary TEXT,
    related_persons TEXT,
    impact TEXT DEFAULT 'medium',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON master_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_date ON master_events(date);

-- 幻觉校验日志
CREATE TABLE IF NOT EXISTS hallucination_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reply_hash TEXT NOT NULL,
    reply_preview TEXT NOT NULL,
    hallucinated_names TEXT NOT NULL,
    known_names TEXT,
    severity TEXT NOT NULL DEFAULT 'low',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hallucination_created ON hallucination_log(created_at);

-- V4.0 Phase 2: MD源文件→记忆条目溯源表
CREATE TABLE IF NOT EXISTS source_tracking (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    source_uuid TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_st_source_path ON source_tracking(source_path);
CREATE INDEX IF NOT EXISTS idx_st_memory_id ON source_tracking(memory_id);
CREATE INDEX IF NOT EXISTS idx_st_status ON source_tracking(status);

-- V4.0 Phase 3: memories 来源类型索引
CREATE INDEX IF NOT EXISTS idx_memories_source_type ON memories(source_type);

-- V4.0 Phase 5: 黑钻库 status 索引
CREATE INDEX IF NOT EXISTS idx_bd_status ON black_diamond(status);

-- V4.0 Phase 5: 检索策略质量日志
CREATE TABLE IF NOT EXISTS retrieval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL DEFAULT "retrieveMemories",
  locus_path TEXT,
  latency_ms INTEGER,
  result_count INTEGER DEFAULT 0,
  entity_count INTEGER DEFAULT 0,
  hit_index INTEGER DEFAULT 0,
  created_at TEXT
);
