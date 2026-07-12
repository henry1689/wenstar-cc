/**
 * MigrationManager — 数据库迁移管理器
 *
 * 统一管理 fusion_memory.db 的 Schema 版本迁移。
 * 每次 DDL 变更记录到 schema_version 表，支持增量迁移。
 *
 * 设计原则：
 * - 幂等：重复执行不损坏数据（基于版本号跳过已执行迁移）
 * - 可追溯：每次迁移记录版本号、描述、时间、checksum
 * - 最小侵入：迁移在 SQLiteAdapter.initialize() 中触发，不阻塞启动
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MigrationRecord {
  version: number;
  description: string;
  migrated_at: string;
  checksum: string;
}

// ═══════════════════════════════════════════
// 迁移注册表 — 按版本号递增排列
// ═══════════════════════════════════════════

interface Migration {
  version: number;
  description: string;
  apply: (db: any) => void; // sql.js Database
}

const MIGRATIONS: Migration[] = [
  // v1 → v2: 编码链路 + 基建标准化
  {
    version: 2,
    description: '新增 dna_full_code/l2_norm 字段，统一黑钻晋升路径',
    apply: (db: any) => {
      // memories
      try { db.run("ALTER TABLE memories ADD COLUMN dna_full_code TEXT"); } catch {}
      try { db.run("ALTER TABLE memories ADD COLUMN l2_norm REAL"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memories_dna_full_code ON memories(dna_full_code)"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memories_l2_norm ON memories(l2_norm)"); } catch {}

      // black_diamond
      try { db.run("ALTER TABLE black_diamond ADD COLUMN dna_root_id TEXT"); } catch {}
      try { db.run("ALTER TABLE black_diamond ADD COLUMN dna_full_code TEXT"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_black_diamond_dna_root_id ON black_diamond(dna_root_id)"); } catch {}
    },
  },
  // v3: 时空环境规则引擎 — 时序事件 + 气象数据
  {
    version: 3,
    description: '新增 temporal_events / ambient_weather_context 表',
    apply: (db: any) => {
      try {
        db.run(`CREATE TABLE IF NOT EXISTS temporal_events (
          event_id TEXT PRIMARY KEY, belong_entity_id TEXT NOT NULL,
          event_type TEXT NOT NULL, parent_event_id TEXT DEFAULT NULL,
          event_raw_text TEXT NOT NULL, start_ts INTEGER NOT NULL,
          end_ts INTEGER DEFAULT NULL, cycle_ms INTEGER DEFAULT 0,
          max_nest_level TINYINT DEFAULT 3, is_cyclic BOOLEAN DEFAULT 0,
          source_mode TEXT DEFAULT 'chat_llm', source_url TEXT DEFAULT NULL,
          dna_root_id TEXT NOT NULL, status TEXT DEFAULT 'running',
          create_at INTEGER NOT NULL
        )`);
        db.run("CREATE INDEX IF NOT EXISTS idx_temporal_events_entity_status ON temporal_events(belong_entity_id, status)");
        db.run("CREATE INDEX IF NOT EXISTS idx_temporal_events_end_ts ON temporal_events(end_ts)");
      } catch (e) { console.warn('[Migration] temporal_events 表创建失败:', e); }
      try {
        db.run(`CREATE TABLE IF NOT EXISTS ambient_weather_context (
          weather_id TEXT PRIMARY KEY, belong_area TEXT NOT NULL,
          weather_type TEXT NOT NULL, temperature_low INTEGER,
          temperature_high INTEGER, weather_desc TEXT,
          alert_info TEXT DEFAULT NULL, minute_precip TEXT DEFAULT NULL,
          start_ts INTEGER NOT NULL, end_ts INTEGER DEFAULT NULL,
          source_mode TEXT DEFAULT 'qweather_api',
          source_url TEXT DEFAULT NULL, api_last_update_ts INTEGER DEFAULT 0,
          dna_root_id TEXT NOT NULL, status TEXT DEFAULT 'effective',
          create_at INTEGER NOT NULL
        )`);
        db.run("CREATE INDEX IF NOT EXISTS idx_ambient_weather_time ON ambient_weather_context(start_ts, end_ts)");
        db.run("CREATE INDEX IF NOT EXISTS idx_ambient_weather_source ON ambient_weather_context(source_mode)");
      } catch (e) { console.warn('[Migration] ambient_weather_context 表创建失败:', e); }
    },
  },
  // v4: 双螺旋存储三底座 — state_spines + atom_address_timeline + atom_repair_index
  //     适配: DNA双螺旋编码规范V2.0 / 大一统架构V1.0 / 天权底座V1.0
  {
    version: 4,
    description: '双螺旋存储三底座 — 语义向量分片库+寻址治理存储池+修复索引表',
    apply: (db: any) => {
      // ── 底座1: 语义向量分片库 (HNSW 网状索引, 蓝皮书 §3.1) ──
      try {
        db.run(`CREATE TABLE IF NOT EXISTS state_spines (
          global_uid          TEXT NOT NULL,
          dimension_id        INTEGER NOT NULL CHECK(dimension_id BETWEEN 1 AND 32),
          value               REAL NOT NULL,
          consistency_mark    TEXT NOT NULL DEFAULT 'consistent',
          location_fingerprint TEXT,
          timestamp_ms        INTEGER NOT NULL,
          checksum            TEXT,
          dna_branch          BLOB,
          PRIMARY KEY (global_uid, dimension_id)
        ) WITHOUT ROWID`);
        db.run("CREATE INDEX IF NOT EXISTS idx_spines_dim ON state_spines(dimension_id, timestamp_ms)");
      } catch (e) { console.warn('[Migration] state_spines 创建失败:', e); }

      // ── 底座2: 寻址治理存储池 (B+Tree 线性时序索引, 蓝皮书 §3.2) ──
      try {
        db.run(`CREATE TABLE IF NOT EXISTS atom_address_timeline (
          global_uid          TEXT PRIMARY KEY,
          global_time_seq     INTEGER NOT NULL,
          absolute_timestamp  INTEGER NOT NULL,
          time_slice_tag      TEXT NOT NULL,
          vine_group_id       TEXT,
          entity_belong_id    TEXT,
          event_branch_id     TEXT,
          route_stamp_list    BLOB,
          hot_cold_level      TEXT DEFAULT 'W',
          crc_checksum        TEXT NOT NULL,
          state_flag          TEXT DEFAULT 'N',
          created_at          INTEGER NOT NULL DEFAULT (unixepoch())
        ) WITHOUT ROWID`);
        db.run("CREATE INDEX IF NOT EXISTS idx_atl_ts      ON atom_address_timeline(absolute_timestamp)");
        db.run("CREATE INDEX IF NOT EXISTS idx_atl_group   ON atom_address_timeline(vine_group_id)");
        db.run("CREATE INDEX IF NOT EXISTS idx_atl_entity  ON atom_address_timeline(entity_belong_id)");
        db.run("CREATE INDEX IF NOT EXISTS idx_atl_slice   ON atom_address_timeline(time_slice_tag)");
      } catch (e) { console.warn('[Migration] atom_address_timeline 创建失败:', e); }

      // ── 底座3: 原子修复索引表 (海胆断裂重组, 蓝皮书 §3.2) ──
      try {
        db.run(`CREATE TABLE IF NOT EXISTS atom_repair_index (
          global_uid              TEXT PRIMARY KEY,
          spine_storage_position  TEXT NOT NULL DEFAULT '',
          flesh_storage_position  TEXT NOT NULL DEFAULT '',
          last_verified_at        INTEGER NOT NULL DEFAULT (unixepoch()),
          repair_count            INTEGER DEFAULT 0,
          FOREIGN KEY (global_uid) REFERENCES atom_address_timeline(global_uid)
        ) WITHOUT ROWID`);
      } catch (e) { console.warn('[Migration] atom_repair_index 创建失败:', e); }

      // ── 底座隔离纪律（日志输出供运营确认） ──
      try {
        console.log('[Migration] v4 ✅ 双螺旋三底座已就绪');
        console.log('  🔴 纪律: state_spines 仅HNSW — 禁止时序排序');
        console.log('  🔴 纪律: atom_address_timeline 仅B+Tree+倒排 — 禁止存语义向量');
        console.log('  🔴 纪律: 原始数据层 — 禁止直接做语义检索');
        console.log('  🔴 纪律: 三底座仅通过 GlobalUID 关联');
      } catch (e) { /* 日志不影响迁移 */ }
    },
  },
  // v5: memories 表补全局字段 — global_uid + location_fingerprint (蓝皮书 §3.1-3.3)
  {
    version: 5,
    description: 'memories 表新增 global_uid / location_fingerprint 字段',
    apply: (db: any) => {
      try { db.run("ALTER TABLE memories ADD COLUMN global_uid TEXT"); } catch {}
      try { db.run("ALTER TABLE memories ADD COLUMN location_fingerprint TEXT"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memories_global_uid ON memories(global_uid)"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memories_loc_fp ON memories(location_fingerprint)"); } catch {}
      console.log('[Migration] v5 ✅ memories+global_uid+location_fingerprint');
    },
  },
  // v6: conversations 表补全局字段
  {
    version: 6,
    description: 'conversations 表新增 global_uid / location_fingerprint 字段',
    apply: (db: any) => {
      try { db.run("ALTER TABLE conversations ADD COLUMN global_uid TEXT"); } catch {}
      try { db.run("ALTER TABLE conversations ADD COLUMN location_fingerprint TEXT"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_conv_global_uid ON conversations(global_uid)"); } catch {}
      console.log('[Migration] v6 ✅ conversations+global_uid+location_fingerprint');
    },
  },
];

// ═══════════════════════════════════════════
// 迁移执行引擎
// ═══════════════════════════════════════════

/**
 * 执行所有待执行的迁移
 * @param db sql.js Database 实例
 * @returns 本次执行的迁移数
 */
export function migrateSchema(db: any): number {
  // 确保 schema_version 表存在
  try {
    db.run(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      migrated_at TEXT NOT NULL,
      checksum TEXT
    )`);
  } catch (err) {
    console.warn('[Migration] schema_version 表创建失败:', err);
    return 0;
  }

  // 读取当前版本
  const currentVersion = getCurrentVersion(db);
  let executed = 0;

  for (const m of MIGRATIONS) {
    if (m.version > currentVersion) {
      try {
        const checksum = computeChecksum(m.description);
        m.apply(db);
        const now = new Date().toISOString();
        db.run(
          'INSERT INTO schema_version (version, description, migrated_at, checksum) VALUES (?, ?, ?, ?)',
          [m.version, m.description, now, checksum],
        );
        executed++;
        console.log(`[Migration] v${m.version} ✅: ${m.description}`);
      } catch (err) {
        console.error(`[Migration] v${m.version} ❌ 失败:`, err);
        throw err;
      }
    }
  }

  if (executed === 0) {
    console.log(`[Migration] Schema v${currentVersion} 已最新，无需迁移`);
  }
  return executed;
}

function getCurrentVersion(db: any): number {
  try {
    const rows = db.exec('SELECT MAX(version) as v FROM schema_version');
    if (rows.length > 0 && rows[0].values.length > 0) {
      return rows[0].values[0][0] ?? 0;
    }
  } catch { /* 首次迁移，schema_version 为空 */ }
  return 0;
}

function computeChecksum(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}
