/**
 * MemArch-v2 端到端联调测试
 * 链路：用户输入 → M2 在线写入 → M1 存储 → M3 睡眠巩固
 *        → 用户提问 → M4 检索 → M5 呈现 → M6 安全治理
 *
 * 运行方式：tsx e2e-test/run-e2e.ts
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMARCH_ROOT = join(__dirname, '..');
const GOVERNANCE_ROOT = join(MEMARCH_ROOT, '..', 'governance');

// ============================================================
// 1. 初始化内存数据库（执行完整 DDL）
// ============================================================
function initMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 按顺序执行 DDL
  const ddlDir = join(MEMARCH_ROOT, 'storage', 'ddl');
  const ddlFiles = readdirSync(ddlDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of ddlFiles) {
    const sql = readFileSync(join(ddlDir, f), 'utf-8');
    try {
      db.exec(sql);
    } catch (e: any) {
      console.warn(`[DDL] ${f} 执行警告: ${e.message}`);
    }
  }

  // fts_memories / fts_episodes 已在 03_fts5.sql 中正式定义（独立 FTS 表模式）
  return db;
}

// ============================================================
// 2. 性能统计工具
// ============================================================
class LatencyStats {
  private samples: number[] = [];
  record(ms: number) { this.samples.push(ms); }
  p(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length));
    return +sorted[idx].toFixed(3);
  }
  get count() { return this.samples.length; }
  summary() {
    return { p50: this.p(50), p95: this.p(95), p99: this.p(99), min: this.samples.length ? Math.min(...this.samples) : 0, max: this.samples.length ? Math.max(...this.samples) : 0 };
  }
}

// ============================================================
// 3. Mock M5 依赖
// ============================================================
function makeMockDeps() {
  return {
    reinforceSink: { reinforce: (uuid: string, signal: string) => { /* mock */ } },
    writeSink: { write: (input: any) => ({ trace_id: 'tr_mock', gate: 'WRITE' }) },
    pathwayStore: {
      getPathway: (_uuid: string) => 'A' as const,
      promoteToA: (_uuid: string, _boost: number) => {},
      getReinforcementCount: (_uuid: string) => 0,
      bumpReinforcement: (_uuid: string) => 1,
    },
  };
}

// ============================================================
// 4. 主流程
// ============================================================
async function main() {
  console.log('='.repeat(70));
  console.log('MemArch-v2 端到端联调测试');
  console.log('='.repeat(70));

  const issues: Array<{ module: string; severity: 'P0'|'P1'|'P2'; description: string; status: string }> = [];

  // ---- 4.1 初始化 DB ----
  const db = initMemoryDb();
  console.log('\n[1] 内存数据库初始化完成');

  // ---- 4.2 加载 M2 MemoryWriter ----
  const { MemoryWriter } = await import('../online_write/MemoryWriter.js');
  const writer = new MemoryWriter(db);
  console.log('[2] M2 MemoryWriter 实例化完成');

  // ---- 4.3 加载 M6 审计日志（先初始化，再接入 WriteQueue 统一审计钩子） ----
  // 路径：e2e-test/ -> memarch-v2/ -> wenstar-cc/ -> governance/src/
  const auditLog = await import('../../governance/src/auditLog.js').catch(() => null);
  let auditAvailable = false;
  if (auditLog) {
    auditLog._resetForTest();
    auditAvailable = true;
    // P1-5 修复：审计钩子统一接入 WriteQueue.enqueue 路径，所有入队写操作自动留痕
    writer.getWriteQueue().setAuditHook({
      onWriteCompleted: (task) => {
        auditLog.log({
          subject: 'WriteQueue',
          action: task.operation,
          resource: `priority=${task.priority}`,
          result: task.success ? 'success' : 'failure',
          metadata: { durationMs: task.durationMs, error: task.error },
        });
      },
    });
    console.log('[3] M6 AuditLog 已统一接入 WriteQueue 审计钩子');
  } else {
    issues.push({ module: 'M6', severity: 'P0', description: 'governance/auditLog 模块加载失败', status: '未接入' });
    console.log('[3] ⚠ M6 AuditLog 加载失败，跳过审计接入');
  }

  // ---- 4.4 写入测试记忆（跑 N 次采集性能） ----
  console.log('\n[4] 写入测试记忆（50 次采样）...');
  const writeLatency = new LatencyStats();
  const testMessages = [
    '我今天去东莞松山湖跑了半程马拉松，第一次跑这么远，很激动',
    '我决定下个月辞职创业，和朋友合伙开一家电机公司',
    '我妈妈今天生日，我给她买了个蛋糕，很开心',
    '我们公司这周要做季度总结，我是研发总监，管电机团队',
    '对了，明天下午三点有个技术评审会，别忘了准备 PPT',
  ];

  let lastWriteResult: any = null;
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    try {
      lastWriteResult = await writer.write({
        message_id: `e2e_msg_${i}`,
        namespace: 'default',
        role: 'user',
        content: testMessages[i % testMessages.length],
        arousal: 0.6 + (i % 10) * 0.03,
      });
      writeLatency.record(performance.now() - t0);
    } catch (e: any) {
      if (i < 5) console.error(`  写入 #${i} 失败详情:`, e.code, e.message);
      issues.push({ module: 'M2', severity: 'P0', description: `写入 #${i} 异常: ${e.message}`, status: '失败' });
    }
  }

  const convCount = db.prepare("SELECT COUNT(*) as c FROM conversations").get() as any;
  const memCount = db.prepare("SELECT COUNT(*) as c FROM memories").get() as any;
  console.log(`  conversations 表: ${convCount.c} 条`);
  console.log(`  memories 表: ${memCount.c} 条`);
  const wStats = writeLatency.summary();
  console.log(`  写入延迟 p50/p95/p99: ${wStats.p50} / ${wStats.p95} / ${wStats.p99} ms`);

  if (lastWriteResult) {
    console.log(`  最后一条 gate=${lastWriteResult.gate}, salience=${lastWriteResult.salience.toFixed(3)}, trace_id=${lastWriteResult.trace_id ?? '无'}`);
  }

  // ---- 4.5 跑 M3 睡眠巩固 ----
  console.log('\n[5] M3 睡眠巩固...');
  try {
    const { SleepOrchestrator } = await import('../sleep_consolidation/pipeline/SleepOrchestrator.js');
    const { loadSleepConfig } = await import('../sleep_consolidation/config/index.js');
    const sleepConfig = loadSleepConfig({
      MEMARCH_NAMESPACE: 'default',
      MEMORY_FORGET_ENABLED: '1',
      LLM_SALIENCE_ENABLED: '0',
      LLM_GIST_ENABLED: '0',
    });
    const orchestrator = new SleepOrchestrator(db, sleepConfig, writer.getWriteQueue());
    const t0 = performance.now();
    const metrics = await orchestrator.execute('main', false);
    const sleepLatency = performance.now() - t0;
    console.log(`  睡眠状态: ${metrics.status}`);
    console.log(`  总耗时: ${sleepLatency.toFixed(1)} ms`);
    console.log(`  步骤数: ${metrics.stepResults.length}`);
    for (const r of metrics.stepResults) {
      console.log(`    - ${r.stepName}: ${r.status} (${r.durationMs.toFixed(1)}ms, ${r.itemsProcessed} items)`);
    }
    // P1-5 修复：M3 审计已通过 WriteQueue 统一钩子自动留痕，无需手动调用
  } catch (e: any) {
    console.error(`  M3 睡眠巩固失败:`, e.message);
    issues.push({ module: 'M3', severity: 'P1', description: `睡眠执行异常: ${e.message}`, status: '失败' });
  }

  // ---- 4.6 M4 检索 ----
  console.log('\n[6] M4 检索...');
  let retrieveLatency = new LatencyStats();
  let evidenceCount = 0;
  let lastRetrievalResult: any = { evidence: [], metrics: {} };
  try {
    const { Retriever } = await import('../retrieval/index.js');
    const retriever = new Retriever(db);
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      // namespace 是必填的隔离边界；本脚本的数据写入用的是 'default'（见下方 write 调用）
      const result = await retriever.retrieve('创业 电机公司 妈妈生日', 'default');
      retrieveLatency.record(performance.now() - t0);
      evidenceCount = result.evidence.length;
      lastRetrievalResult = result;
    }
    console.log(`  检索到证据: ${evidenceCount} 条`);
    const rStats = retrieveLatency.summary();
    console.log(`  检索延迟 p50/p95/p99: ${rStats.p50} / ${rStats.p95} / ${rStats.p99} ms`);
    if (evidenceCount > 0) {
      console.log(`  首条证据: ${JSON.stringify(lastRetrievalResult.evidence[0]).slice(0, 200)}`);
    }
  } catch (e: any) {
    console.error(`  M4 检索失败:`, e.message);
    issues.push({ module: 'M4', severity: 'P1', description: `检索异常: ${e.message}`, status: '失败' });
  }

  // ---- 4.7 M5 呈现 ----
  console.log('\n[7] M5 呈现...');
  let presentLatency = new LatencyStats();
  try {
    const { PresentationEngine } = await import('../presentation/index.js');
    const engine = new PresentationEngine(makeMockDeps());
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const result = engine.present({
        evidences: lastRetrievalResult.evidence,
        user_query: '我之前说过要创业做什么来着？',
      });
      presentLatency.record(performance.now() - t0);
    }
    const finalResult = engine.present({
      evidences: lastRetrievalResult.evidence,
      user_query: '我之前说过要创业做什么来着？',
    });
    console.log(`  utterance: "${finalResult.utterance}"`);
    console.log(`  label: ${finalResult.label}, routed_path: ${finalResult.routed_path}, p_A: ${finalResult.p_A.toFixed(3)}`);
    console.log(`  guard_passed: ${finalResult.guard_passed}, used_uuids: ${finalResult.used_uuids.length}`);
    const pStats = presentLatency.summary();
    console.log(`  呈现延迟 p50/p95/p99: ${pStats.p50} / ${pStats.p95} / ${pStats.p99} ms`);
  } catch (e: any) {
    console.error(`  M5 呈现失败:`, e.message);
    issues.push({ module: 'M5', severity: 'P1', description: `呈现异常: ${e.message}`, status: '失败' });
  }

  // ---- 4.8 M6 审计检查 ----
  console.log('\n[8] M6 审计日志检查...');
  // 直接用 auditLog 做守卫，让 TS 收窄非空（auditAvailable 只是布尔快照，不带类型信息）
  if (auditLog) {
    const auditCount = auditLog.getLogCount();
    console.log(`  审计条目数: ${auditCount}`);
    const chainValid = auditLog.verifyChain();
    console.log(`  哈希链完整性: ${chainValid.valid ? '✓ 通过' : '✗ 破坏'} (${chainValid.totalEntries} 条)`);

    // P1-5 验证：所有 WriteQueue 入队的写操作都应自动留痕
    const allEntries = auditLog.query({ subject: 'WriteQueue' });
    console.log(`  WriteQueue 统一审计: ${allEntries.length} 条`);

    // 验收点：必须能拦截到所有写操作（M2 + M3 都走 WriteQueue）
    if (allEntries.length === 0) {
      issues.push({ module: 'M6', severity: 'P0', description: 'WriteQueue 写操作未被审计捕获', status: '需修复' });
    }
    // 至少应有 50+ 条写入（50 次 M2 写入 + 若干 M3 步骤）
    if (allEntries.length < 50) {
      issues.push({ module: 'M6', severity: 'P1', description: `WriteQueue 审计条目偏少 (${allEntries.length} < 50)`, status: '需排查' });
    }
  } else {
    issues.push({ module: 'M6', severity: 'P0', description: '审计日志模块不可用', status: '不可用' });
  }

  // ---- 4.9 全链路延迟 ----
  console.log('\n[9] 全链路端到端延迟采样（20 次）...');
  const e2eLatency = new LatencyStats();
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    // 写入 + 检索 + 呈现 模拟一次完整链路
    await writer.write({
      message_id: `e2e_chain_${i}`,
      namespace: 'default',
      role: 'user',
      content: `全链路测试消息 ${i}，关于电机研发和创业`,
      arousal: 0.5,
    });
    const retriever2 = new (await import('../retrieval/index.js')).Retriever(db);
    const r = await retriever2.retrieve(`电机研发 ${i}`, 'default');
    const engine2 = new (await import('../presentation/index.js')).PresentationEngine(makeMockDeps());
    engine2.present({ evidences: r.evidence, user_query: `测试 ${i}` });
    e2eLatency.record(performance.now() - t0);
  }
  console.log(`  全链路 p50/p95/p99: ${e2eLatency.summary().p50} / ${e2eLatency.summary().p95} / ${e2eLatency.summary().p99} ms`);

  // ---- 4.10 汇总报告 ----
  console.log('\n' + '='.repeat(70));
  console.log('联调问题汇总');
  console.log('='.repeat(70));
  if (issues.length === 0) {
    console.log('✓ 未发现问题');
  } else {
    for (const iss of issues) {
      console.log(`[${iss.severity}] ${iss.module}: ${iss.description} (${iss.status})`);
    }
  }

  console.log('\n性能数据汇总:');
  const wS = writeLatency.summary();
  const rS = retrieveLatency.summary();
  const pS = presentLatency.summary();
  const eS = e2eLatency.summary();
  console.log(`  M2 写入:      p50=${wS.p50}ms, p95=${wS.p95}ms, p99=${wS.p99}ms`);
  console.log(`  M4 检索:      p50=${rS.p50}ms, p95=${rS.p95}ms, p99=${rS.p99}ms`);
  console.log(`  M5 呈现:      p50=${pS.p50}ms, p95=${pS.p95}ms, p99=${pS.p99}ms`);
  console.log(`  全链路:       p50=${eS.p50}ms, p95=${eS.p95}ms, p99=${eS.p99}ms`);

  db.close();
  console.log('\n✓ 测试完成');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
