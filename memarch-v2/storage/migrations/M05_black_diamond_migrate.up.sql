-- =====================================================================
-- M5 up: 黑钻旧表迁移
--   旧 black_diamond 表（内容表）→ 新 black_diamond_v2 指针表
--   旧表保留只读，通过视图兼容；新表只存引用（ref_type/ref_id）
--   对应 memories 设置 consolidated 状态（M3 步骤6 已部分处理）
-- =====================================================================

BEGIN TRANSACTION;

-- 🔴 2026-11-03 补（测试 test_migrations「M5 无旧表时应幂等跳过」暴露的真缺陷）：
--   原注释写「旧表若不存在则跳过」，但**下面从未实现**——直接 `FROM black_diamond bd`，
--   而 SQLite 在 **prepare 期**就解析表名 ⇒ 新库（v2 schema 无旧表）执行 M05 必抛
--   `no such table: black_diamond`。验收报告的 `+R ✅` 是在**有旧表的旧库**上跑的，
--   新库这条路径从未被覆盖。
--   为什么不能用条件判断绕开：`WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE ...)`
--   **救不了** —— 那只过滤行，`FROM black_diamond` 仍会在 prepare 期被解析并报错；
--   SQLite 没有语句级 IF EXISTS，纯 SQL 无法条件访问不存在的表。
--   故用 `IF NOT EXISTS` 兜底建**空**旧表：
--     · 旧库：真表已存在 ⇒ 不建，后续迁移真实数据（**行为零变化**）
--     · 新库：建 0 行空表 ⇒ 后续 INSERT SELECT 命中 0 行 ⇒ 幂等跳过（即注释承诺的语义）
--   副作用已核：`harness/schema_consistency_check.ts` 只断言「期望的表都在」、**不报多余表**；
--   空表 0 行、无任何读写消费方；down.sql 本就不碰旧表（只回滚 bdv2_ 指针与 memories 状态）。
--   旧表结构按历史约定: id, trace_id / episode_id, title, reason, created_at（与下方 SELECT 对齐）
CREATE TABLE IF NOT EXISTS black_diamond (
  id         INTEGER,
  trace_id   TEXT,
  episode_id TEXT,
  title      TEXT,
  reason     TEXT,
  created_at INTEGER
);

-- 旧表若不存在则跳过（新库无旧黑钻）—— 由上方 IF NOT EXISTS 兜底保证 FROM 有来源
-- 用 INSERT SELECT 兼容两种 ref_type
INSERT OR IGNORE INTO black_diamond_v2 (
  id, ref_type, ref_id, title, entry_channel, entry_reason,
  self_defining, user_confirmed, snapshot_hash, status, created_at
)
SELECT
  'bdv2_' || bd.id             AS id,
  CASE
    WHEN bd.episode_id IS NOT NULL THEN 'episode'
    ELSE 'trace'
  END                          AS ref_type,
  COALESCE(bd.episode_id, bd.trace_id) AS ref_id,
  bd.title,
  'auto'                       AS entry_channel,
  bd.reason                    AS entry_reason,
  NULL                         AS self_defining,
  1                            AS user_confirmed,   -- 旧黑钻默认已确认
  NULL                         AS snapshot_hash,
  'active'                     AS status,
  COALESCE(bd.created_at, CAST(strftime('%s','now') AS INTEGER)*1000) AS created_at
FROM black_diamond bd
WHERE NOT EXISTS (
  SELECT 1 FROM black_diamond_v2 v WHERE v.id = 'bdv2_' || bd.id
);

-- 同步对应 memories 的生命周期状态
UPDATE memories
   SET lifecycle_state = 'consolidated',
       consolidation = MAX(consolidation, 0.85)
 WHERE id IN (SELECT ref_id FROM black_diamond_v2 WHERE ref_type = 'trace' AND status = 'active');

-- 旧表转为只读（通过视图兼容，不再写入）
-- 注意：SQLite 不能直接给表加只读标记，但应用层必须停止写旧表

INSERT INTO audit_ledger(ts_utc, actor, action, target_type, target_id, meta, prev_hash, hash)
SELECT CAST(strftime('%s','now') AS INTEGER)*1000,
       'system', 'migrate', 'black_diamond', 'M05_black_diamond',
       json_object(
         'migrated_pointers', (SELECT COUNT(*) FROM black_diamond_v2)
       ),
       COALESCE((SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1), '00000000'),
       hex(randomblob(16));

INSERT OR REPLACE INTO schema_migrations(name, applied_at, checksum, direction)
VALUES ('M05_black_diamond', CAST(strftime('%s','now') AS INTEGER)*1000, 'ok', 'up');

COMMIT;
