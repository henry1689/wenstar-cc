-- =====================================================================
-- MemArch-v2.0.0 / M1-Storage / M00_baseline_snapshot.sql
-- 迁移前置：VACUUM INTO 全库快照（Windows 路径，按业主约定 D 盘）
-- 用法: sqlite3 memarch.db < storage/migrations/M00_baseline_snapshot.sql
-- =====================================================================

-- 快照（VACUUM INTO 是 SQLite 3.27+ 原子全库备份）
VACUUM INTO 'D:/tools/wenstar-cc/data/snapshots/memarch_pre_m1_v2_20261103.db';

-- 在主库记录本次迁移起点
INSERT OR REPLACE INTO schema_migrations(name, applied_at, checksum, direction)
VALUES ('M00_snapshot', CAST(strftime('%s','now') AS INTEGER)*1000, 'pre_m1', 'up');
