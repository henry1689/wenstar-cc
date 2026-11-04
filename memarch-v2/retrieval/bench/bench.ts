// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / bench/bench.ts
// 性能基准：万级合成数据，跑 N 次 retrieve，输出 p50/p95/p99
// 用法：npx ts-node bench/bench.ts
// =====================================================================

import { buildTestDb } from '../__tests__/helpers/db_factory';
import { Retriever } from '../index';

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const N_MEM = 10000; // 万级条目
  const N_RUNS = 200;

  console.log(`[bench] building synthetic DB with ${N_MEM} memories ...`);
  const t0 = Date.now();
  const db = buildTestDb({ n_memories: N_MEM, n_facts: 500, n_blackdiamond: 50, n_prospective: 20 });
  console.log(`[bench] DB ready in ${Date.now() - t0}ms`);

  const retriever = new Retriever(db);

  const queries = [
    '电机定子绕组绝缘漆工艺参数',
    '客户询价东莞德恒电机交期',
    '晨练固定器械深蹲膝盖内侧疼痛',
    '最近三天我聊了什么？',
    '为什么深蹲会膝盖内侧疼？',
    'WenStar OS 记忆架构 UUID 钙化存储',
    '太极拳平衡能力训练全因死亡率',
    '蛋白粉与善存补充剂摄入策略',
    '间歇性断食热量限制寿命实验',
    '上周客户投诉轴承异响怎么处理？',
  ];

  const total: number[] = [];
  const qu: number[] = [];
  const rc: number[] = [];
  const rr: number[] = [];

  console.log(`[bench] running ${N_RUNS} retrievals ...`);
  for (let i = 0; i < N_RUNS; i++) {
    const q = queries[i % queries.length];
    const tStart = Date.now();
    // namespace 必填；buildTestDb 造的数据落在 'default'
    const res = await retriever.retrieve(q, 'default');
    const tEnd = Date.now();
    total.push(tEnd - tStart);
    qu.push(res.metrics.phase_ms.query_understand);
    rc.push(res.metrics.phase_ms.recall_total);
    rr.push(res.metrics.phase_ms.rerank);
  }

  total.sort((a, b) => a - b);
  qu.sort((a, b) => a - b);
  rc.sort((a, b) => a - b);
  rr.sort((a, b) => a - b);

  const report = (name: string, arr: number[]) => {
    console.log(`  ${name.padEnd(20)} p50=${percentile(arr, 50).toFixed(1).padStart(7)}ms  p95=${percentile(arr, 95).toFixed(1).padStart(7)}ms  p99=${percentile(arr, 99).toFixed(1).padStart(7)}ms  max=${arr[arr.length - 1].toFixed(1).padStart(7)}ms`);
  };

  console.log('\n========== BENCHMARK REPORT ==========');
  console.log(`Dataset: ${N_MEM} memories, 500 facts, 50 black diamonds, 20 prospective`);
  console.log(`Runs: ${N_RUNS}`);
  console.log('');
  report('query_understand', qu);
  report('recall_parallel', rc);
  report('rerank', rr);
  report('TOTAL', total);
  console.log('');

  // 验收标准
  const p95Total = percentile(total, 95);
  const p95Qu = percentile(qu, 95);
  const p95Rc = percentile(rc, 95);
  const p95Rr = percentile(rr, 95);
  console.log('========== ACCEPTANCE ==========');
  console.log(`  total p95 <= 400ms   : ${p95Total.toFixed(1)}ms  ${p95Total <= 400 ? 'PASS' : 'FAIL'}`);
  console.log(`  qu    p95 <= 50ms    : ${p95Qu.toFixed(1)}ms  ${p95Qu <= 50 ? 'PASS' : 'FAIL'}`);
  console.log(`  recall p95 <= 120ms  : ${p95Rc.toFixed(1)}ms  ${p95Rc <= 120 ? 'PASS' : 'FAIL'}`);
  console.log(`  rerank p95 <= 200ms  : ${p95Rr.toFixed(1)}ms  ${p95Rr <= 200 ? 'PASS' : 'FAIL'}`);
  console.log('=================================');

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
