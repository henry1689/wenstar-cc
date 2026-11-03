/**
 * M2 性能基准测试
 * 实测：在线写入 p95 延迟、事件分割 p95、崩溃恢复时间
 *
 * 运行：npx tsx memarch-v2/online_write/tests/benchmark_online_write.js
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryWriter } from '../MemoryWriter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function createBenchDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const ddlPath = join(__dirname, '..', '..', 'storage', 'ddl', '01_schema_init.sql');
  db.exec(readFileSync(ddlPath, 'utf-8'));
  return db;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

async function benchmark() {
  console.log('='.repeat(60));
  console.log('MemArch-v2 M2 在线写入性能基准');
  console.log('='.repeat(60));

  const db = createBenchDb();
  const writer = new MemoryWriter(db);

  // ===== 预热 =====
  for (let i = 0; i < 20; i++) {
    await writer.write({
      message_id: `warmup_${i}`,
      namespace: 'default',
      role: 'user',
      content: `预热消息 ${i}，测试基础性能`,
      arousal: 0.3,
    });
  }

  // ===== 测试 1：在线写入延迟（200 条） =====
  console.log('\n[测试 1] 在线写入延迟（200 条）');
  const latencies = [];
  const testMessages = [
    '你好', '谢谢', '好的',
    '今天天气不错，出去走了走',
    '我决定下个月辞职创业，人生第一次很激动',
    '我妈妈今天生日，买了个蛋糕',
    '明天下午三点开会，别忘了',
    '我们公司这周做季度总结',
    '电机的绝缘漆工艺需要改进',
    '对了，周末想去松山湖骑行',
  ];

  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    await writer.write({
      message_id: `bench_${i}`,
      namespace: 'default',
      role: 'user',
      content: testMessages[i % testMessages.length],
      arousal: 0.4,
    });
    latencies.push(performance.now() - start);
  }

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  console.log(`  平均延迟: ${avg.toFixed(2)} ms`);
  console.log(`  p50: ${p50.toFixed(2)} ms`);
  console.log(`  p95: ${p95.toFixed(2)} ms`);
  console.log(`  p99: ${p99.toFixed(2)} ms`);
  console.log(`  验收标准: p95 ≤ 30ms → ${p95 <= 30 ? '✅ PASS' : '❌ FAIL'}`);

  // ===== 测试 2：事件分割器延迟 =====
  console.log('\n[测试 2] 事件分割器延迟（1000 次调用）');
  const { EventSegmenter } = await import('../EventSegmenter.js');
  const seg = new EventSegmenter();
  const segLatencies = [];
  const history = [];
  for (let i = 0; i < 5; i++) {
    history.push({ ts: Date.now() - i * 60_000, text: `历史消息${i}`, arousal: 0.3 });
  }

  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    seg.isBoundary(history, { ts: Date.now(), text: `当前消息${i}`, arousal: 0.3 });
    segLatencies.push(performance.now() - start);
  }

  const segP95 = percentile(segLatencies, 95);
  console.log(`  p95: ${segP95.toFixed(3)} ms`);
  console.log(`  验收标准: ≤ 10ms → ${segP95 <= 10 ? '✅ PASS' : '❌ FAIL'}`);

  // ===== 测试 3：崩溃恢复时间（100 条 pending） =====
  console.log('\n[测试 3] 崩溃恢复时间（100 条 pending）');
  // 清空当前 writer 状态，直接插入 100 条 pending
  db.exec('DELETE FROM wm_buffer');
  for (let i = 0; i < 100; i++) {
    const entry = {
      message_id: `recover_${i}`,
      namespace: 'default',
      role: 'user',
      content: `待恢复的消息 ${i}，包含一些需要处理的内容`,
      ts_utc: Date.now(),
      salience: 0.5,
      salience_components: { imp_rule: 0.4, self_rule: 0.3, arousal: 0.4, nov_rule: 0.3, ent: 0.4 },
      has_meaningful_entity: true,
    };
    db.prepare(
      `INSERT INTO wm_buffer (payload, status, ts_utc) VALUES (?, 'pending', ?)`
    ).run(JSON.stringify(entry), Date.now());
  }

  const writer2 = new MemoryWriter(db);
  const recoverStart = performance.now();
  const { recovered, failed } = await writer2.recover();
  const recoverTime = performance.now() - recoverStart;

  console.log(`  恢复条数: ${recovered} 成功, ${failed} 失败`);
  console.log(`  总耗时: ${recoverTime.toFixed(2)} ms`);
  console.log(`  验收标准: 100 条 ≤ 5000ms → ${recoverTime <= 5000 ? '✅ PASS' : '❌ FAIL'}`);

  // ===== 测试 4：门控分布统计 =====
  console.log('\n[测试 4] 门控分布统计（200 条混合消息）');
  const stats = writer.getGateStats();
  const total = stats.total;
  const writePct = (stats.write / total * 100).toFixed(1);
  const rawPct = (stats.rawOnly / total * 100).toFixed(1);
  const discardPct = (stats.discard / total * 100).toFixed(1);

  console.log(`  WRITE:     ${stats.write} 条 (${writePct}%)`);
  console.log(`  RAW_ONLY:  ${stats.rawOnly} 条 (${rawPct}%)`);
  console.log(`  DISCARD:    ${stats.discard} 条 (${discardPct}%)`);
  console.log(`  WRITE 健康区间 15%-35%: ${writePct >= 15 && writePct <= 35 ? '✅' : '⚠️'}`);
  console.log(`  DISCARD 健康区间 30%-50%: ${discardPct >= 30 && discardPct <= 50 ? '✅' : '⚠️'}`);

  // ===== 汇总 =====
  console.log('\n' + '='.repeat(60));
  console.log('性能基准汇总');
  console.log('='.repeat(60));
  console.log(`  在线写入 p95:    ${p95.toFixed(2)} ms  (目标 ≤ 30ms)  ${p95 <= 30 ? '✅' : '❌'}`);
  console.log(`  事件分割 p95:    ${segP95.toFixed(3)} ms (目标 ≤ 10ms)  ${segP95 <= 10 ? '✅' : '❌'}`);
  console.log(`  崩溃恢复(100条): ${recoverTime.toFixed(2)} ms  (目标 ≤ 5000ms) ${recoverTime <= 5000 ? '✅' : '❌'}`);
  console.log('='.repeat(60));

  db.close();
}

benchmark().catch(console.error);
