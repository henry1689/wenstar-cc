/**
 * step3-migrate.js — 旧库 → 新库 数据迁移（支持 dry-run / 真实）
 *
 * 角色映射（基于 entities 表 + memories.belong_entity_uuid 推断）：
 *   TXS-000000001 → ns_yuyao（玉瑶，主角色，entities 表无但数据最多）
 *   TXS-000000003 → ns_xiongziming（熊梓铭）
 *   TXS-000000005 → ns_wangquanfen（王全芬）
 *   TXS-000000007 → ns_shiyu（徐诗雨）
 *   TXS-000000008 → ns_a-zhen（阿珍）
 *   其他 / 无归属 → ns_legacy_unknown（隔离区）
 */
const Database = require('better-sqlite3');

const OLD_DB = 'D:/tools/wenstar-cc/data/webui/fusion_memory.db';
const NEW_DB = 'D:/tools/wenstar-cc/data/memarch-v2.db';
const DRY_RUN = process.argv.includes('--dry-run');

console.log(`=== Step 3: 数据迁移 (${DRY_RUN ? 'DRY-RUN' : 'REAL'}) ===`);
console.log('旧库:', OLD_DB);
console.log('新库:', NEW_DB);

// 角色 → namespace 映射
const ENTITY_TO_NS = {
  'TXS-000000001': { ns: 'ns_yuyao', name: '玉瑶' },
  'TXS-000000003': { ns: 'ns_xiongziming', name: '熊梓铭' },
  'TXS-000000005': { ns: 'ns_wangquanfen', name: '王全芬' },
  'TXS-000000007': { ns: 'ns_shiyu', name: '徐诗雨' },
  'TXS-000000008': { ns: 'ns_a-zhen', name: '阿珍' },
  'TXS-000000011': { ns: 'ns_shiyun', name: '徐诗韵' },
  'TXS-000000018': { ns: 'ns_shihan', name: '徐诗涵' },
};
const FALLBACK_NS = 'ns_legacy_unknown';

function resolveNs(entityUuid) {
  if (!entityUuid) return FALLBACK_NS;
  return (ENTITY_TO_NS[entityUuid] || {}).ns || FALLBACK_NS;
}

const oldDb = new Database(OLD_DB, { readonly: true });
const newDb = new Database(NEW_DB);

// 事务包整个迁移
const migrate = newDb.transaction(() => {
  // 0. 注册所有角色 namespace
  const now = Date.now();
  for (const [uuid, { ns, name }] of Object.entries(ENTITY_TO_NS)) {
    newDb.prepare(`
      INSERT OR IGNORE INTO namespace_registry (namespace, roleplay_name, role_uuid, created_at, note)
      VALUES (?, ?, ?, ?, ?)
    `).run(ns, name, uuid, now, `从旧库 entities 表迁移`);
  }
  newDb.prepare(`
    INSERT OR IGNORE INTO namespace_registry (namespace, roleplay_name, role_uuid, created_at, note)
    VALUES (?, ?, ?, ?, ?)
  `).run(FALLBACK_NS, '未归属历史数据', 'legacy-unknown', now, '隔离区');
  console.log(`✓ 已注册 ${Object.keys(ENTITY_TO_NS).length + 1} 个 namespace`);

  // ============================================================
  // 1. 迁移 conversations（通过 dialog_groups 关联到角色）
  // ============================================================
  console.log('\n--- 迁移 conversations ---');
  const oldConvos = oldDb.prepare(`
    SELECT c.*, dg.belong_entity_uuid
    FROM conversations c
    LEFT JOIN dialog_groups dg ON c.dialog_group_id = dg.dialog_group_id
  `).all();

  console.log(`旧 conversations 总数: ${oldConvos.length}`);

  let convMigrated = 0, convSkipped = 0;
  const convNsStats = {};

  const insertConv = newDb.prepare(`
    INSERT OR IGNORE INTO conversations
      (message_id, namespace, roleplay_char, timestamp, ts_utc, role, content,
       is_summary, is_compacted, episode_id, lifecycle_state, sensitivity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of oldConvos) {
    const ns = resolveNs(c.belong_entity_uuid);
    convNsStats[ns] = (convNsStats[ns] || 0) + 1;

    // 幂等
    const exists = newDb.prepare(`SELECT 1 FROM conversations WHERE message_id = ?`).get(String(c.id));
    if (exists) { convSkipped++; continue; }

    // timestamp ISO → epoch ms
    let tsUtc = Date.now();
    try { tsUtc = new Date(c.timestamp).getTime(); } catch {}

    if (!DRY_RUN) {
      insertConv.run(
        String(c.id),
        ns,
        (ENTITY_TO_NS[c.belong_entity_uuid] || {}).name || null,
        c.timestamp,
        tsUtc,
        c.role,
        c.content,
        c.is_summary || 0,
        c.is_compacted || 0,
        c.dialog_group_id || null,
        'weakening',  // 历史数据归档（在 lifecycle_state 枚举内）
        0,
        tsUtc,
      );
    }
    convMigrated++;
  }
  console.log(`  迁移: ${convMigrated}, 跳过(已存在): ${convSkipped}`);
  console.log('  按 namespace 分布:', convNsStats);

  // ============================================================
  // 2. 迁移 memories（按 belong_entity_uuid 直接分）
  // ============================================================
  console.log('\n--- 迁移 memories ---');
  const oldMems = oldDb.prepare(`SELECT * FROM memories`).all();
  console.log(`旧 memories 总数: ${oldMems.length}`);

  let memMigrated = 0, memSkipped = 0;
  const memNsStats = {};

  const insertMem = newDb.prepare(`
    INSERT OR IGNORE INTO memories
      (id, namespace, raw_input, summary, consolidation, salience, arousal,
       lifecycle_state, episode_id, created_at, calcium_legacy, calcium_score,
       recall_count, last_recalled_at, is_landmark, dna_root_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const m of oldMems) {
    const ns = resolveNs(m.belong_entity_uuid);
    memNsStats[ns] = (memNsStats[ns] || 0) + 1;

    const exists = newDb.prepare(`SELECT 1 FROM memories WHERE id = ?`).get(m.id);
    if (exists) { memSkipped++; continue; }

    // calcium_level (0-3) → consolidation (0-1)
    const consolidation = (m.calcium_level || 0) / 3;
    let createdAt = Date.now();
    try { createdAt = new Date(m.created_at).getTime(); } catch {}

    if (!DRY_RUN) {
      insertMem.run(
        m.id,
        ns,
        m.raw_input,
        m.raw_input ? String(m.raw_input).slice(0, 200) : null,
        consolidation,
        m.calcium_score || 0.5,
        0.3,  // arousal 默认
        'consolidated',  // 历史记忆默认已巩固（在 lifecycle_state 枚举内）
        null,  // episode_id 历史数据不强关联，避免外键约束
        createdAt,
        m.calcium_level,
        m.calcium_score,
        m.recall_count || 0,
        m.last_recalled_at,
        m.is_landmark || 0,
        m.dna_root_id,
      );
    }
    memMigrated++;
  }
  console.log(`  迁移: ${memMigrated}, 跳过(已存在): ${memSkipped}`);
  console.log('  按 namespace 分布:', memNsStats);

  // ============================================================
  // 3. 迁移 dialog_groups → episodes
  // ============================================================
  console.log('\n--- 迁移 dialog_groups → episodes ---');
  const oldDgs = oldDb.prepare(`SELECT * FROM dialog_groups`).all();
  console.log(`旧 dialog_groups 总数: ${oldDgs.length}`);

  let epMigrated = 0, epSkipped = 0;
  const insertEp = newDb.prepare(`
    INSERT OR IGNORE INTO episodes
      (id, namespace, started_at, status, gist, consolidation, lifecycle_state, dna_root_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const dg of oldDgs) {
    const ns = resolveNs(dg.belong_entity_uuid);
    const exists = newDb.prepare(`SELECT 1 FROM episodes WHERE id = ?`).get(dg.dialog_group_id);
    if (exists) { epSkipped++; continue; }

    if (!DRY_RUN) {
      insertEp.run(
        dg.dialog_group_id,
        ns,
        Date.now(),
        'sealed',
        dg.block_summary || dg.narrative_tag || null,
        dg.block_calcium_score ? dg.block_calcium_score / 5 : 0.3,
        'consolidated',
        null,
      );
    }
    epMigrated++;
  }
  console.log(`  迁移: ${epMigrated}, 跳过: ${epSkipped}`);

  // ============================================================
  // 4. 记录 migration_checkpoint
  // ============================================================
  if (!DRY_RUN) {
    newDb.prepare(`DELETE FROM migration_checkpoint`).run();
    const cp = newDb.prepare(`
      INSERT INTO migration_checkpoint (old_table, old_pk, new_pk, namespace, migrated_at, status)
      VALUES (?, ?, ?, ?, ?, 'success')
    `);
    for (const c of oldConvos) {
      cp.run('conversations', String(c.id), String(c.id), resolveNs(c.belong_entity_uuid), Date.now());
    }
    for (const m of oldMems) {
      cp.run('memories', m.id, m.id, resolveNs(m.belong_entity_uuid), Date.now());
    }
  }

  return { convMigrated, convSkipped, memMigrated, memSkipped, epMigrated, epSkipped };
});

const result = migrate();

// ============================================================
// 校验
// ============================================================
console.log('\n=== 校验 ===');
if (!DRY_RUN) {
  const convCount = newDb.prepare(`SELECT COUNT(*) c FROM conversations`).get().c;
  const memCount = newDb.prepare(`SELECT COUNT(*) c FROM memories`).get().c;
  const epCount = newDb.prepare(`SELECT COUNT(*) c FROM episodes`).get().c;
  console.log(`新库 conversations: ${convCount}`);
  console.log(`新库 memories: ${memCount}`);
  console.log(`新库 episodes: ${epCount}`);

  const nsDist = newDb.prepare(`
    SELECT namespace, COUNT(*) c FROM conversations GROUP BY namespace ORDER BY c DESC
  `).all();
  console.log('\n新库 conversations namespace 分布:');
  for (const r of nsDist) console.log(`  ${r.namespace}: ${r.c}`);

  const cpStats = newDb.prepare(`
    SELECT status, COUNT(*) c FROM migration_checkpoint GROUP BY status
  `).all();
  console.log('\nmigration_checkpoint:', cpStats);
}

newDb.close();
oldDb.close();

console.log(`\n✅ Step 3 ${DRY_RUN ? 'DRY-RUN' : 'REAL'} 完成`);
