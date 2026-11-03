-- =====================================================================
-- MemArch-v2.0.0 / M1-Storage / 05_views.sql
-- 命名空间隔离视图（业务代码只读入口，禁止直接查原表）
-- 规则：default 命名空间 + 非角色 + 非 tombstone/purged
-- =====================================================================

-- 按任务书 §3.2 严格定义
CREATE VIEW IF NOT EXISTS v_conv_real AS
  SELECT * FROM conversations
  WHERE COALESCE(namespace, 'default') = 'default'
    AND (roleplay_char IS NULL OR roleplay_char = '')
    AND COALESCE(lifecycle_state, 'fresh') NOT IN ('tombstone', 'purged');

CREATE VIEW IF NOT EXISTS v_mem_real AS
  SELECT * FROM memories
  WHERE COALESCE(namespace, 'default') = 'default'
    AND lifecycle_state NOT IN ('tombstone', 'purged');

-- 补充同名空间隔离视图（同一过滤规则，供其他模块使用，不扩接口）
CREATE VIEW IF NOT EXISTS v_ep_real AS
  SELECT * FROM episodes
  WHERE COALESCE(namespace, 'default') = 'default'
    AND lifecycle_state NOT IN ('tombstone', 'purged');

CREATE VIEW IF NOT EXISTS v_fact_real AS
  SELECT * FROM semantic_facts
  WHERE COALESCE(sensitivity, 0) < 2
    AND (valid_to IS NULL OR valid_to > strftime('%s','now') * 1000);

-- 黑钻视图（只暴露 active）
CREATE VIEW IF NOT EXISTS v_bd_active AS
  SELECT * FROM black_diamond_v2 WHERE status = 'active';

-- 测试命名空间专用视图（仅测试代码使用，生产视图永远看不到 test 数据）
CREATE VIEW IF NOT EXISTS v_conv_test AS
  SELECT * FROM conversations WHERE namespace = 'test';

CREATE VIEW IF NOT EXISTS v_mem_test AS
  SELECT * FROM memories WHERE namespace = 'test';

-- =====================================================================
-- 使用规则（CI lint 强制）：
--   storage/ 目录外出现 "FROM conversations" / "FROM memories" / "FROM episodes"
--   直接 lint 失败。必须走 v_conv_real / v_mem_real / v_ep_real。
-- =====================================================================
