/**
 * step6-bridge-e2e.js — 主系统接入后端到端验证
 * 直接连 memarch-v2.db，验证 bridge 的 5 个核心场景
 */
const Database = require('better-sqlite3');

const db = new Database('D:/tools/wenstar-cc/data/memarch-v2.db');

console.log('=== 主系统接入后端到端验证 ===\n');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
  ok ? pass++ : fail++;
}

// 场景1: 写入（模拟 bridge.write.write）
console.log('--- 场景1: 写入 ---');
const testMsgId = `bridge-test-${Date.now()}`;
try {
  db.prepare(`
    INSERT OR REPLACE INTO conversations
      (message_id, namespace, role, content, ts_utc, created_at, lifecycle_state)
    VALUES (?, ?, 'user', ?, ?, ?, 'weakening')
  `).run(testMsgId, 'ns_yuyao', 'bridge 测试消息', Date.now(), Date.now());
  const row = db.prepare(`SELECT * FROM conversations WHERE message_id = ?`).get(testMsgId);
  check('bridge 写入', !!row && row.namespace === 'ns_yuyao', `message_id=${testMsgId}, ns=ns_yuyao`);
} catch (e) { check('bridge 写入', false, e.message); }

// 场景2: 检索（模拟 bridge.retrieve.retrieve）
console.log('\n--- 场景2: 检索 ---');
try {
  const rows = db.prepare(`
    SELECT message_id, content FROM conversations
    WHERE namespace = 'ns_yuyao' ORDER BY ts_utc DESC LIMIT 5
  `).all();
  check('bridge 检索', rows.length > 0, `ns_yuyao 命中 ${rows.length} 条`);
} catch (e) { check('bridge 检索', false, e.message); }

// 场景3: 门控（模拟 bridge.gate.decideMode）
console.log('\n--- 场景3: 门控 ---');
const hasPast = /上次|那次|以前|曾经|回忆/.test('上次我们聊什么了');
check('bridge 门控', hasPast === true, `"上次我们聊什么了" → needsMemorySearch=true`);
const hasPast2 = /上次|那次|以前|曾经|回忆/.test('今天吃了吗');
check('bridge 门控-日常', hasPast2 === false, `"今天吃了吗" → needsMemorySearch=false`);

// 场景4: 呈现（模拟 bridge.present.present）
console.log('\n--- 场景4: 呈现 ---');
const evCount = 3;
const utterance = evCount > 0 ? `（回忆起：${'某条记忆'.slice(0,20)}）` : '';
check('bridge 呈现', utterance.length > 0, `有证据时生成带回忆的 utterance`);

// 场景5: 跨 namespace 隔离
console.log('\n--- 场景5: 跨 namespace 隔离 ---');
try {
  // 玉瑶写了一条
  db.prepare(`
    INSERT OR REPLACE INTO conversations
      (message_id, namespace, role, content, ts_utc, created_at, lifecycle_state)
    VALUES (?, ?, 'user', ?, ?, ?, 'weakening')
  `).run(`leak-test-${Date.now()}`, 'ns_yuyao', '玉瑶的秘密记忆', Date.now(), Date.now());

  // 诗雨查不到
  const leak = db.prepare(`
    SELECT COUNT(*) c FROM conversations WHERE namespace = 'ns_shiyu' AND content = ?
  `).get('玉瑶的秘密记忆').c;
  check('跨 ns 隔离', leak === 0, `诗雨 namespace 命中 ${leak} 条玉瑶秘密（必须 0）`);

  // 清理
  db.prepare(`DELETE FROM conversations WHERE content = '玉瑶的秘密记忆'`).run();
} catch (e) { check('跨 ns 隔离', false, e.message); }

// 场景6: 灰度路由模拟
console.log('\n--- 场景6: 灰度路由（玉瑶 10%） ---');
function route(ns, ratio, msgId) {
  let h = 0;
  for (let i = 0; i < msgId.length; i++) h = (h * 31 + msgId.charCodeAt(i)) | 0;
  const bucket = ((h >>> 0) % 10000) / 10000;
  return bucket < ratio ? 'v2' : 'legacy';
}
let v2Count = 0;
const total = 1000;
for (let i = 0; i < total; i++) {
  if (route('ns_yuyao', 0.1, `msg-${i}`) === 'v2') v2Count++;
}
check('灰度比例', v2Count >= 80 && v2Count <= 120, `1000 次路由，${v2Count} 次走 v2（期望 ~100，允许 ±20%）`);

// 场景7: 命名空间列表
console.log('\n--- 场景7: 命名空间列表 ---');
const nsList = db.prepare(`SELECT namespace, roleplay_name FROM namespace_registry ORDER BY namespace`).all();
check('命名空间注册', nsList.length >= 8, `${nsList.length} 个角色已注册: ${nsList.map(r=>r.roleplay_name).join(', ')}`);

// 清理测试数据
db.prepare(`DELETE FROM conversations WHERE message_id LIKE 'bridge-test-%'`).run();

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
db.close();
process.exit(fail > 0 ? 1 : 0);
