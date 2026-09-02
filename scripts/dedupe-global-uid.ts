/**
 * dedupe-global-uid.ts — GlobalUID 重复修复脚本（P0）
 * ==================================================
 * 问题: 79 组 global_uid 重复（158 条记录），其中
 *   - 46 组: anchor + evt 共享 UID
 *   - 33 组: anchor + other 共享 UID
 * 根因: evt_* 事件记忆创建时复制了 ANCHOR/对话的 global_uid，未生成独立 UID
 *
 * 策略:
 *   1. 保留 ANCHOR/对话的 UID（权威身份）
 *   2. 为重复组中的非权威记录（evt_* 优先）重新生成确定性 UID
 *   3. 新 UID 基于 id + created_at + seq_pos 的 SHA256（幂等可重跑）
 *   4. 同步更新 state_spines / atom_repair_index 中的引用
 *   5. 保留旧 UID 映射日志（便于回滚）
 *
 * 安全性:
 *   - 不删除任何数据
 *   - 确定性生成（同输入同输出），可重跑
 *   - 执行前自动备份数据库
 *   - 输出旧→新 UID 映射到 data/webui/uid-migration-log.json
 *
 * 执行:
 *   npx tsx scripts/dedupe-global-uid.ts
 */

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DB_PATH = 'data/webui/fusion_memory.db';
const LOG_PATH = 'data/webui/uid-migration-log.json';

console.log('═'.repeat(60));
console.log('  GlobalUID 去重修复 (P0)');
console.log('═'.repeat(60));

// ── 备份 ──
const backupPath = `${DB_PATH}.bak-uid-dedupe-${Date.now()}`;
writeFileSync(backupPath, readFileSync(DB_PATH));
console.log(`\n✅ 备份: ${backupPath}`);

const buffer = readFileSync(DB_PATH);
const SQL = await initSqlJs();
const db = new SQL.Database(buffer);

// ── 统计 ──
const dupGroups = db.exec(`
  SELECT global_uid, COUNT(*) c FROM memories 
  WHERE global_uid IS NOT NULL AND global_uid != '' AND length(global_uid) = 23
  GROUP BY global_uid HAVING c > 1
`);
console.log(`\n重复组: ${dupGroups[0]?.values?.length || 0}`);

// ── 收集重复组详情 ──
const migrationLog: Array<{ oldUid: string; newUid: string; id: string; keep: boolean }> = [];

for (const [uid, count] of (dupGroups[0]?.values || [])) {
  const rows = db.exec('SELECT id, created_at, seq_pos FROM memories WHERE global_uid = ?', [uid])[0]?.values || [];
  
  // 权威保留规则: 优先保留 id 含 _ANCHOR 的记录；无 ANCHOR 则保留最早创建的
  const anchorRows = rows.filter((r: any[]) => String(r[0]).includes('_ANCHOR'));
  const keepRow = anchorRows.length > 0 
    ? anchorRows[0] 
    : rows.sort((a: any[], b: any[]) => new Date(a[1]).getTime() - new Date(b[1]).getTime())[0];
  
  for (const row of rows) {
    const [id, createdAt, seqPos] = row as any[];
    if (id === keepRow[0]) {
      migrationLog.push({ oldUid: uid as string, newUid: uid as string, id: id as string, keep: true });
      continue; // 权威记录保留原 UID
    }
    
    // 非权威记录重新生成确定性 UID
    const hash = createHash('sha256').update(`${id}_${createdAt}_${seqPos}_dedupe`).digest('hex');
    const nodeNum = (Math.abs(Number(seqPos)) % 65535) || 1;
    const batchNum = (Math.abs(Number(seqPos)) % 4096);
    // 区位标识: 使用旧 UID 的 locHash 保持空间一致性
    const oldLocHash = String(uid).substring(9, 17);
    const newUid = `MM${String(nodeNum).padStart(4, '0')}${String(batchNum).padStart(3, '0')}${oldLocHash}${hash.substring(0, 6).toUpperCase()}`;
    
    db.run('UPDATE memories SET global_uid = ? WHERE id = ?', [newUid, id]);
    migrationLog.push({ oldUid: uid as string, newUid, id: id as string, keep: false });
  }
}

const migrated = migrationLog.filter(l => !l.keep).length;
console.log(`重新生成 UID: ${migrated} 条`);

// ── 同步更新 state_spines ──
console.log('\n同步 state_spines...');
let ssUpdated = 0;
for (const log of migrationLog) {
  if (log.keep) continue;
  db.run('UPDATE state_spines SET global_uid = ? WHERE global_uid = ?', [log.newUid, log.oldUid]);
  ssUpdated++;
}
console.log(`  state_spines 更新: ${ssUpdated} 条`);

// ── 同步更新 atom_repair_index ──
console.log('同步 atom_repair_index...');
let ariUpdated = 0;
for (const log of migrationLog) {
  if (log.keep) continue;
  db.run('UPDATE atom_repair_index SET global_uid = ? WHERE global_uid = ?', [log.newUid, log.oldUid]);
  ariUpdated++;
}
console.log(`  atom_repair_index 更新: ${ariUpdated} 条`);

// ── 保存 ──
const data = db.export();
writeFileSync(DB_PATH, Buffer.from(data));
writeFileSync(LOG_PATH, JSON.stringify(migrationLog, null, 2));
db.close();

// ── 验证 ──
console.log('\n═'.repeat(60));
console.log('  去重完成!');
console.log('═'.repeat(60));

const db2 = new SQL.Database(readFileSync(DB_PATH));
const remain = db2.exec(`
  SELECT COUNT(*) FROM (SELECT global_uid FROM memories WHERE global_uid != '' GROUP BY global_uid HAVING COUNT(*) > 1)
`);
console.log(`剩余重复组: ${remain[0]?.values?.[0]?.[0] || 0}`);
db2.close();
console.log(`迁移日志: ${LOG_PATH}`);
console.log(`备份: ${backupPath}`);
