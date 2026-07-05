-- Schema v2 — M2 存储层编码链路+基建标准化
-- 向前兼容，不破坏现有数据

-- schema_version 表（新增）
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    migrated_at TEXT NOT NULL,
    checksum TEXT
);

-- 初始化版本记录由代码中 migrateSchema() 执行

-- ── conversations 补全字段 ──
-- dna_root_id 已有，无需新增
-- is_compacted/is_summary 已在表中，统一走 is_summary

-- ── memories 补全字段 ──
-- dna_root_id 已有
ALTER TABLE memories ADD COLUMN dna_full_code TEXT;
ALTER TABLE memories ADD COLUMN l2_norm REAL;

-- ── black_diamond 补全字段 ──
ALTER TABLE black_diamond ADD COLUMN dna_root_id TEXT;
ALTER TABLE black_diamond ADD COLUMN dna_full_code TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_dna_full_code ON memories(dna_full_code);
CREATE INDEX IF NOT EXISTS idx_memories_l2_norm ON memories(l2_norm);
CREATE INDEX IF NOT EXISTS idx_black_diamond_dna_root_id ON black_diamond(dna_root_id);
