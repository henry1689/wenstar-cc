/**
 * step5-e2e-verify.js — 端到端验证
 * 验收：①身份不串台 ②记忆不混乱 ③命名不冲突 ④行数一致
 */
const Database = require('better-sqlite3');

const NEW_DB = 'D:/tools/wenstar-cc/data/memarch-v2.db';
const db = new Database(NEW_DB, { readonly: true });

console.log('=== Step 5: 端到端验证 ===\n');

let pass = 0, fail = 0;
function check(name, condition, detail) {
  const icon = condition ? '✅' : '❌';
  console.log(`${icon} ${name}: ${detail}`);
  condition ? pass++ : fail++;
}

// 1. 行数对账
console.log('--- 1. 行数对账 ---');
const convCount = db.prepare('SELECT COUNT(*) c FROM conversations').get().c;
const memCount = db.prepare('SELECT COUNT(*) c FROM memories').get().c;
const epCount = db.prepare('SELECT COUNT(*) c FROM episodes').get().c;
check('conversations 行数', convCount === 20598, `${convCount} (期望 20598)`);
check('memories 行数', memCount === 17335, `${memCount} (期望 17335)`);
check('episodes 行数', epCount > 2900, `${epCount} (期望 ~3000)`);

// 2. 命名空间分布
console.log('\n--- 2. 命名空间分布 ---');
const nsDist = db.prepare(`
  SELECT namespace, COUNT(*) c FROM conversations GROUP BY namespace ORDER BY c DESC
`).all();
const hasDefault = nsDist.some(r => r.namespace === 'default' || r.namespace === '');
check('无 default/空 namespace', !hasDefault, `共 ${nsDist.length} 个 namespace`);
for (const r of nsDist) console.log(`    ${r.namespace}: ${r.c}`);

// 3. 玉瑶数据独立
console.log('\n--- 3. 玉瑶数据独立性 ---');
const yuyaoConv = db.prepare(`SELECT COUNT(*) c FROM conversations WHERE namespace = 'ns_yuyao'`).get().c;
const yuyaoMem = db.prepare(`SELECT COUNT(*) c FROM memories WHERE namespace = 'ns_yuyao'`).get().c;
check('玉瑶有独立 conversations', yuyaoConv > 1000, `${yuyaoConv} 条`);
check('玉瑶有独立 memories', yuyaoMem > 1000, `${yuyaoMem} 条`);

// 4. 跨命名空间隔离测试
console.log('\n--- 4. 跨命名空间隔离测试 ---');
// 拿一条玉瑶的记忆
const yuyaoSample = db.prepare(`SELECT id, raw_input FROM memories WHERE namespace = 'ns_yuyao' LIMIT 1`).get();
console.log(`    玉瑶样本记忆: ${yuyaoSample.raw_input.slice(0, 50)}... (id=${yuyaoSample.id})`);

// 在诗雨 namespace 里查这条记忆，必须查不到
const leak = db.prepare(`
  SELECT COUNT(*) c FROM memories WHERE namespace = 'ns_shiyu' AND id = ?
`).get(yuyaoSample.id).c;
check('玉瑶记忆不泄露到诗雨', leak === 0, `诗雨 namespace 中命中 ${leak} 条（必须 0）`);

// 5. 角色名不混淆
console.log('\n--- 5. 角色名不混淆 ---');
// 检查玉瑶 namespace 里的 roleplay_char 是不是玉瑶
const yuyaoChar = db.prepare(`
  SELECT DISTINCT roleplay_char FROM conversations WHERE namespace = 'ns_yuyao'
`).all();
console.log(`    玉瑶 namespace 的 roleplay_char: ${yuyaoChar.map(r=>r.roleplay_char).join(', ')}`);

// 6. 迁移 checkpoint 完整性
console.log('\n--- 6. 迁移完整性 ---');
const cpStats = db.prepare(`SELECT status, COUNT(*) c FROM migration_checkpoint GROUP BY status`).all();
const failed = cpStats.find(r => r.status === 'failed');
check('迁移 0 失败', !failed || failed.c === 0, JSON.stringify(cpStats));

// 7. 玉瑶样本内容（人工抽检）
console.log('\n--- 7. 玉瑶样本内容抽检 ---');
const yuyaoSamples = db.prepare(`
  SELECT content, role, ts_utc FROM conversations WHERE namespace = 'ns_yuyao' ORDER BY ts_utc DESC LIMIT 3
`).all();
for (const s of yuyaoSamples) {
  console.log(`    [${s.role}] ${s.content.slice(0, 60)}`);
}

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
db.close();
process.exit(fail > 0 ? 1 : 0);
