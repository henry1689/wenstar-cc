/**
 * BackfillGlobalUID.ts — 存量记忆 GlobalUID 回填迁移
 * ==================================================
 * 问题: 1691条 memories 的 global_uid / location_fingerprint 填充率为 0%
 * 原因: GlobalUID 代码在存量数据之后上线
 *
 * 策略:
 *   1. 为每条旧记忆生成确定性 GlobalUID (基于 seq_pos + created_at 的 SHA256)
 *   2. 批量写入 memories.global_uid + location_fingerprint
 *   3. 同时回填 state_spines / atom_address_timeline / atom_repair_index (可选)
 *
 * 执行:
 *   npx tsx src/m2/BackfillGlobalUID.ts
 *
 * 安全性:
 *   - 基于 seq_pos+created_at 生成, 幂等可重跑
 *   - 不删除任何数据, 仅填充 NULL 字段
 *   - location_fingerprint 设为 32位全0 (瑶光空白期)
 */

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DB_PATH = 'data/webui/fusion_memory.db';

console.log('═'.repeat(60));
console.log('  GlobalUID 存量回填迁移');
console.log('═'.repeat(60));

const buffer = readFileSync(DB_PATH);
const SQL = await initSqlJs();
const db = new SQL.Database(buffer);

// 1. 统计存量
const total = db.exec('SELECT COUNT(*) FROM memories')[0].values[0][0] as number;
// 🔴 修复(2026-09-11): 原写法 `global_uid = ""` 依赖 SQLite 的「双引号退化当字符串」**非标准行为**：
//   - DQS 宽松模式（本文件用 sql.js）实测不报错，把 `""` 当空串 → 碰巧得到预期结果；
//   - 但严格模式（SQLITE_DQS=0，如 better-sqlite3）下必抛错：
//     no such column: "" - should this be a string literal in single-quotes?
// 即语义依赖编译选项 —— 换运行库/升级即静默改变行为，属隐患。统一改用标准单引号字面量。
const missing = db.exec("SELECT COUNT(*) FROM memories WHERE global_uid IS NULL OR global_uid = ''")[0].values[0][0] as number;
console.log(`\n记忆总数: ${total}  缺GlobalUID: ${missing}`);

if (missing === 0) {
  console.log('无需回填, 所有记录已有 GlobalUID');
  db.close();
  process.exit(0);
}

// 2. 回填 memories
console.log('\n回填 memories...');
const rows = db.exec("SELECT id, seq_pos, created_at, dna_root_id, locus_path FROM memories WHERE global_uid IS NULL OR global_uid = ''");
let backfilled = 0;

for (const row of rows[0]?.values || []) {
  const [id, seqPos, createdAt, dnaRootId, locusPath] = row;
  const seq = String(seqPos || 0).padStart(6, '0');
  const ts = createdAt ? new Date(createdAt as string).getTime() : Date.now();
  const nodeNum = (Math.abs(Number(seqPos)) % 65535) || 1;

  // 生成确定性 GlobalUID (基于已有字段, 幂等可重跑)
  const hash = createHash('sha256')
    .update(`${id}_${seqPos}_${createdAt}`)
    .digest('hex');
  const globalUid = `MM${String(nodeNum).padStart(4,'0')}${String(Number(seqPos)%4096).padStart(3,'0')}${hash.substring(0,8).toUpperCase()}${hash.substring(8,14).toUpperCase()}`;

  db.run('UPDATE memories SET global_uid = ?, location_fingerprint = ? WHERE id = ?',
    [globalUid, '0'.repeat(32), id]);
  backfilled++;

  if (backfilled % 200 === 0) console.log(`  已回填 ${backfilled}/${missing}...`);
}

console.log(`  ✅ memories 回填完成: ${backfilled} 条`);

// 3. 回填 conversations
const convMissing = db.exec("SELECT COUNT(*) FROM conversations WHERE global_uid IS NULL OR global_uid = ''")[0].values[0][0] as number;
console.log(`\n对话缺GlobalUID: ${convMissing}`);

if (convMissing > 0) {
  const convRows = db.exec("SELECT id, seq_pos, timestamp, dna_root_id FROM conversations WHERE global_uid IS NULL OR global_uid = ''");
  let convFilled = 0;

  for (const cr of convRows[0]?.values || []) {
    const [cid, cseqPos, cts, cdna] = cr;
    const cnodeNum = (Math.abs(Number(cseqPos)) % 65535) || 1;
    const chash = createHash('sha256').update(`${cid}_${cseqPos}_${cts}`).digest('hex');
    const cglobalUid = `MM${String(cnodeNum).padStart(4,'0')}${String(Number(cseqPos)%4096).padStart(3,'0')}${chash.substring(0,8).toUpperCase()}${chash.substring(8,14).toUpperCase()}`;

    db.run('UPDATE conversations SET global_uid = ?, location_fingerprint = ? WHERE id = ?',
      [cglobalUid, '0'.repeat(32), cid]);
    convFilled++;
  }
  console.log(`  ✅ conversations 回填完成: ${convFilled} 条`);
}

// 4. 保存
const data = db.export();
writeFileSync(DB_PATH, Buffer.from(data));
db.close();

console.log('\n' + '═'.repeat(60));
console.log('  回填完成!');
console.log(`  memories:    ${backfilled} 条 (GlobalUID + location_fingerprint)`);
console.log(`  conversations: ${convMissing > 0 ? convMissing + ' 条' : '无需回填'}`);
console.log(`  DB: ${DB_PATH}`);
console.log('═'.repeat(60));
