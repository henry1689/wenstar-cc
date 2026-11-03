-- =====================================================================
-- M2 down: 从 _m2_backup 恢复 is_summary
-- =====================================================================

BEGIN TRANSACTION;

UPDATE conversations
   SET is_summary = (SELECT old_is_summary FROM _m2_backup WHERE _m2_backup.id = conversations.id)
 WHERE id IN (SELECT id FROM _m2_backup);

DROP TABLE IF EXISTS _m2_backup;
DELETE FROM schema_migrations WHERE name = 'M02_is_summary_fix';

INSERT INTO audit_ledger(ts_utc, actor, action, target_type, target_id, meta, prev_hash, hash)
SELECT CAST(strftime('%s','now') AS INTEGER)*1000,
       'system', 'migrate_rollback', 'conversation', 'M02_is_summary_fix',
       json_object('note', 'restored from _m2_backup'),
       COALESCE((SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1), '00000000'),
       hex(randomblob(16));

COMMIT;
