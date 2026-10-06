-- Hermes Fusion Memory Schema v2.0
-- v2: 新增 P0-1 时空标签字段 + P0-4 幂等字段 + P1-4 namespace

-- 核心记忆表
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    seq_pos INTEGER UNIQUE NOT NULL,
    created_at TEXT NOT NULL,

    -- V12.4 根除24D: perception_json 列已由 v14 迁移删除（DROP COLUMN）
    -- 40D感知向量 (JSON v2格式 {__v:2,dims:[40]}，唯一落库感知向量)
    -- 可空：记事/知识卷宗/锚点合法不带向量，检索时缺40D行降级按钙化分
    perception_40d TEXT,

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
    source_type TEXT DEFAULT 'conversation',

    -- V10.4: 实体归属标注 (TXS-ID，关联 entities 表 UUID)
    belong_entity_uuid TEXT,

    -- V13: Foresight 前瞻时态标记（计划/承诺/预测的时效管理）
    is_foresight INTEGER DEFAULT 0,
    valid_until_ms REAL,
    foresight_status TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_calcium ON memories(calcium_score DESC);
CREATE INDEX IF NOT EXISTS idx_memories_strength ON memories(effective_strength DESC);
CREATE INDEX IF NOT EXISTS idx_memories_locus ON memories(locus_path);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_landmarks ON memories(is_landmark) WHERE is_landmark = 1;
CREATE INDEX IF NOT EXISTS idx_memories_calcium_strength ON memories(calcium_level, effective_strength);
-- V13: UUID 实体隔离索引
CREATE INDEX IF NOT EXISTS idx_memories_belong_uuid ON memories(belong_entity_uuid);
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
    uuid TEXT,  -- 🆕 V5.0: 对应 FamilyGraph.nodes.uuid (TXS-ID)
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
-- 🆕 V10.0 P1-1: 记忆-实体关联索引（每条 JOIN 都要扫全表）
CREATE INDEX IF NOT EXISTS idx_me_memory ON memory_entities(memory_id);
CREATE INDEX IF NOT EXISTS idx_me_entity ON memory_entities(entity_id);

-- 实体关系图
CREATE TABLE IF NOT EXISTS entity_relations (
    entity_a_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    entity_b_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    strength REAL DEFAULT 1.0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (entity_a_id, entity_b_id, relation)
);
-- 🆕 V10.0 P1-1: 实体关系索引（多跳检索每跳都全表扫描）
CREATE INDEX IF NOT EXISTS idx_er_a ON entity_relations(entity_a_id);
CREATE INDEX IF NOT EXISTS idx_er_b ON entity_relations(entity_b_id);

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
    emotion_vector TEXT,
    -- V3.2: 户籍卷宗归档 — 此知识条目属于哪个实体 UUID
    belong_entity_uuid TEXT,
    -- V10.1: 印象分+召回计数（ImpressionModel 写入）
    impression_score REAL DEFAULT 0.5,
    recall_count INTEGER DEFAULT 0,
    last_recalled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge_base(created_at DESC);
-- 🆕 V10.0 P1-1: 知识库分类索引（getUnclassified 每轮都查，无索引则全表扫描）
CREATE INDEX IF NOT EXISTS idx_kb_class ON knowledge_base(classification);
-- V13: UUID 实体隔离索引
CREATE INDEX IF NOT EXISTS idx_kb_belong_uuid ON knowledge_base(belong_entity_uuid);

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

-- 钙化变更溯源 (P0-5b′, 2026-10-07)
-- 为什么需要：memories 只存当前值、没有任何变更历史 ⇒ 「钙化凭什么爬到 10」无法事后反推
--   （见 docs/P0-5-钙化升级机制调查报告.md §4：来源字段值域已污染、id 反查只对 7/35 有效）。
-- 写入方：src/m2/calciumWatch.ts 的「快照差分」（source='snapshot_diff'）；
--   日后方案甲（精确事件埋点）复用本表，只补 source 标签，不另起炉灶。
-- 🔴 刻意**不**加 REFERENCES memories(id) ON DELETE CASCADE：_rebuildMemoryAnchors() 每次启动
--   会 DELETE 全部锚点行，若带级联，锚点的变更历史会被每次重启清空 —— 而锚点正是高钙嫌疑对象之一。
--   历史记录应当比被观测的行活得更久。
-- 纯观测表，从不参与检索；由 calciumWatch 的裁剪策略控制体积（每行 30 条 / 全局 90 天）。
CREATE TABLE IF NOT EXISTS calcium_change_log (
    memory_id  TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    old_value  REAL,
    new_value  REAL,
    source     TEXT NOT NULL,
    note       TEXT,
    PRIMARY KEY (memory_id, changed_at)
);
CREATE INDEX IF NOT EXISTS idx_ccl_changed_at ON calcium_change_log(changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ccl_source ON calcium_change_log(source, changed_at DESC);

-- 黑钻库 (V4.0 增强字段已直接纳入 CREATE TABLE)
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
    namespace TEXT DEFAULT 'default',
    entry_channel TEXT DEFAULT 'auto',
    entry_reason TEXT,
    stabilization_score REAL DEFAULT 1.0,
    manual_quota_consumed INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    -- V12.1: 实体归属标注
    belong_entity_uuid TEXT,
    dna_root_id TEXT,
    dna_full_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_black_diamond_emotion ON black_diamond(emotion_tag);
CREATE INDEX IF NOT EXISTS idx_black_diamond_created ON black_diamond(created_at DESC);
-- V4.0: 黑钻库增强字段 → 已迁移至 MigrationManager v7，防止 schema.sql 重启时 ALTER TABLE 重复执行崩溃
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

-- V11.0: 统一语义搜索索引 — n-gram倒排表，覆盖四层存储
-- n-gram仅作前置围栏过滤器，不参与最终排序。
-- 最终排序由自有32D语义向量 完成。
CREATE TABLE IF NOT EXISTS search_index (
    term TEXT NOT NULL,              -- 2-3字中文n-gram
    source_type TEXT NOT NULL,       -- 'conversation'|'memory'|'black_diamond'|'knowledge_base'
    source_id TEXT NOT NULL,         -- 对应表的id
    belong_entity_uuid TEXT,         -- 实体归属
    position INTEGER DEFAULT 0,      -- term在原文中的位置
    PRIMARY KEY (term, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_si_term ON search_index(term);
CREATE INDEX IF NOT EXISTS idx_si_source ON search_index(source_type, source_id);

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
    content_md TEXT,
    created_at TEXT NOT NULL,
    -- V13: 实体归属标注 (TXS-ID，通过 source_id→memories.id 回填)
    belong_entity_uuid TEXT
);
CREATE INDEX IF NOT EXISTS idx_vault_log_op ON vault_log(operation);
CREATE INDEX IF NOT EXISTS idx_vault_log_time ON vault_log(created_at);
-- V13: UUID 实体隔离索引
CREATE INDEX IF NOT EXISTS idx_vault_log_belong_uuid ON vault_log(belong_entity_uuid);

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
    namespace TEXT DEFAULT 'default',
    -- V3.2: 户籍卷宗归档 — 此对话属于哪个实体 UUID
    belong_entity_uuid TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp);
CREATE INDEX IF NOT EXISTS idx_conv_topic ON conversations(topic);
CREATE INDEX IF NOT EXISTS idx_conv_seq ON conversations(seq_pos);
CREATE INDEX IF NOT EXISTS idx_conv_summary ON conversations(is_summary);
CREATE INDEX IF NOT EXISTS idx_conv_dna_root ON conversations(dna_root_id);
CREATE INDEX IF NOT EXISTS idx_conv_dg ON conversations(dialog_group_id);
CREATE INDEX IF NOT EXISTS idx_conv_promoted ON conversations(is_promoted);
CREATE INDEX IF NOT EXISTS idx_conv_message_id ON conversations(message_id);
-- V13: UUID 实体隔离索引
CREATE INDEX IF NOT EXISTS idx_conversations_belong_uuid ON conversations(belong_entity_uuid);
-- 🆕 V10.0 P1-1: 对话压缩标记索引（几乎所有查询都过滤 is_compacted=0）
CREATE INDEX IF NOT EXISTS idx_conv_compacted ON conversations(is_compacted);

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
-- V13: UUID 实体隔离索引
CREATE INDEX IF NOT EXISTS idx_black_diamond_belong_uuid ON black_diamond(belong_entity_uuid);

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
