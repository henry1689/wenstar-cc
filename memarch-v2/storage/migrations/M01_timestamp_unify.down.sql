-- =====================================================================
-- M1 down: 时间戳统一回滚
-- 说明：原始 timestamp 列从未删除，物理回滚推荐直接用 M00 快照恢复。
--       本脚本仅做"逻辑回滚"——将派生列置 NULL 并清除迁移标记，
--       使下次 up 可重跑。**不可恢复已被业务代码改写的 ts_utc**。
-- =====================================================================

BEGIN TRANSACTION;

-- 回滚派生列（保留原始 timestamp 字符串列不动）
UPDATE conversations SET ts_utc = NULL WHERE ts_utc IS NOT NULL;
UPDATE memories      SET last_reinforced_at = NULL WHERE last_reinforced_at IS NOT NULL;

DELETE FROM schema_migrations WHERE name = 'M01_timestamp_unify';

INSERT INTO audit_ledger(ts_utc, actor, action, target_type, target_id, meta, prev_hash, hash)
SELECT CAST(strftime('%s','now') AS INTEGER)*1000,
       'system', 'migrate_rollback', 'schema', 'M01_timestamp_unify',
       json_object('note', 'logical rollback; use M00 snapshot for physical rollback'),
       COALESCE((SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1), '00000000'),
       hex(randomblob(16));

COMMIT;
