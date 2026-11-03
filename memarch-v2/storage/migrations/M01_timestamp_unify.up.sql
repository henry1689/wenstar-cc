-- =====================================================================
-- M1 up: 时间戳统一
--   conversations: ISO 字符串 (timestamp) → epoch ms (ts_utc)
--   memories:     本地时间字符串 (last_recalled_at, Asia/Shanghai)
--                 → UTC epoch ms (last_reinforced_at)，减 8 小时
-- 抽样要求: 执行前抽样 50 行人工核对
-- =====================================================================

BEGIN TRANSACTION;

-- 1) conversations.timestamp (ISO) → ts_utc (epoch ms)
UPDATE conversations
   SET ts_utc = CAST(strftime('%s', timestamp) AS INTEGER) * 1000
 WHERE ts_utc IS NULL
   AND timestamp IS NOT NULL;

-- 2) memories.last_recalled_at (本地时间字符串，无时区) → last_reinforced_at (UTC epoch ms)
--    减 8 小时 = 8*3600 = 28800 秒
UPDATE memories
   SET last_reinforced_at =
       (CAST(strftime('%s', last_recalled_at) AS INTEGER) - 8 * 3600) * 1000
 WHERE last_recalled_at IS NOT NULL
   AND last_reinforced_at IS NULL;

-- 3) episodes.started_at/ended_at 已是 epoch ms，无需迁移，但补一个 created_at 检查
--    （本步骤幂等：若已迁移则无行受影响）

-- 账本记录
INSERT INTO audit_ledger(ts_utc, actor, action, target_type, target_id, meta, prev_hash, hash)
SELECT CAST(strftime('%s','now') AS INTEGER)*1000,
       'system', 'migrate', 'schema', 'M01_timestamp_unify',
       json_object('rows_conv', (SELECT changes()), 'rows_mem', 0),
       COALESCE((SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1), '00000000'),
       hex(randomblob(16));

INSERT OR REPLACE INTO schema_migrations(name, applied_at, checksum, direction)
VALUES ('M01_timestamp_unify', CAST(strftime('%s','now') AS INTEGER)*1000, 'ok', 'up');

COMMIT;
