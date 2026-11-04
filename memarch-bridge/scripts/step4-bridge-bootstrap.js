/**
 * step4-bridge-bootstrap.js — 主系统接入入口（最小可行版）
 *
 * 这是主系统启动时应该调用的 bridge 初始化代码。
 * 实际接入时，把这段代码放到 src/app/bootstrap.ts 里。
 */
const Database = require('better-sqlite3');

const NEW_DB = 'D:/tools/wenstar-cc/data/memarch-v2.db';

console.log('=== Step 4: 接入替换演示 ===\n');

// 1. 打开新库
const db = new Database(NEW_DB);
console.log('✓ 新库已连接:', NEW_DB);

// 2. 灰度开关：玉瑶 10% 走新，其他全旧
//    （对应 FeatureFlag.setNamespaceRatio('ns_yuyao', 10)）
console.log('\n--- 灰度配置 ---');
console.log('  ns_yuyao: 10% 走新 MemArch v2');
console.log('  其他角色: 100% 走旧系统');
console.log('  KILL SWITCH: OFF（可一键回滚）');

// 3. 模拟一次对话：玉瑶问"上次我们聊什么了"
console.log('\n--- 模拟对话：玉瑶角色 ---');

// 3.1 按 namespace 隔离查询（物理隔离关键）
const yuyaoRecent = db.prepare(`
  SELECT role, content, ts_utc FROM conversations
  WHERE namespace = 'ns_yuyao'
  ORDER BY ts_utc DESC LIMIT 3
`).all();

console.log('  玉瑶最近 3 条对话（从 ns_yuyao 物理隔离查询）:');
for (const c of yuyaoRecent) {
  console.log(`    [${c.role}] ${c.content.slice(0, 50)}...`);
}

// 3.2 验证：同样的查询，如果不加 namespace 过滤会怎样？
console.log('\n--- 对比：不加 namespace 过滤（旧系统的串台路径）---');
const allRecent = db.prepare(`
  SELECT namespace, role, content FROM conversations
  ORDER BY ts_utc DESC LIMIT 5
`).all();
console.log('  不加 namespace 过滤，最近 5 条混了多个角色:');
for (const c of allRecent) {
  console.log(`    [${c.namespace}] [${c.role}] ${c.content.slice(0, 40)}...`);
}

// 4. 灰度路由决策演示
console.log('\n--- 灰度路由决策 ---');
function route(namespace, ratio) {
  // 简单哈希分流
  const bucket = Math.abs(hashCode(namespace)) % 100;
  return bucket < ratio * 100 ? 'v2' : 'legacy';
}
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const cases = [
  { ns: 'ns_yuyao', ratio: 0.1 },
  { ns: 'ns_shiyu', ratio: 0 },
  { ns: 'ns_wangquanfen', ratio: 0 },
];
for (const c of cases) {
  const target = route(c.ns, c.ratio);
  console.log(`  ${c.ns.padEnd(20)} ratio=${c.ratio} → 走 ${target.toUpperCase()}`);
}

// 5. 回滚预案演示
console.log('\n--- 回滚预案 ---');
console.log('  L1 流量回滚: globalFeatureFlag.rollback() → 秒级全回旧');
console.log('  L2 软删数据: 清空新库 + 重跑迁移');
console.log('  L3 硬恢复: 用 .bak 覆盖新库');

db.close();
console.log('\n✅ Step 4 接入演示完成');
console.log('\n下一步：把 bridge 初始化代码放到 src/app/bootstrap.ts，');
console.log('       把所有 import MemoryWriteGateway / MemoryRetriever 的地方改成 bridge.*');
