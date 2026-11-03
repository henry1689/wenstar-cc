-- =====================================================================
-- M2 up: 修复 is_summary 误标
-- 问题: compactAlluvial 产生的行同时 is_summary=1 AND is_compacted=1，
--       它们本来是原文，被误标为摘要。
-- 规则: 真正的摘要行一般 is_compacted=0 或 NULL，且内容带摘要特征。
-- 回滚: 受影响行备份到 _m2_backup（持久表），down 时恢复。
-- =====================================================================

BEGIN TRANSACTION;

-- 持久化备份（不使用 TEMP 表，保证 down 可回滚）
DROP TABLE IF EXISTS _m2_backup;
CREATE TABLE _m2_backup AS
SELECT id, is_summary AS old_is_summary FROM conversations
 WHERE is_summary = 1 AND is_compacted = 1;

-- 修复
UPDATE conversations
   SET is_summary = 0
 WHERE is_summary = 1 AND is_compacted = 1;

INSERT INTO audit_ledger(ts_utc, actor, action, target_type, target_id, meta, prev_hash, hash)
SELECT CAST(strftime('%s','now') AS INTEGER)*1000,
       'system', 'migrate', 'conversation', 'M02_is_summary_fix',
       json_object('fixed_rows', (SELECT COUNT(*) FROM _m2_backup)),
       COALESCE((SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1), '00000000'),
       hex(randomblob(16));

INSERT OR REPLACE INTO schema_migrations(name, applied_at, checksum, direction)
VALUES ('M02_is_summary_fix', CAST(strftime('%s','now') AS INTEGER)*1000, 'ok', 'up');

COMMIT;
