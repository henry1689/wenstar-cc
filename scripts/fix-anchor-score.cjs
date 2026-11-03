/**
 * fix-anchor-score.cjs — 回填 anchor_score 到历史锚点
 * =====================================================
 * 问题：锚点记忆（_ANCHOR 后缀）anchor_score 全为 NULL
 * 根因：历史写入时 anchorScore 字段未正确传递
 * 修复：从 calcium_score 派生 anchor_score（锚点 = 同组最高钙化）
 */

const sqlite3 = require('better-sqlite3');

const DB_PATH = process.argv[2] || 'data/webui/fusion_memory.db';
const db = sqlite3(DB_PATH);

console.log('=== anchor_score 回填 ===');

// 1. 统计
const totalAnchors = db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE id LIKE '%_ANCHOR'").get();
const nullAnchor = db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE id LIKE '%_ANCHOR' AND (anchor_score IS NULL OR anchor_score = 0)").get();
console.log(`锚点总数: ${totalAnchors.cnt}`);
console.log(`anchor_score 为 NULL/0: ${nullAnchor.cnt}`);

if (nullAnchor.cnt === 0) {
  console.log('✅ 无需修复');
  db.close();
  process.exit(0);
}

// 2. 备份
const backupPath = DB_PATH + '.backup-anchor-fix-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db';
const backupDb = sqlite3(backupPath);
backupDb.exec("ATTACH DATABASE '" + DB_PATH.replace(/'/g, "''") + "' AS source");
backupDb.exec('CREATE TABLE IF NOT EXISTS memories_backup AS SELECT * FROM source.memories');
backupDb.close();
console.log('备份:', backupPath);

// 3. 按 dialog_group_id 分组回填
// 策略：同组锚点的 anchor_score = 该组 maxCalcium（从 calcium_score 派生）
console.log('\n开始回填...');

const groups = db.prepare(`
  SELECT dialog_group_id, MAX(calcium_score) as maxCalcium
  FROM memories
  WHERE dialog_group_id IS NOT NULL AND dialog_group_id != ''
  GROUP BY dialog_group_id
`).all();

let updated = 0;
for (const group of groups) {
  const result = db.prepare(`
    UPDATE memories 
    SET anchor_score = ?
    WHERE dialog_group_id = ? AND id LIKE '%_ANCHOR'
  `).run(group.maxCalcium, group.dialog_group_id);
  
  updated += result.changes;
}

console.log(`更新锚点: ${updated} 条`);

// 4. 验证
const afterNull = db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE id LIKE '%_ANCHOR' AND (anchor_score IS NULL OR anchor_score = 0)").get();
const sample = db.prepare("SELECT id, anchor_score, calcium_score FROM memories WHERE id LIKE '%_ANCHOR' ORDER BY rowid DESC LIMIT 5").all();

console.log('\n=== 修正后验证 ===');
console.log('anchor_score 为 NULL/0:', afterNull.cnt);
console.log('样本:');
sample.forEach(s => console.log(`  ${s.id}: anchor=${s.anchor_score}, calcium=${s.calcium_score}`));

db.close();
console.log('\n✅ anchor_score 回填完成');
