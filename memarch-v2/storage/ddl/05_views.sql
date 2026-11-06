-- =====================================================================
-- MemArch-v2.1.0 / M1-Storage / 05_views.sql
-- 生命周期视图（业务代码只读入口，禁止直接查原表）
-- 规则：非 tombstone/purged（**不再按 namespace 过滤**）
--
-- 🔴 v2.0.0 → v2.1.0 变更（ADR-016 §三 变更 #3 / #4）：
--   原实现 `WHERE COALESCE(namespace,'default')='default'` —— 而按角色分 ns 写入的
--   数据（ns_yuyao/ns_shiyu/… 共 17335 条）在 default 域** 0 条**，走本视图恒返回 0 条，
--   却因「任何 ns 都命中 0、测不出区别」而看不出隔离已失效。
--   namespace 隔离**下移到查询层显式参数**（QueryContext.namespace + SQL `AND m.namespace = @ns`），
--   视图只保留生命周期过滤，不再冒充隔离边界。
-- =====================================================================

-- 按任务书 §3.2 严格定义（v2.1.0：只做生命周期过滤，namespace 由查询层显式提供）
-- 🔴 业主 2026-11-06 裁定：`roleplay_char` 语义 = **谁扮演的归谁**（存扮演者实体名），
--   「不管他扮演的谁都不重要，只要他自己知道是他扮演的就行」；旧库「全 NULL = 扮演模式标记」
--   的语义作废。实测迁移后 15256 行该字段为扮演者名（徐诗雨 6318 / 阿珍 3663 / 玉瑶 1998 …），
--   仅 ns_legacy_unknown 2598 行为空 ⇒ 原过滤 `roleplay_char IS NULL` 只留下归属不明的数据、
--   **排除全部真实实体对话（缺 85%）**。该字段值属「要的」，故过滤移除。
--   namespace 隔离仍由查询层 `AND m.namespace = @ns` 承担（与本文件移除 ns 过滤同一原则）。
CREATE VIEW IF NOT EXISTS v_conv_real AS
  SELECT * FROM conversations
  WHERE COALESCE(lifecycle_state, 'fresh') NOT IN ('tombstone', 'purged');

CREATE VIEW IF NOT EXISTS v_mem_real AS
  SELECT * FROM memories
  WHERE lifecycle_state NOT IN ('tombstone', 'purged');

-- 补充同名空间视图（同一过滤规则，供其他模块使用，不扩接口）
CREATE VIEW IF NOT EXISTS v_ep_real AS
  SELECT * FROM episodes
  WHERE lifecycle_state NOT IN ('tombstone', 'purged');

CREATE VIEW IF NOT EXISTS v_fact_real AS
  SELECT * FROM semantic_facts
  WHERE COALESCE(sensitivity, 0) < 2
    AND (valid_to IS NULL OR valid_to > strftime('%s','now') * 1000);

-- 黑钻视图（只暴露 active）
CREATE VIEW IF NOT EXISTS v_bd_active AS
  SELECT * FROM black_diamond_v2 WHERE status = 'active';

-- 测试命名空间专用视图（仅测试代码使用，生产视图永远看不到 test 数据）
-- 🔴 这两个**保留** namespace='test' 过滤：它们的职责就是把测试数据挡在生产之外，
--   与上面三个「不再按 ns 过滤」的视图语义不同，不要一并改掉。
CREATE VIEW IF NOT EXISTS v_conv_test AS
  SELECT * FROM conversations WHERE namespace = 'test';

CREATE VIEW IF NOT EXISTS v_mem_test AS
  SELECT * FROM memories WHERE namespace = 'test';

-- =====================================================================
-- 使用规则（CI lint 强制）：
--   storage/ 目录外出现 "FROM conversations" / "FROM memories" / "FROM episodes"
--   直接 lint 失败。必须走 v_conv_real / v_mem_real / v_ep_real。
--
-- ⚠️ 已知不一致（登记待修，不在本单范围）：
--   memarch-v2/retrieval/recall/ 下 bm25 / emotion_40d / semantic_vector 实际**直接查原表**
--   （`FROM fts_memories JOIN memories` / `FROM vec_*`）+ `AND m.namespace = @ns`，
--   与本条 lint 意图冲突。二者取舍（改腿走视图 vs 放宽 lint）需单独决策 —— 注意
--   改腿走视图反而会丢掉 namespace 隔离（视图已不再过滤 ns），故倾向放宽 lint。
-- =====================================================================
