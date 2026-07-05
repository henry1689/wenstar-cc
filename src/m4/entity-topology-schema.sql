-- v3.0: 全局实体关系拓扑表
-- 核心设计：
--   1. 双向存储：每条关系录入正反两条记录（自动同步）
--   2. 标准化枚举：统一关系类型，消除文本匹配漂移
--   3. 递归可用：topology_level + 索引支持多级检索
--   4. 全链路溯源：dna_root_id 追踪关系来源对话

CREATE TABLE IF NOT EXISTS entity_topology (
  id TEXT PRIMARY KEY,
  root_entity_id TEXT NOT NULL,       -- 主实体 ID（人物名）
  target_entity_id TEXT NOT NULL,     -- 关联实体 ID
  relation_type TEXT NOT NULL,        -- 关系枚举（如 mother/sister/colleague）
  reverse_relation TEXT NOT NULL,     -- 反向关系（如 mother→daughter, sister→sister）
  topology_level INTEGER DEFAULT 1,  -- 1=直系 2=二代旁系 3=三代远亲
  namespace TEXT DEFAULT 'default',   -- 多空间隔离
  dna_root_id TEXT,                   -- 来源对话 DNA 根码（全链路溯源）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (root_entity_id) REFERENCES entities(name),
  FOREIGN KEY (target_entity_id) REFERENCES entities(name)
);

-- 索引：支持多级递归查询
CREATE INDEX IF NOT EXISTS idx_topology_root ON entity_topology(root_entity_id, topology_level);
CREATE INDEX IF NOT EXISTS idx_topology_target ON entity_topology(target_entity_id, topology_level);
CREATE INDEX IF NOT EXISTS idx_topology_type ON entity_topology(relation_type);
CREATE INDEX IF NOT EXISTS idx_topology_ns ON entity_topology(namespace);
