-- =====================================================================
-- M5 down: 黑钻迁移回滚
--   删除本次生成的 bdv2_ 前缀指针，memories 状态退回
--   旧 black_diamond 表本身从未被修改，无需恢复
-- =====================================================================

BEGIN TRANSACTION;

-- 退回被标记为 consolidated 的 trace（保守：回到 fresh）
UPDATE memories
   SET lifecycle_state = 'fresh',
       consolidation = MIN(consolidation, 0.6)
 WHERE id IN (
   SELECT ref_id FROM black_diamond_v2
   WHERE ref_type = 'trace' AND id LIKE 'bdv2\_%' ESCAPE '\'
 );

DELETE FROM black_diamond_v2 WHERE id LIKE 'bdv2\_%' ESCAPE '\';

DELETE FROM schema_migrations WHERE name = 'M05_black_diamond';

INSERT INTO audit_ledger(ts_utc, actor, action, target_type, target_id, meta, prev_hash, hash)
SELECT CAST(strftime('%s','now') AS INTEGER)*1000,
       'system', 'migrate_rollback', 'black_diamond', 'M05_black_diamond',
       json_object('note', 'bdv2_ prefixed pointers removed; legacy table untouched'),
       COALESCE((SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1), '00000000'),
       hex(randomblob(16));

COMMIT;
