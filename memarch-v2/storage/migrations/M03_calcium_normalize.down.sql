-- =====================================================================
-- M3 down: 钙化分归一回滚
-- 说明: 物理回滚强烈推荐 M00 快照。本脚本做逻辑回滚：
--       consolidation 清零、migration_ambiguous 清零、black_diamond 关联恢复。
-- =====================================================================

BEGIN TRANSACTION;

UPDATE memories
   SET consolidation = 0,
       migration_ambiguous = 0
 WHERE consolidation IS NOT NULL;

-- black_diamond 关联过的生命周期状态退回（保守：回到 fresh）
UPDATE memories
   SET lifecycle_state = 'fresh'
 WHERE id IN (SELECT ref_id FROM black_diamond_v2 WHERE ref_type = 'trace');

DROP TABLE IF EXISTS _m3_health_check;
DELETE FROM schema_migrations WHERE name = 'M03_calcium_normalize';

INSERT INTO audit_ledger(ts_utc, actor, action, target_type, target_id, meta, prev_hash, hash)
SELECT CAST(strftime('%s','now') AS INTEGER)*1000,
       'system', 'migrate_rollback', 'memory', 'M03_calcium_normalize',
       json_object('note', 'logical rollback; calcium_legacy preserved'),
       COALESCE((SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1), '00000000'),
       hex(randomblob(16));

COMMIT;
