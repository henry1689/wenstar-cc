-- =====================================================================
-- M4 up: 激活历史回填
--   n_refs = 1 + recall_count
--   first_ref_at = created_at
--   recent_refs = JSON 数组 [last_recalled_at 的 epoch ms]
--   last_reinforced_at = 已由 M1 回填
-- =====================================================================

BEGIN TRANSACTION;

UPDATE memories
   SET n_refs = 1 + COALESCE(recall_count, 0),
       first_ref_at = COALESCE(first_ref_at, created_at),
       recent_refs = CASE
         WHEN recent_refs IS NULL AND last_reinforced_at IS NOT NULL
         THEN json_array(last_reinforced_at)
         WHEN recent_refs IS NULL
         THEN '[]'
         ELSE recent_refs
       END
 WHERE n_refs = 1 OR n_refs IS NULL;

INSERT INTO audit_ledger(ts_utc, actor, action, target_type, target_id, meta, prev_hash, hash)
SELECT CAST(strftime('%s','now') AS INTEGER)*1000,
       'system', 'migrate', 'memory', 'M04_activation_backfill',
       json_object('rows_backfilled', (SELECT COUNT(*) FROM memories WHERE n_refs > 1)),
       COALESCE((SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1), '00000000'),
       hex(randomblob(16));

INSERT OR REPLACE INTO schema_migrations(name, applied_at, checksum, direction)
VALUES ('M04_activation_backfill', CAST(strftime('%s','now') AS INTEGER)*1000, 'ok', 'up');

COMMIT;
