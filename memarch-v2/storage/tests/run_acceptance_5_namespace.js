/**
 * Step 5: 命名空间隔离测试（零泄露验收）
 * 验收项: namespace='test' / roleplay_char / tombstone 数据在生产视图中完全不可见
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database('D:/tools/wenstar-cc/data/memarch_acceptance_test.db');

console.log('='.repeat(70));
console.log('[Step 5.1] 加载测试夹具 fixtures/test_data.sql');
console.log('='.repeat(70));

db.exec(readFileSync(join(__dirname, 'fixtures', 'test_data.sql'), 'utf-8'));

const convTotal = db.prepare(`SELECT COUNT(*) c FROM conversations`).get().c;
const memTotal = db.prepare(`SELECT COUNT(*) c FROM memories`).get().c;
console.log(`  conversations 总行数: ${convTotal}`);
console.log(`  memories 总行数: ${memTotal}`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 5.2] v_conv_real 生产视图内容（应只含 default + 非角色 + 非tombstone）');
console.log('='.repeat(70));
const convReal = db.prepare(`SELECT message_id, namespace, roleplay_char, lifecycle_state FROM v_conv_real ORDER BY message_id`).all();
for (const r of convReal) {
  console.log(`  - ${r.message_id} (ns=${r.namespace}, roleplay=${r.roleplay_char ?? 'null'}, state=${r.lifecycle_state})`);
}
const convRealCount = convReal.length;
const convTestCount = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE namespace='test'`).get().c;
const convRoleplayCount = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE roleplay_char IS NOT NULL AND roleplay_char != ''`).get().c;
const convTombCount = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE lifecycle_state='tombstone'`).get().c;

console.log('');
console.log('  隔离校验:');
console.log(`    namespace='test' 行数: ${convTestCount}（必须 0 出现在 v_conv_real）`);
console.log(`    roleplay_char 非空:   ${convRoleplayCount}（必须 0 出现在 v_conv_real）`);
console.log(`    lifecycle=tombstone:  ${convTombCount}（必须 0 出现在 v_conv_real）`);

// 关键断言
const leak = db.prepare(`
  SELECT COUNT(*) c FROM v_conv_real
  WHERE namespace='test'
     OR (roleplay_char IS NOT NULL AND roleplay_char != '')
     OR lifecycle_state IN ('tombstone','purged')
`).get().c;
console.log(`    >>> v_conv_real 泄漏行数: ${leak}（必须为 0）`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 5.3] v_mem_real 生产视图内容');
console.log('='.repeat(70));
const memReal = db.prepare(`SELECT id, namespace, lifecycle_state FROM v_mem_real ORDER BY id`).all();
for (const r of memReal) {
  console.log(`  - ${r.id} (ns=${r.namespace}, state=${r.lifecycle_state})`);
}
const memLeak = db.prepare(`
  SELECT COUNT(*) c FROM v_mem_real
  WHERE namespace='test' OR lifecycle_state IN ('tombstone','purged')
`).get().c;
console.log(`    >>> v_mem_real 泄漏行数: ${memLeak}（必须为 0）`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 5.4] 测试视图 v_conv_test / v_mem_test（仅测试代码可见）');
console.log('='.repeat(70));
const convTest = db.prepare(`SELECT COUNT(*) c FROM v_conv_test`).get().c;
const memTest = db.prepare(`SELECT COUNT(*) c FROM v_mem_test`).get().c;
console.log(`  v_conv_test 行数: ${convTest}（应等于 namespace='test' 的行数）`);
console.log(`  v_mem_test 行数:  ${memTest}（应等于 namespace='test' 的行数）`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 5.5] FTS5 中文分词冒烟');
console.log('='.repeat(70));
const ftsResult = db.prepare(`
  SELECT c.message_id FROM fts_conversations
  JOIN conversations c ON c.id = fts_conversations.rowid
  WHERE fts_conversations MATCH '深圳湾'
`).all();
console.log(`  搜索 '深圳湾' 命中 ${ftsResult.length} 条: ${ftsResult.map(r => r.message_id).join(', ')}`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 5.6] 审计账本 append-only 红线');
console.log('='.repeat(70));
try {
  db.prepare(`UPDATE audit_ledger SET action='hacked' WHERE seq=1`).run();
  console.log('  ❌ UPDATE 未被拦截！');
} catch (e) {
  console.log(`  ✅ UPDATE 被触发器拦截: ${e.message}`);
}
try {
  db.prepare(`DELETE FROM audit_ledger WHERE seq=1`).run();
  console.log('  ❌ DELETE 未被拦截！');
} catch (e) {
  console.log(`  ✅ DELETE 被触发器拦截: ${e.message}`);
}

db.close();

const allPass = leak === 0 && memLeak === 0 && ftsResult.length > 0;
console.log('');
console.log(`[Step 5 结论] 命名空间零泄露: ${allPass ? '✅ 全部通过' : '❌ 存在泄漏'}`);
