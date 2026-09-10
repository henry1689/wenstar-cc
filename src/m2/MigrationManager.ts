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
// C3(2026-09-11): 实体名解析收口到 EntityNameCodec（唯一事实源）
import { parseNames } from './EntityNameCodec.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PERCEPTION_40D_ENCODING_VERSION } from './PerceptionVector40DCodec.js';

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
  // V4.0: 双脑架构 — 第二大脑→第一大脑同步
  {
    version: 7,
    description: 'V4.0 第二大脑同步: memories.source_type + black_diamond V4字段 + source_tracking',
    apply: (db: any) => {
      // memories 表: 加 source_type 区分来源
      try { db.run("ALTER TABLE memories ADD COLUMN source_type TEXT DEFAULT 'conversation'"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memories_source_type ON memories(source_type)"); } catch {}

      // black_diamond 表: 加 V4 增强字段
      try { db.run("ALTER TABLE black_diamond ADD COLUMN entry_channel TEXT DEFAULT 'auto'"); } catch {}
      try { db.run("ALTER TABLE black_diamond ADD COLUMN entry_reason TEXT"); } catch {}
      try { db.run("ALTER TABLE black_diamond ADD COLUMN stabilization_score REAL DEFAULT 1.0"); } catch {}
      try { db.run("ALTER TABLE black_diamond ADD COLUMN manual_quota_consumed INTEGER DEFAULT 0"); } catch {}
      try { db.run("ALTER TABLE black_diamond ADD COLUMN status TEXT DEFAULT 'active'"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_bd_status ON black_diamond(status)"); } catch {}

      // source_tracking 表: MD源文件→记忆条目溯源
      try {
        db.run(`CREATE TABLE IF NOT EXISTS source_tracking (
          id TEXT PRIMARY KEY,
          source_path TEXT NOT NULL,
          source_uuid TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          synced_at TEXT NOT NULL DEFAULT (datetime('now')),
          status TEXT NOT NULL DEFAULT 'active'
        )`);
        db.run("CREATE INDEX IF NOT EXISTS idx_st_source_path ON source_tracking(source_path)");
        db.run("CREATE INDEX IF NOT EXISTS idx_st_memory_id ON source_tracking(memory_id)");
        db.run("CREATE INDEX IF NOT EXISTS idx_st_status ON source_tracking(status)");
      } catch (e) { console.warn('[Migration] source_tracking 表创建失败:', e); }

      console.log('[Migration] v7 ✅ V4.0 第二大脑同步字段');
    },
  },
  // V13.0: DAG 网状记忆骨架 — 内存关联有向边表
  {
    version: 8,
    description: 'V13.0 DAG 记忆关联: memory_associations + dag_retrieval_log',
    apply: (db: any) => {
      db.run(`CREATE TABLE IF NOT EXISTS memory_associations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL DEFAULT 'default',
        belong_entity_uuid TEXT NOT NULL,
        source_global_uid TEXT NOT NULL,
        target_global_uid TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        edge_reason TEXT,
        confidence REAL NOT NULL DEFAULT 0.7,
        weight REAL NOT NULL DEFAULT 1.0,
        source_timestamp_ms INTEGER NOT NULL,
        target_timestamp_ms INTEGER NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'system',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        state_flag TEXT NOT NULL DEFAULT 'active',
        CHECK (confidence >= 0.0 AND confidence <= 1.0),
        CHECK (weight >= 0.0),
        CHECK (source_timestamp_ms < target_timestamp_ms)
      )`);
      try { db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_assoc_unique ON memory_associations(namespace, belong_entity_uuid, source_global_uid, target_global_uid, edge_type)"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memory_assoc_source ON memory_associations(namespace, belong_entity_uuid, source_global_uid, edge_type, confidence)"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memory_assoc_target ON memory_associations(namespace, belong_entity_uuid, target_global_uid, edge_type, confidence)"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memory_assoc_entity ON memory_associations(namespace, belong_entity_uuid, edge_type, confidence)"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memory_assoc_time ON memory_associations(namespace, belong_entity_uuid, source_timestamp_ms, target_timestamp_ms)"); } catch {}

      db.run(`CREATE TABLE IF NOT EXISTS dag_retrieval_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_hash TEXT NOT NULL,
        seed_uids TEXT NOT NULL,
        expanded_uids TEXT NOT NULL,
        hop_count INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      console.log('[Migration] v8 ✅ DAG 记忆关联表');
    },
  },
  // V13.0: Foresight 前瞻时态字段 — memories 表标记计划/承诺/预测类记忆
  {
    version: 9,
    description: 'V13.0 Foresight 时效: memories.is_foresight + valid_start_ms + valid_until_ms + foresight_status',
    apply: (db: any) => {
      try { db.run("ALTER TABLE memories ADD COLUMN is_foresight INTEGER NOT NULL DEFAULT 0"); } catch {}
      try { db.run("ALTER TABLE memories ADD COLUMN valid_start_ms INTEGER"); } catch {}
      try { db.run("ALTER TABLE memories ADD COLUMN valid_until_ms INTEGER"); } catch {}
      try { db.run("ALTER TABLE memories ADD COLUMN foresight_status TEXT NOT NULL DEFAULT 'none'"); } catch {}
      try { db.run("ALTER TABLE memories ADD COLUMN foresight_reason TEXT"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memories_foresight_time ON memories(is_foresight, valid_start_ms, valid_until_ms)"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_memories_foresight_status ON memories(foresight_status)"); } catch {}
      console.log('[Migration] v9 ✅ Foresight 时效字段');
    },
  },
  // 紧急修复: search_index 倒排表从未创建 (n-gram 粗筛层一直空跑)
  {
    version: 10,
    description: '紧急修复: search_index 倒排表 + 存量回填 (n-gram粗筛虚设 → 真实可用)',
    apply: (db: any) => {
      db.run(`CREATE TABLE IF NOT EXISTS search_index (
        term TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        belong_entity_uuid TEXT,
        position INTEGER DEFAULT 0,
        PRIMARY KEY (term, source_type, source_id)
      )`);
      try { db.run("CREATE INDEX IF NOT EXISTS idx_search_term ON search_index(term)"); } catch {}
      try { db.run("CREATE INDEX IF NOT EXISTS idx_search_source ON search_index(source_type, source_id)"); } catch {}

      // 存量回填: 所有 memories + conversations + black_diamond + knowledge_base
      console.log('[Migration] v10 开始存量 n-gram 回填...');
      let rebuilt = 0;

      // memories
      try {
        const rows = db.exec("SELECT id, raw_input FROM memories WHERE raw_input IS NOT NULL");
        if (rows.length && rows[0].values) {
          for (const [id, text] of rows[0].values) {
            if (!text) continue;
            const cleaned = String(text).replace(/[，。！？、；：""''（）《》【】\s\d-]/g, '').trim();
            if (cleaned.length < 2) continue;
            const ngrams = new Set<string>();
            for (let i = 0; i < cleaned.length - 1; i++) ngrams.add(cleaned.substring(i, i + 2));
            for (let i = 0; i < cleaned.length - 2; i++) ngrams.add(cleaned.substring(i, i + 3));
            for (const gram of ngrams) {
              try { db.run("INSERT OR IGNORE INTO search_index(term, source_type, source_id) VALUES(?,?,?)", [gram, 'memory', String(id)]); rebuilt++; } catch {}
            }
          }
        }
      } catch (e) { console.warn('[Migration] v10 memories 回填失败:', e); }
      console.log(`[Migration] v10 memories 回填: ${rebuilt} 条 n-gram`);

      // conversations
      let convRebuilt = 0;
      try {
        const rows = db.exec("SELECT id, content FROM conversations WHERE content IS NOT NULL");
        if (rows.length && rows[0].values) {
          for (const [id, text] of rows[0].values) {
            if (!text) continue;
            const cleaned = String(text).replace(/[，。！？、；：""''（）《》【】\s\d-]/g, '').trim();
            if (cleaned.length < 2) continue;
            const ngrams = new Set<string>();
            for (let i = 0; i < cleaned.length - 1; i++) ngrams.add(cleaned.substring(i, i + 2));
            for (let i = 0; i < cleaned.length - 2; i++) ngrams.add(cleaned.substring(i, i + 3));
            for (const gram of ngrams) {
              try { db.run("INSERT OR IGNORE INTO search_index(term, source_type, source_id) VALUES(?,?,?)", [gram, 'conversation', String(id)]); convRebuilt++; } catch {}
            }
          }
        }
      } catch (e) { console.warn('[Migration] v10 conversations 回填失败:', e); }
      rebuilt += convRebuilt;

      // knowledge_base
      let kbRebuilt = 0;
      try {
        const rows = db.exec("SELECT id, content FROM knowledge_base WHERE content IS NOT NULL");
        if (rows.length && rows[0].values) {
          for (const [id, text] of rows[0].values) {
            if (!text) continue;
            const cleaned = String(text).replace(/[，。！？、；：""''（）《》【】\s\d-]/g, '').trim();
            if (cleaned.length < 2) continue;
            const ngrams = new Set<string>();
            for (let i = 0; i < cleaned.length - 1; i++) ngrams.add(cleaned.substring(i, i + 2));
            for (let i = 0; i < cleaned.length - 2; i++) ngrams.add(cleaned.substring(i, i + 3));
            for (const gram of ngrams) {
              try { db.run("INSERT OR IGNORE INTO search_index(term, source_type, source_id) VALUES(?,?,?)", [gram, 'knowledge_base', String(id)]); kbRebuilt++; } catch {}
            }
          }
        }
      } catch (e) { console.warn('[Migration] v10 knowledge_base 回填失败:', e); }
      rebuilt += kbRebuilt;

      console.log(`[Migration] v10 ✅ search_index 建表 + 存量回填共 ${rebuilt} 条 n-gram`);
    },
  },
  // V21: state_spines 放宽 dimension_id CHECK 1-32 → 1-40（40D 统一）
  {
    version: 11,
    description: 'V21 40D: state_spines dimension_id CHECK 放宽 1-32 → 1-40（重建表）',
    apply: (db: any) => {
      try {
        // SQLite 无法 ALTER CHECK 约束 → 重建表（新建 1-40 约束 → 复制 → 删旧 → 改名）
        db.run('ALTER TABLE state_spines RENAME TO state_spines_old');
        db.run(`CREATE TABLE state_spines (
          global_uid          TEXT NOT NULL,
          dimension_id        INTEGER NOT NULL CHECK(dimension_id BETWEEN 1 AND 40),
          value               REAL NOT NULL,
          consistency_mark    TEXT NOT NULL DEFAULT 'consistent',
          location_fingerprint TEXT,
          timestamp_ms        INTEGER NOT NULL,
          checksum            TEXT,
          dna_branch          BLOB,
          PRIMARY KEY (global_uid, dimension_id)
        ) WITHOUT ROWID`);
        db.run('INSERT INTO state_spines (global_uid, dimension_id, value, consistency_mark, location_fingerprint, timestamp_ms, checksum, dna_branch) SELECT global_uid, dimension_id, value, consistency_mark, location_fingerprint, timestamp_ms, checksum, dna_branch FROM state_spines_old');
        db.run('DROP TABLE state_spines_old');
        db.run('CREATE INDEX IF NOT EXISTS idx_spines_dim ON state_spines(dimension_id, timestamp_ms)');
        console.log('[Migration] v11 ✅ state_spines CHECK 放宽到 1-40');
      } catch (e) { console.warn('[Migration] v11 state_spines 重建失败:', e); }
    },
  },
  {
    version: 12,
    description: 'V22 作品召回: 新建 works 表 + memories/conversations 加 work_id 列（长文召回元数据桥）',
    apply: (db: any) => {
      try {
        // works 表（作品一级实体）
        db.run(`CREATE TABLE IF NOT EXISTS works (
          work_id         TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          work_type       TEXT NOT NULL DEFAULT 'story',
          first_sentence  TEXT,
          summary         TEXT,
          full_text       TEXT,
          belong_entity_uuid TEXT,
          dna_root_id     TEXT,
          source_conversation_ids TEXT,
          dialog_group_id TEXT,
          semantic_vector TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_works_created ON works(created_at DESC)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_works_owner ON works(belong_entity_uuid)`);
        // 关联列
        try { db.run('ALTER TABLE memories ADD COLUMN work_id TEXT'); } catch { /* 列已存在 */ }
        try { db.run('ALTER TABLE conversations ADD COLUMN work_id TEXT'); } catch { /* 列已存在 */ }
        console.log('[Migration] v12 ✅ works 作品表 + work_id 列');
      } catch (e) { console.warn('[Migration] v12 works 表创建失败:', e); }
    },
  },
  // v13: 40D 全量过渡 — 迁移标注 + 编码标识（V12.4 数据安全过渡）
  {
    version: 13,
    description: 'V12.4 40D 全量过渡: 迁移标注表 + 40D 编码版本标识（24D→40D 双写固化）',
    apply: (db: any) => {
      try {
        // 迁移标注表：记录 40D 全量过渡批次/时间戳/行数，可审计
        db.run(`CREATE TABLE IF NOT EXISTS migration_log_40d (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch TEXT NOT NULL,
          migrated_at TEXT NOT NULL,
          memories_total INTEGER,
          memories_has_40d INTEGER,
          memories_has_24d INTEGER,
          note TEXT
        )`);
        // 标注本次过渡（V12.4 阶段B: 新库 schema.sql 已无 perception_json 列，has24 列存在守卫）
        const now = new Date().toISOString();
        const total = (db.exec("SELECT COUNT(*) c FROM memories")[0]?.values?.[0]?.[0] ?? 0);
        const has40 = (db.exec("SELECT COUNT(*) c FROM memories WHERE perception_40d IS NOT NULL AND perception_40d != ''")[0]?.values?.[0]?.[0] ?? 0);
        let has24 = 0;
        try {
          const cols13 = (db.exec("PRAGMA table_info(memories)")[0]?.values ?? []) as Array<[number, string, string, ...unknown[]]>;
          if (cols13.some(c => c[1] === 'perception_json')) {
            has24 = (db.exec("SELECT COUNT(*) c FROM memories WHERE perception_json IS NOT NULL AND perception_json != ''")[0]?.values?.[0]?.[0] ?? 0);
          }
        } catch { /* 列不存在 → has24=0 */ }
        db.run(
          'INSERT INTO migration_log_40d (batch, migrated_at, memories_total, memories_has_40d, memories_has_24d, note) VALUES (?, ?, ?, ?, ?, ?)',
          ['40d_full_transition_v13', now, Number(total), Number(has40), Number(has24), 'V12.4 40D 全量过渡标注']
        );
        console.log(`[Migration] v13 ✅ 40D 全量过渡标注: total=${total} 40d=${has40} 24d=${has24}`);
      } catch (e) { console.warn('[Migration] v13 40D 过渡标注失败:', e); }
    },
  },
  // v14: 根除 24D — 回填 40D 后 DROP COLUMN perception_json（V12.4 阶段B 数据安全过渡）
  // 顺序铁律：先回填（从 perception_json 派生 40D，确保 40D 全覆盖）→ 再删列。
  // 幂等：PRAGMA table_info 守卫 — 列不存在则整体跳过（新库 schema.sql 已不含此列）。
  {
    version: 14,
    description: 'V12.4 根除24D: 回填 perception_40d → DROP COLUMN perception_json（唯一感知向量落库）',
    apply: (db: any) => {
      try {
        const cols = (db.exec("PRAGMA table_info(memories)")[0]?.values ?? []) as Array<[number, string, string, ...unknown[]]>;
        const has24 = cols.some(c => c[1] === 'perception_json');
        const has40 = cols.some(c => c[1] === 'perception_40d');
        if (!has24) {
          console.log('[Migration] v14 幂等跳过: perception_json 列已不存在（此前已根除）');
          return;
        }
        if (!has40) {
          console.warn('[Migration] v14 ⚠️ 缺少 perception_40d 列，无法完成 24D→40D 数据过渡，跳过删列');
          return;
        }

        // ── 1. 回填：从 perception_json 派生 40D（幂等，只处理 40D 为空的行）──
        // 24D → 40D 语义映射（dim40 为 1-indexed D 编号；与 PerceptionVector40DCodec.MAP_24_TO_40 同源）
        const MAP = [
          { k: 'self_ref', d: 9 }, { k: 'pleasure', d: 12 }, { k: 'safety', d: 14 },
          { k: 'intimacy', d: 15 }, { k: 'belonging', d: 17 }, { k: 'etiquette', d: 19 },
          { k: 'sexual_attraction', d: 33 }, { k: 'energy_merge', d: 34 }, { k: 'sincerity', d: 35 },
          { k: 'dominance', d: 36 }, { k: 'moral_judgment', d: 37 }, { k: 'humor', d: 38 },
          { k: 'dependency', d: 39 }, { k: 'possessiveness', d: 40 },
        ];
        const KEYS24 = [
          'pleasure','arousal','dominance','aggression','sincerity','humor',
          'factual','logical','certainty','abstract','temporal_focus','self_ref',
          'intimacy','power_diff','dependency','moral_judgment','etiquette','belonging',
          'sexual_attraction','sensory_craving','energy_merge','possessiveness','ecstasy','safety',
        ];
        let backfilled = 0;
        try {
          const rows = db.exec(
            "SELECT id, perception_json FROM memories WHERE perception_json IS NOT NULL AND (perception_40d IS NULL OR perception_40d = '')"
          );
          if (rows.length && rows[0].values) {
            for (const [id, pJsonRaw] of rows[0].values) {
              try {
                const parsed = JSON.parse(String(pJsonRaw));
                const p24 = Array.isArray(parsed) && parsed.length === 24
                  ? (() => { const o: Record<string, number> = {}; for (let i = 0; i < 24; i++) o[KEYS24[i]] = Number(parsed[i]) || 0; return o; })()
                  : (parsed && typeof parsed === 'object' ? parsed as Record<string, number> : null);
                if (!p24) continue;
                const p40 = new Array(40).fill(0);
                for (const { k, d } of MAP) {
                  const v = Number((p24 as Record<string, number>)[k]);
                  if (isFinite(v)) p40[d - 1] = v;
                }
                db.run("UPDATE memories SET perception_40d = ? WHERE id = ?", [JSON.stringify({ __v: PERCEPTION_40D_ENCODING_VERSION, dims: p40 }), String(id)]);
                backfilled++;
              } catch { /* 单条失败跳过 */ }
            }
          }
        } catch (e) { console.warn('[Migration] v14 40D 回填失败:', (e as Error)?.message); }
        if (backfilled > 0) console.log(`[Migration] v14 40D 回填: ${backfilled} 条（从 perception_json 派生）`);

        // ── 2. 删列：DROP COLUMN perception_json（PRAGMA 守卫已确认存在）──
        try {
          db.run('ALTER TABLE memories DROP COLUMN perception_json');
          console.log('[Migration] v14 ✅ 已删除 memories.perception_json 列（24D 根除落库）');
        } catch (e) {
          console.warn('[Migration] v14 DROP COLUMN perception_json 失败（非致命，留存检查）:', (e as Error)?.message);
        }

        // ── 3. 迁移标注 ──
        try {
          const total = (db.exec("SELECT COUNT(*) c FROM memories")[0]?.values?.[0]?.[0] ?? 0);
          const has40 = (db.exec("SELECT COUNT(*) c FROM memories WHERE perception_40d IS NOT NULL AND perception_40d != ''")[0]?.values?.[0]?.[0] ?? 0);
          const now = new Date().toISOString();
          db.run(
            'INSERT INTO migration_log_40d (batch, migrated_at, memories_total, memories_has_40d, memories_has_24d, note) VALUES (?, ?, ?, ?, ?, ?)',
            ['24d_rooted_out_v14', now, Number(total), Number(has40), 0, 'V12.4 阶段B: perception_json 列已删，24D 根除落库']
          );
          console.log(`[Migration] v14 标注: total=${total} 40d=${has40} 24d=0（列已删）`);
        } catch (e) { console.warn('[Migration] v14 标注失败:', (e as Error)?.message); }
      } catch (e) { console.warn('[Migration] v14 执行异常:', (e as Error)?.message); }
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

// ═══════════════════════════════════════════
// 启动期数据完整性修复（每次启动自动执行）
// ═══════════════════════════════════════════

/**
 * 启动期数据完整性修复。
 * 与 schema 迁移不同：这些是运行时数据回填，每次启动都检查。
 * 幂等：只修 null/缺失项，不覆盖已有数据。
 */
export async function repairDataIntegrity(db: any, fgDbPath?: string): Promise<{ globalUid: number; entityUuid: number; nullVectors: number }> {
  const result = { globalUid: 0, entityUuid: 0, nullVectors: 0 };
  const t0 = Date.now();

  // 1. global_uid 回填
  try {
    const nullUid = db.exec("SELECT id FROM memories WHERE global_uid IS NULL");
    if (nullUid.length > 0 && nullUid[0].values.length > 0) {
      for (const [id] of nullUid[0].values) {
        const h = createHash('sha256').update(String(id)).digest('hex').substring(0, 8).toUpperCase();
        db.run("UPDATE memories SET global_uid = ? WHERE id = ?", ['MM' + h, String(id)]);
        result.globalUid++;
      }
      console.log(`[Repair] global_uid 回填: ${result.globalUid} 条`);
    }
  } catch (e) { console.warn('[Repair] global_uid 回填失败:', e); }

  // 2. belong_entity_uuid 回填（V13: 从 FamilyGraph 动态获取真实 TXS UUID，替代硬编码假 UUID）
  try {
    // 先清理旧假 UUID（uuid-* 格式全是错误的）
    const fakeCleaned = db.exec("SELECT COUNT(*) FROM memories WHERE belong_entity_uuid LIKE 'uuid-%'");
    const fakeCount = fakeCleaned.length ? (fakeCleaned[0]?.values?.[0]?.[0] ?? 0) : 0;
    if (fakeCount > 0) {
      db.run("UPDATE memories SET belong_entity_uuid = NULL WHERE belong_entity_uuid LIKE 'uuid-%'");
      console.log(`[Repair] 清理假 UUID (uuid-*格式): ${fakeCount} 条 → 重置为 NULL`);
    }

    // 从 FamilyGraph 获取真实 person name → TXS UUID 映射
    let nameToUuid: Array<[string, string]> = [];
    try {
      if (fgDbPath) {
        const { existsSync, readFileSync } = await import('node:fs');
        if (existsSync(fgDbPath)) {
          const initSqlJs = (await import('sql.js')).default;
          const SQL = await initSqlJs();
          const fgBuf = readFileSync(fgDbPath);
          const fgDb = new SQL.Database(fgBuf);
          const rows = fgDb.exec(
            "SELECT name, uuid FROM nodes WHERE type = 'person' AND uuid IS NOT NULL AND uuid LIKE 'TXS-%'"
          );
          if (rows.length > 0 && rows[0].values) {
            nameToUuid = rows[0].values.map(([n, u]: any) => [String(n), String(u)]);
            // 补充别名映射：从 aliases JSON 中展开
            const aliasRows = fgDb.exec(
              "SELECT name, aliases FROM nodes WHERE type = 'person' AND aliases IS NOT NULL AND aliases != '[]'"
            );
            if (aliasRows.length > 0 && aliasRows[0].values) {
              for (const [fn, aliasesJson] of aliasRows[0].values) {
                try {
                  const aliases = JSON.parse(String(aliasesJson));
                  // sql.js exec() 不支持参数化，用 JS 过滤 name→uuid 表
                  const puuidMap = new Map(nameToUuid);
                  const puuid = puuidMap.get(String(fn)) ?? null;
                  if (puuid && Array.isArray(aliases)) {
                    for (const alias of aliases) {
                      if (typeof alias === 'string' && alias.length >= 1) {
                        nameToUuid.push([alias, puuid]);
                      }
                    }
                  }
                } catch { /* alias 解析失败跳过 */ }
              }
            }
          }
          fgDb.close();
        }
      }
    } catch (fgErr) {
      console.warn('[Repair] FamilyGraph 读取失败，跳过 entity 回填:', (fgErr as Error)?.message);
    }

    if (nameToUuid.length > 0) {
      // 去重：同一名字只保留一个 UUID
      const seen = new Set<string>();
      const deduped = nameToUuid.filter(([n]) => {
        if (seen.has(n)) return false;
        seen.add(n);
        return true;
      });
      const uuidSet = new Set(deduped.map(([, u]) => u));
      console.log(`[Repair] FamilyGraph 提供 ${deduped.length} 个人名/${uuidSet.size} 个真实 TXS UUID`);

      let filled = 0;
      for (const [name, uuid] of deduped) {
        if (!uuid || !uuid.startsWith('TXS-')) continue;
        // 2a. 关键词匹配 raw_input（排除已正确标注的）
        db.run(
          "UPDATE memories SET belong_entity_uuid = ? WHERE raw_input LIKE ? AND (belong_entity_uuid IS NULL OR belong_entity_uuid = '' OR belong_entity_uuid LIKE 'uuid-%')",
          [uuid, `%${name}%`]
        );
        // 2b. fg_entity_names 字段（已有逗号分隔人名）
        db.run(
          "UPDATE memories SET belong_entity_uuid = ? WHERE fg_entity_names LIKE ? AND (belong_entity_uuid IS NULL OR belong_entity_uuid = '')",
          [uuid, `%${name}%`]
        );
      }
      // 2c. 直接解析 fg_entity_names 逗号分隔 → FG UUID（比 LIKE 更精准）
      try {
        const fgRows = db.exec(
          "SELECT id, fg_entity_names FROM memories WHERE fg_entity_names IS NOT NULL AND fg_entity_names != '' AND (belong_entity_uuid IS NULL OR belong_entity_uuid = '')"
        );
        if (fgRows.length > 0 && fgRows[0].values) {
          const nameToUuidMap = new Map(deduped);
          let fgFilled = 0;
          for (const [memId, fgNames] of fgRows[0].values) {
            const names = parseNames(fgNames);
            for (const name of names) {
              const fgUuid = nameToUuidMap.get(name);
              if (fgUuid && fgUuid.startsWith('TXS-')) {
                db.run("UPDATE memories SET belong_entity_uuid = ? WHERE id = ?", [fgUuid, String(memId)]);
                fgFilled++;
                break; // 第一个有效人名即可
              }
            }
          }
          if (fgFilled > 0) console.log(`[Repair] fg_entity_names 解析回填: ${fgFilled} 条`);
        }
      } catch (e2c) { /* fg_entity_names 解析失败不阻塞 */ }
      // 重新统计
      const after = db.exec("SELECT COUNT(*) FROM memories WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != ''");
      result.entityUuid = after.length ? (after[0]?.values?.[0]?.[0] ?? 0) : 0;
      if (result.entityUuid > 0) console.log(`[Repair] belong_entity_uuid 回填 (真实 TXS UUID): ${result.entityUuid} 条`);
    } else {
      // 无 FamilyGraph 时至少统计现状
      const after = db.exec("SELECT COUNT(*) FROM memories WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != ''");
      result.entityUuid = after.length ? (after[0]?.values?.[0]?.[0] ?? 0) : 0;
      console.warn(`[Repair] ⚠️ 无 FamilyGraph UUID 映射可用，entity 回填跳过。现有 ${result.entityUuid} 条已标注`);
    }
  } catch (e) { console.warn('[Repair] belong_entity_uuid 回填失败:', e); }

  // 3. null 感知向量 → 零向量（🔴 V12.4 根除24D: perception_json 列已删，仅当列仍存在时执行）
  try {
    const cols = (db.exec("PRAGMA table_info(memories)")[0]?.values ?? []) as Array<[number, string, string, ...unknown[]]>;
    if (cols.some(c => c[1] === 'perception_json')) {
      const nullVecs = db.exec("SELECT id FROM memories WHERE perception_json LIKE '%null%'");
      if (nullVecs.length > 0 && nullVecs[0].values.length > 0) {
        const zeros = JSON.stringify(Array(24).fill(0));
        for (const [id] of nullVecs[0].values) {
          db.run("UPDATE memories SET perception_json = ? WHERE id = ?", [zeros, String(id)]);
          result.nullVectors++;
        }
        console.log(`[Repair] null 感知向量修复: ${result.nullVectors} 条`);
      }
    }
  } catch (e) { console.warn('[Repair] null 向量修复失败:', e); }

  const elapsed = Date.now() - t0;
  if (result.globalUid > 0 || result.entityUuid > 0 || result.nullVectors > 0) {
    console.log(`[Repair] 数据完整性修复完成 (${elapsed}ms): global_uid=${result.globalUid} entity_uuid=${result.entityUuid} nullVectors=${result.nullVectors}`);
  }

  return result;
}

/**
 * V13: 跨库孤儿检测 — 每次启动扫描各表 belong_entity_uuid 是否为 FamilyGraph 中真实存在的 person UUID。
 * 发现悬挂指针只报告不自动修复（无法自动确定正确归属，需人工介入）。
 */
export async function detectOrphanEntityUUIDs(db: any, fgDbPath?: string): Promise<{
  memories: number; vaultLog: number; conversations: number;
  blackDiamond: number; knowledgeBase: number; fgPersonCount: number;
}> {
  const result = { memories: 0, vaultLog: 0, conversations: 0, blackDiamond: 0, knowledgeBase: 0, fgPersonCount: 0 };
  try {
    const { existsSync, readFileSync } = await import('node:fs');
    const fgPath = fgDbPath || join(dirname(dirname(__dirname)), 'data', 'webui', 'knowledge', 'family_graph.db');
    if (!existsSync(fgPath)) { console.warn('[OrphanDetect] FG DB 不存在，跳过'); return result; }
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const fgDb = new SQL.Database(readFileSync(fgPath));
    const validUuids = new Set<string>();
    const fgRows = fgDb.exec("SELECT uuid FROM nodes WHERE type = 'person' AND uuid IS NOT NULL");
    if (fgRows.length > 0 && fgRows[0].values) {
      for (const [uuid] of fgRows[0].values) validUuids.add(String(uuid));
    }
    result.fgPersonCount = validUuids.size;
    fgDb.close();
    if (validUuids.size === 0) { console.warn('[OrphanDetect] FG 无 person 节点，跳过'); return result; }

    const tables = [
      { name: 'memories', key: 'memories' as const },
      { name: 'vault_log', key: 'vaultLog' as const },
      { name: 'conversations', key: 'conversations' as const },
      { name: 'black_diamond', key: 'blackDiamond' as const },
      { name: 'knowledge_base', key: 'knowledgeBase' as const },
    ];
    for (const { name, key } of tables) {
      try {
        const labeled = db.exec(`SELECT DISTINCT belong_entity_uuid FROM ${name} WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != ''`);
        let orphanCnt = 0;
        if (labeled.length > 0 && labeled[0].values) {
          for (const [uuid] of labeled[0].values) {
            if (!validUuids.has(String(uuid))) {
              const rowCnt = db.exec(`SELECT COUNT(*) FROM ${name} WHERE belong_entity_uuid = ?`, [String(uuid)]);
              orphanCnt += rowCnt.length > 0 && rowCnt[0]?.values?.[0] ? (rowCnt[0].values[0][0] as number) : 0;
            }
          }
        }
        result[key] = orphanCnt;
      } catch { /* skip */ }
    }

    const totalOrphans = result.memories + result.vaultLog + result.conversations + result.blackDiamond + result.knowledgeBase;
    if (totalOrphans > 0) {
      console.warn(`[OrphanDetect] ⚠️ 悬挂指针: mem=${result.memories} vault=${result.vaultLog} conv=${result.conversations} bd=${result.blackDiamond} kb=${result.knowledgeBase} (FG ${result.fgPersonCount}人)`);
    } else {
      console.log(`[OrphanDetect] ✅ 五表无悬挂指针 (FG ${result.fgPersonCount}人)`);
    }
  } catch (e) { console.warn('[OrphanDetect] 失败:', e); }
  return result;
}

/**
 * V13: 知识库净化迁移 — 将 805 条梦境 landmark + 2 条对话归纳从 knowledge_base
 * 转移到 vault_log（金库），遵循金库的 UUID 标注和钙化升降级规则。
 * 以后 knowledge_base 仅保留用户上传的文件/文档知识（md/txt/person/architecture）。
 *
 * 此迁移每次启动都检查（幂等：id 冲突自动跳过）。
 */
export async function migrateKnowledgeBaseToVault(db: any, fgDbPath?: string): Promise<{ landmark: number; inducted: number; deleted: number }> {
  const result = { landmark: 0, inducted: 0, deleted: 0 };
  const t0 = Date.now();

  try {
    // ── 1. 迁移 landmark (梦境沉淀) → vault_log ──
    const landmarks = db.exec(
      "SELECT id, title, content, tags, belong_entity_uuid, classification, created_at FROM knowledge_base WHERE source_type = 'landmark'"
    );
    if (landmarks.length > 0 && landmarks[0].values) {
      for (const [kbId, title, content, tags, euuid, cls, createdAt] of landmarks[0].values) {
        const vlId = 'vl_lm_' + String(kbId).replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 20);
        const detail = `${String(title || '记忆地标')}: ${String(content || '').substring(0, 80)}`;
        const tagsJson = String(tags || '[]');
        const uuid = euuid && String(euuid).length > 0 ? String(euuid) : null;
        db.run(
          "INSERT OR IGNORE INTO vault_log (id, operation, source_type, detail, content_md, belong_entity_uuid, created_at) VALUES (?, 'landmark', 'knowledge_base', ?, ?, ?, ?)",
          [vlId, detail, String(content || '').substring(0, 500), uuid, String(createdAt)],
        );
        result.landmark++;
      }
    }

    // ── 2. 迁移对话自动归纳 (auto_inducted) → vault_log ──
    const inducted = db.exec(
      "SELECT id, title, content, belong_entity_uuid, created_at FROM knowledge_base WHERE source_type = 'research' AND tags LIKE '%auto_inducted%'"
    );
    if (inducted.length > 0 && inducted[0].values) {
      for (const [kbId, title, content, euuid, createdAt] of inducted[0].values) {
        const vlId = 'vl_migrate_induct_' + String(kbId).substring(0, 12);
        const uuid = euuid && String(euuid).length > 0 ? String(euuid) : null;
        db.run(
          "INSERT OR IGNORE INTO vault_log (id, operation, source_type, detail, content_md, belong_entity_uuid, created_at) VALUES (?, 'auto_induct', 'knowledge_base', ?, ?, ?, ?)",
          [vlId, String(title || ''), String(content || '').substring(0, 500), uuid, String(createdAt)],
        );
        result.inducted++;
      }
    }

    // ── 3. 删除已迁移的记录 + 测试残留 ──
    const delLandmark = db.run("DELETE FROM knowledge_base WHERE source_type = 'landmark'");
    const delInduct = db.run("DELETE FROM knowledge_base WHERE source_type = 'research' AND tags LIKE '%auto_inducted%'");
    const delTest = db.run("DELETE FROM knowledge_base WHERE source_type = 'text'");
    result.deleted = result.landmark + result.inducted + 2; // +2 test entries

    // ── 4. 为新迁移的 landmark vault_log 条目回填 UUID ──
    // 使用 detail/content_md 中的人名 + 默认玉瑶策略
    try {
      const fgPath = fgDbPath || join(dirname(dirname(__dirname)), 'data', 'webui', 'knowledge', 'family_graph.db');
      const { existsSync, readFileSync } = await import('node:fs');
      if (existsSync(fgPath)) {
        const initSqlJs = (await import('sql.js')).default;
        const SQL = await initSqlJs();
        const fgBuf = readFileSync(fgPath);
        const fgDb = new SQL.Database(fgBuf);
        const peopleRows = fgDb.exec(
          "SELECT name, uuid FROM nodes WHERE type = 'person' AND uuid IS NOT NULL AND uuid LIKE 'TXS-%' AND LENGTH(name) >= 2"
        );
        if (peopleRows.length > 0 && peopleRows[0].values) {
          // 人名匹配
          for (const [name, uuid] of peopleRows[0].values) {
            db.run(
              `UPDATE vault_log SET belong_entity_uuid = '${String(uuid)}' WHERE belong_entity_uuid IS NULL AND detail LIKE '%${String(name)}%' AND operation = 'landmark'`
            );
          }
          // 默认玉瑶
          const yaoyao = [...peopleRows[0].values].find(([n]: any) => n === '玉瑶');
          const yaoyaoUuid = yaoyao ? String(yaoyao[1]) : 'TXS-000000001';
          db.run(
            `UPDATE vault_log SET belong_entity_uuid = '${yaoyaoUuid}' WHERE belong_entity_uuid IS NULL AND operation = 'landmark'`
          );
        }
        fgDb.close();
      }
    } catch (e4) { /* UUID 回填失败不阻塞 */ }

    const elapsed = Date.now() - t0;
    console.log(`[Migration] 知识库净化: landmark${result.landmark}条+归纳${result.inducted}条 → vault_log (${elapsed}ms)`);
  } catch (e) {
    console.warn('[Migration] 知识库净化失败:', e);
  }

  return result;
}
