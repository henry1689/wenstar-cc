/**
 * backfill-location-fingerprint.ts — memories.location_fingerprint 回填脚本（P1）
 * ==================================================
 * 问题: memories 表 588 条 location_fingerprint 全部为空（0%）
 * 原因: 早期 DNAEncoder 生成 global_uid 时传空 fp（已修复），且 memories 落库时 fp 未继承
 *
 * 策略:
 *   1. ANCHOR 记忆: 通过 dialog_group_id 从 conversations 继承 fp（80/80 可匹配）
 *   2. mem 与 evt 记忆: 通过 dna_root_id 从 conversations 继承 fp（279/279 + 168/168 可匹配）
 *   3. 无法匹配的记忆: 保持 null（不伪造）
 *   4. 同时用真实 fp 重算 global_uid 的区位标识（locHash）——仅在旧 UID locHash 是空fp哈希(84E0C0EA)时更新
 *
 * 安全性:
 *   - 不删除任何数据，仅填充/更新
 *   - 执行前自动备份
 *   - 幂等可重跑
 *
 * 执行:
 *   npx tsx scripts/backfill-location-fingerprint.ts
 */

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DB_PATH = 'data/webui/fusion_memory.db';
const EMPTY_FP_LOC_HASH = createHash('sha256').update('0'.repeat(32)).digest('hex').substring(0, 8).toUpperCase(); // 84E0C0EA

console.log('═'.repeat(60));
console.log('  memories.location_fingerprint 回填 (P1)');
console.log('═'.repeat(60));

const backupPath = `${DB_PATH}.bak-fp-backfill-${Date.now()}`;
writeFileSync(backupPath, readFileSync(DB_PATH));
console.log(`\n✅ 备份: ${backupPath}`);

const buffer = readFileSync(DB_PATH);
const SQL = await initSqlJs();
const db = new SQL.Database(buffer);

// ── 1. 获取 conversations 的 fp 映射 ──
// key: dialog_group_id → fp (优先非空、非全零)
const dgFp = new Map<string, string>();
const rootFp = new Map<string, string>();
const convRows2 = db.exec(
  "SELECT dialog_group_id, dna_root_id, location_fingerprint FROM conversations WHERE location_fingerprint IS NOT NULL AND location_fingerprint != '' AND location_fingerprint != '00000000000000000000000000000000'"
);
for (const row of (convRows2[0]?.values || [])) {
  const [dg, root, fp] = row as any[];
  if (dg && !dgFp.has(String(dg))) dgFp.set(String(dg), String(fp));
  if (root && !rootFp.has(String(root))) rootFp.set(String(root), String(fp));
}
console.log(`conversations 有效 fp: 对话框组 ${dgFp.size} 个, 根码 ${rootFp.size} 个`);

// ── 2. 回填 memories ──
const memRows = db.exec("SELECT id, dialog_group_id, dna_root_id, global_uid FROM memories WHERE location_fingerprint IS NULL OR location_fingerprint = ''");
const rows = memRows[0]?.values || [];
console.log(`待回填记忆: ${rows.length} 条\n`);

let filled = 0, updatedUid = 0, unmatched = 0;
const uidLog: any[] = [];

for (const row of rows) {
  const [id, dg, root, uid] = row as any[];
  let fp = '';
  const idStr = String(id);
  
  if (idStr.includes('_ANCHOR')) {
    fp = dgFp.get(String(dg || '')) || '';
  }
  if (!fp) {
    fp = rootFp.get(String(root || '')) || '';
  }
  
  if (!fp) {
    unmatched++;
    continue;
  }
  
  db.run('UPDATE memories SET location_fingerprint = ? WHERE id = ?', [fp, id]);
  filled++;
  
  // ── 3. 重算 global_uid 区位标识（仅当旧 UID 是空fp哈希）──
  const uidStr = String(uid || '');
  if (uidStr.length === 23 && uidStr.substring(9, 17) === EMPTY_FP_LOC_HASH) {
    const newLocHash = createHash('sha256').update(fp).digest('hex').substring(0, 8).toUpperCase();
    const newUid = uidStr.substring(0, 9) + newLocHash + uidStr.substring(17);
    db.run('UPDATE memories SET global_uid = ? WHERE id = ?', [newUid, id]);
    // 同步 state_spines
    db.run('UPDATE state_spines SET global_uid = ? WHERE global_uid = ?', [newUid, uidStr]);
    db.run('UPDATE atom_repair_index SET global_uid = ? WHERE global_uid = ?', [newUid, uidStr]);
    uidLog.push({ id: idStr, oldUid: uidStr, newUid });
    updatedUid++;
  }
}

// ── 保存 ──
const data = db.export();
writeFileSync(DB_PATH, Buffer.from(data));
writeFileSync('data/webui/fp-migration-log.json', JSON.stringify(uidLog, null, 2));
db.close();

console.log('═'.repeat(60));
console.log('  回填完成!');
console.log('═'.repeat(60));
console.log(`回填 fp: ${filled} 条`);
console.log(`重算 UID 区位标识: ${updatedUid} 条`);
console.log(`未匹配(保持null): ${unmatched} 条`);
console.log(`日志: data/webui/fp-migration-log.json`);
console.log(`备份: ${backupPath}`);
