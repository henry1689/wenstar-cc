-- =====================================================================
-- M3 up: 钙化分归一（最关键迁移）
-- 原则: 能重算就重算，不能重算才推断
--   1) calcium_legacy = calcium_score（留档，只读）
--   2) 有 perception 快照 → c = κ · S(显著性)  [首选，彻底消除量纲歧义]
--   3) 否则按时代推断原始量纲：
--        - 0-1 量纲 → 原值
--        - 1-5 量纲 → (x-1)/4
--        - 5-10 量纲 → (x-5)/5
--      再乘 κ=0.6 并截断到 [0, 0.6]
--   4) 按 recall_count 补偿：回放 min(recall_count,10) 次，g=0.5
--   5) 无法判定 → c=0.3, migration_ambiguous=1, 写账本
--   6) 已在 black_diamond → 直接 consolidated
-- 迁移安全:
--   - 迁移后对比 expiring 数量 > 总量 5% 则暂停
--   - 原始列 calcium_score 保留只读两个版本周期
-- =====================================================================

BEGIN TRANSACTION;

-- 迁移期标记列 migration_ambiguous 已在 01_schema_init.sql 中定义，此处不再 ALTER

-- 步骤 1: 留档
UPDATE memories SET calcium_legacy = calcium_score WHERE calcium_legacy IS NULL;

-- 步骤 2-4: 量纲推断 + 回放
-- 注：SQLite 没有循环回放，用渐近近似公式：c_final ≈ c_init * (1 - exp(-recall_count * g))
--     其中 g=0.5，κ=0.6
UPDATE memories
   SET consolidation = CASE
        -- 首选：有 salience 快照
        WHEN salience IS NOT NULL AND salience > 0 THEN
          MIN(0.6, MAX(0.0, 0.6 * salience))
          * (1 - exp(-MIN(COALESCE(recall_count,0), 10) * 0.5))

        -- 0-1 量纲（v27 之后，calcium_score 在 [0,1]）
        WHEN calcium_score BETWEEN 0 AND 1 THEN
          MIN(0.6, MAX(0.0, 0.6 * calcium_score))
          * (1 - exp(-MIN(COALESCE(recall_count,0), 10) * 0.5))

        -- 1-5 量纲（早期旧库）
        WHEN calcium_score BETWEEN 1 AND 5 THEN
          MIN(0.6, MAX(0.0, 0.6 * (calcium_score - 1) / 4.0))
          * (1 - exp(-MIN(COALESCE(recall_count,0), 10) * 0.5))

        -- 5-10 量纲
        WHEN calcium_score BETWEEN 5 AND 10 THEN
          MIN(0.6, MAX(0.0, 0.6 * (calcium_score - 5) / 5.0))
          * (1 - exp(-MIN(COALESCE(recall_count,0), 10) * 0.5))

        -- 无法判定
        ELSE 0.3
      END,
      migration_ambiguous = CASE
        WHEN calcium_score IS NULL AND salience IS NULL THEN 1
        WHEN calcium_score NOT BETWEEN 0 AND 10 THEN 1
        ELSE 0
      END
 WHERE consolidation = 0 OR consolidation IS NULL;

-- 步骤 6: 已在 black_diamond 的 → 直接 consolidated
UPDATE memories
   SET lifecycle_state = 'consolidated',
       consolidation = MAX(consolidation, 0.85)
 WHERE id IN (SELECT ref_id FROM black_diamond_v2 WHERE ref_type = 'trace' AND status = 'active');

-- 安全校验：expiring 数量 > 总量 5% 则 RAISE
-- （这里不强制 RAISE，由迁移程序读取下面临时表判断）
DROP TABLE IF EXISTS _m3_health_check;
CREATE TABLE _m3_health_check AS
SELECT
  (SELECT COUNT(*) FROM memories) AS total,
  (SELECT COUNT(*) FROM memories WHERE lifecycle_state = 'expiring') AS expiring,
  (SELECT COUNT(*) FROM memories WHERE migration_ambiguous = 1) AS ambiguous;

INSERT INTO audit_ledger(ts_utc, actor, action, target_type, target_id, meta, prev_hash, hash)
SELECT CAST(strftime('%s','now') AS INTEGER)*1000,
       'system', 'migrate', 'memory', 'M03_calcium_normalize',
       json_object(
         'ambiguous_rows', (SELECT ambiguous FROM _m3_health_check),
         'expiring_rows', (SELECT expiring FROM _m3_health_check),
         'total_rows',     (SELECT total FROM _m3_health_check),
         'threshold',      0.05
       ),
       COALESCE((SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1), '00000000'),
       hex(randomblob(16));

INSERT OR REPLACE INTO schema_migrations(name, applied_at, checksum, direction)
VALUES ('M03_calcium_normalize', CAST(strftime('%s','now') AS INTEGER)*1000, 'ok', 'up');

COMMIT;

-- 健康检查（迁移程序应读取 _m3_health_check，若 expiring/total > 5% 则暂停）
SELECT * FROM _m3_health_check;
