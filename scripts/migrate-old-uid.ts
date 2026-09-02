/**
 * migrate-old-uid.ts — 旧 10 位 GlobalUID 迁移为 23 位规范格式（P2）
 * ==================================================
 * 问题: 58 条记忆 global_uid 为旧 10 位格式（MM + 8位hex，SQLiteAdapter 兜底生成）
 * 影响: 与 23 位规范格式不一致，检索/关联可能失效
 *
 * 策略:
 *   1. 为每条旧格式记录生成确定性 23 位 UID（基于 id+created_at 哈希，幂等）
 *   2. 保持 nodeNum/batchNum 从 seq_pos 派生
 *   3. 迁移日志保留旧→新映射（可回滚）
 *
 * 安全性:
 *   - 不删除数据，仅更新 UID 字段
 *   - 确定性生成，可重跑
 *   - 执行前自动备份
 *
 * 执行:
 *   npx tsx scripts/migrate-old-uid.ts
 */

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DB_PATH = 'data/webui/fusion_memory.db';
const LOG_PATH = 'data/webui/old-uid-migration-log.json';

console.log('═'.repeat(60));
console.log('  旧 10 位 GlobalUID 迁移 (P2)');
console.log('═'.repeat(60));

const backupPath = `${DB_PATH}.bak-old-uid-${Date.now()}`;
writeFileSync(backupPath, readFileSync(DB_PATH));
console.log(`\n✅ 备份: ${backupPath}`);

const buffer = readFileSync(DB_PATH);
const SQL = await initSqlJs();
const db = new SQL.Database(buffer);

// 收集旧格式记录
const rows = db.exec("SELECT id, created_at, seq_pos, global_uid FROM memories WHERE global_uid IS NOT NULL AND global_uid != '' AND length(global_uid) = 10");
const records = (rows[0]?.values || []) as any[][];
console.log(`旧格式记录: ${records.length} 条\n`);

const migrationLog: any[] = [];
let migrated = 0;

for (const [id, createdAt, seqPos, oldUid] of records) {
  // 确定性生成 23 位 UID（强制 4+3+8+6 结构，nodeNum/batchNum 截断防溢出）
  const hash = createHash('sha256').update(`${id}_${createdAt}_${seqPos}_migrate23`).digest('hex');
  const nodeNum = (Math.abs(Number(seqPos)) % 65535) || 1;
  const batchNum = (Math.abs(Number(seqPos)) % 4096);
  // 区位标识: 旧 UID 无 locHash，用空 fp 哈希（与原始兜底语义一致）
  const locHash = createHash('sha256').update('0'.repeat(32)).digest('hex').substring(0, 8).toUpperCase();
  // 强制 NNNN 4位 / BBB 3位，超出截断（避免 24-25 字符非规范 UID）
  const NNNN = String(nodeNum).padStart(4, '0').slice(-4);
  const BBB = String(batchNum).padStart(3, '0').slice(-3);
  const newUid = `MM${NNNN}${BBB}${locHash}${hash.substring(0, 6).toUpperCase()}`;
  if (newUid.length !== 23) {
    console.warn(`⚠️ 生成异常长度 ${newUid.length}: ${id}`);
    continue;
  }

  // 确保不与现有 UID 冲突
  const exist = db.exec('SELECT COUNT(*) FROM memories WHERE global_uid = ?', [newUid]);
  if (exist[0]?.values?.[0]?.[0] === 0) {
    db.run('UPDATE memories SET global_uid = ? WHERE id = ?', [newUid, id]);
    migrationLog.push({ id: String(id), oldUid: String(oldUid), newUid });
    migrated++;
  } else {
    console.warn(`⚠️ UID 冲突跳过: ${id} → ${newUid}`);
  }
}

// 保存
const data = db.export();
writeFileSync(DB_PATH, Buffer.from(data));
writeFileSync(LOG_PATH, JSON.stringify(migrationLog, null, 2));
db.close();

console.log('═'.repeat(60));
console.log('  迁移完成!');
console.log('═'.repeat(60));
console.log(`迁移: ${migrated} 条`);
console.log(`日志: ${LOG_PATH}`);
console.log(`备份: ${backupPath}`);
