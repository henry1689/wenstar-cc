-- =====================================================================
-- M4 down: 激活历史回填回滚
-- =====================================================================

BEGIN TRANSACTION;

UPDATE memories
   SET n_refs = 1,
       first_ref_at = NULL,
       recent_refs = NULL;

DELETE FROM schema_migrations WHERE name = 'M04_activation_backfill';

INSERT INTO audit_ledger(ts_utc, actor, action, target_type, target_id, meta, prev_hash, hash)
SELECT CAST(strftime('%s','now') AS INTEGER)*1000,
       'system', 'migrate_rollback', 'memory', 'M04_activation_backfill',
       json_object('note', 'n_refs reset to 1'),
       COALESCE((SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1), '00000000'),
       hex(randomblob(16));

COMMIT;
