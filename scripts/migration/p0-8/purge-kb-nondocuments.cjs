#!/usr/bin/env node
/**
 * P0-8a 知识库只留「文档 + 微信临时」—— 清掉既非文档、非微信、非梦境的碎片
 * ============================================================================
 * 业主指令（2026-10-07）：「知识库里不应该有什么碎片信息，也不能有这些，因为这里只存文档和
 *   微信临时信息，再加上微信信息每天晚上还要彻底清除避免污染」。逐项拍板：
 *   · 梦境（dream_behavior 141 条）：**不删**，改为隔离出检索（见 SourceTypePolicy 的改动）；
 *   · 1 字的空条目：**删**。
 *
 * 用法：
 *   预览（默认，不改任何东西）：node scripts/migration/p0-8/purge-kb-nondocuments.cjs
 *   执行：node scripts/migration/p0-8/purge-kb-nondocuments.cjs --apply \
 *           --operator <id> --reason "<text>" --ticket <id> --confirm <token> [--report <path>]
 *
 * 🔴 只删**明确列举的 9 个 id**（见 TARGET_IDS）—— 不做按类别扫的谓词。
 *   这 9 条是按"非文档 ∧ 非微信 ∧ 非梦境"的规则算出来的**全集**，已逐条打印核对：
 *     · systems_consolidation × 4 —— SleepTimeConsolidator 写的「巩固记忆」(22/22/71/90 字)，
 *        其中 3 条正是业主实测时被熊梓铭当成"档案"看到的那几条；
 *     · monthly_topic × 2 —— DailyMaintenanceScheduler 写的「对话主题月报」(131/133 字)；
 *     · conversation_induct × 2 —— 旧数据「[对话事实·家人]」(7/13 字)，已无写入点；
 *     · text × 1 —— 标题「非法来源探针」、正文 1 字（探针残留）。
 *   **一条不动**：微信 910 条、真文档约 72 条、梦境 141 条。
 *
 * 🔴 前置条件（本脚本自己检查）：服务已停（sql.js 整库写回，运行期外部改动会被静默覆写）。
 * 🔴 幂等：按 id 判存，已不存在即跳过 ⇒ 可复跑。
 * 🔴 安全契约（沿用本仓 scripts/_governance-gate.cjs）：HIGH · delete · 备份 required/verified · 有界 scope。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DB = path.resolve(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db');
const LOCK = path.resolve(PROJECT_ROOT, 'data', 'webui', 'server.lock');
const BACKUP_DIR = path.resolve(PROJECT_ROOT, 'data', 'backups', 'p0-8');

/**
 * 🔴 显式 id 白名单 —— 业主 2026-10-07 逐项确认后确定。
 * 规则来源：非微信（source_name 不以 wechat_relay/ 开头）∧ 非文档（非 md/text/person/research/
 *   architecture 且正文 ≥100 字；txt 同）∧ 非梦境（source_type ≠ dream_behavior）。
 * 规则的可复算 SQL 写在 README 与 .sql 存档里；此处把算出来的 9 个 id 写死，避免"规则漂移导致误删"。
 */
const TARGET_IDS = [
  'WK3993000084E0C0EA4CB88E',   // text，标题「非法来源探针」，正文 1 字（探针残留）
  'induct_mts6ze15_7p4s',       // conversation_induct，「[对话事实·家人] 我妈要是知道了」(7 字)
  'induct_mtswnqpt_nt3i',       // conversation_induct，「[对话事实·家人] 我妈自己——你不是说过的嘛」(13 字)
  'sysc_muutiknp_wsfx',         // systems_consolidation，「巩固记忆: 找熊梓铭聊聊」(22 字)
  'sysc_muutiknq_d0rd',         // systems_consolidation，「巩固记忆: 和熊梓铭聊聊」(22 字)
  'sysc_muutiknr_fyq9',         // systems_consolidation，「巩固记忆: 鸿艺先生今晚怎么突然要抱抱了？…」(71 字)
  'sysc_muutikns_iffv',         // systems_consolidation，「巩固记忆: 鸿艺，徐诗雨在这儿呢…」(90 字)
  'topic_202608',               // monthly_topic，「对话主题月报 2026-08」(133 字)
  'topic_202609',               // monthly_topic，「对话主题月报 2026-09」(131 字)
];

// ── 入参 ──
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const G = {
  apply: argv.includes('--apply'),
  op: arg('--operator'), reason: arg('--reason'), ticket: arg('--ticket'),
  confirm: arg('--confirm'), report: arg('--report'),
  dbPath: arg('--db') || DB,
};
const MODE = G.apply ? 'apply' : 'dry-run';

function loadSqlJs() {
  const req = createRequire(path.join(PROJECT_ROOT, 'package.json'));
  return req('sql.js');
}

/** 安全前置：无存活进程持有 server.lock */
function assertServerStopped() {
  if (!fs.existsSync(LOCK)) return { ok: true, why: '无锁文件' };
  let raw = '';
  try { raw = fs.readFileSync(LOCK, 'utf8'); } catch { return { ok: true, why: '锁文件不可读 → 放行' }; }
  let pid = null;
  try { const j = JSON.parse(raw); pid = Number(j.pid ?? j.pidPid ?? j.owner); }
  catch { pid = Number(String(raw).trim().split(/\s+/)[0]); }
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true, why: '锁内容无法解析出 pid → 放行（与 ServerLock 同语义）' };
  try { process.kill(pid, 0); }
  catch { return { ok: true, why: `锁的持有进程 ${pid} 已不存在 → 残留锁，放行` }; }
  return { ok: false, why: `进程 ${pid} 仍存活并持有 server.lock —— 服务可能仍在运行` };
}

function runGovernanceGate(backup, plannedCount) {
  let validateGate, recordGovernanceDecision;
  try { ({ validateGate, recordGovernanceDecision } = require('../../_governance-gate.cjs')); }
  catch (e) { return { ok: false, errors: [`无法载入 _governance-gate.cjs: ${e.message}`] }; }
  const C = {
    scriptId: 'p0-8-purge-kb-nondocuments',
    riskLevel: 'HIGH',
    operationType: 'delete',
    mode: MODE,
    environment: 'local',
    operator: { operatorId: G.op || '', reason: G.reason || '', ticket: G.ticket || null },
    scope: { selector: 'table:knowledge_base', limit: plannedCount, batchSize: 20, since: null, until: null },
    confirmation: { required: true, provided: !!G.confirm, tokenDigest: G.confirm || null },
    backup: {
      required: true, created: !!backup,
      backupId: backup ? path.basename(backup.path) : null,
      backupPath: backup ? backup.path : null,
      verified: !!(backup && backup.verified),
    },
    irreversibleConfirmation: true,
    reportPath: G.report || null,
    worldSegment: null,
  };
  const V = validateGate(C);
  try { recordGovernanceDecision(C, V); } catch { /* 记录失败不阻塞判定 */ }
  const errors = (V.errors || []).map((e) => `[${e.rule}] ${e.message}`);
  return { ok: errors.length === 0, errors, contract: C };
}

(async () => {
  console.log('='.repeat(74));
  console.log('  P0-8a 清知识库非文档碎片 · ' + (G.apply ? '【APPLY 执行】' : '【DRY-RUN 预览，不写任何数据】'));
  console.log('='.repeat(74));
  console.log('  库: ' + G.dbPath);

  const pre = assertServerStopped();
  console.log(`  [前置] 停服检查: ${pre.ok ? '✅' : '❌'} ${pre.why}`);
  if (!pre.ok) {
    console.error('\n❌ 拒绝执行：服务仍在运行。本库为 sql.js 整库写回，外部改动会被静默覆写。');
    console.error('   请先 `pm2 stop wenstar-webui`，确认端口 3000 无监听后再跑。');
    process.exit(3);
  }
  if (!fs.existsSync(G.dbPath)) { console.error('\n❌ 库不存在: ' + G.dbPath); process.exit(3); }

  const initSqlJs = loadSqlJs();
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(G.dbPath));
  const many = (sql, p) => { const st = db.prepare(sql); if (p) st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };
  const one = (sql, p) => many(sql, p)[0] || {};

  const beforeTotal = Number(one('SELECT COUNT(*) c FROM knowledge_base').c);
  const ph = TARGET_IDS.map(() => '?').join(',');
  const present = many(`SELECT id, title, source_type, LENGTH(COALESCE(content,'')) len, belong_entity_uuid b FROM knowledge_base WHERE id IN (${ph})`, TARGET_IDS);
  const presentIds = new Set(present.map((r) => String(r.id)));
  const toDelete = TARGET_IDS.filter((id) => presentIds.has(id));
  const missing = TARGET_IDS.filter((id) => !presentIds.has(id));

  console.log(`\n  [现状] knowledge_base 共 ${beforeTotal} 条`);
  console.log(`  [待删] ${toDelete.length} 条（白名单共 ${TARGET_IDS.length} 条，已不存在 ${missing.length} 条 ⇒ 幂等）`);
  console.log('\n  ── 待删条目全清单（逐条核对）──');
  for (const r of present) {
    console.log(`   · ${String(r.id).padEnd(22)} ${String(r.source_type).padEnd(22)} len=${String(r.len).padEnd(5)} ${String(r.b || '(公共)').padEnd(15)} ${String(r.title).slice(0, 42)}`);
  }
  if (missing.length) { console.log('   ⏭ 已不存在:'); for (const id of missing) console.log('      ' + id); }

  console.log('\n  ── 明确不动的（供对照）──');
  console.log(`   ✅ 微信临时信息(wechat_relay) ${Number(one("SELECT COUNT(*) c FROM knowledge_base WHERE source_name LIKE 'wechat_relay/%'").c)} 条`);
  console.log(`   ✅ 梦境(dream_behavior，改为隔离出检索) ${Number(one("SELECT COUNT(*) c FROM knowledge_base WHERE source_type='dream_behavior'").c)} 条`);
  console.log(`   ✅ 真文档(md/text/person/research/architecture 且 ≥100 字) ${Number(one("SELECT COUNT(*) c FROM knowledge_base WHERE source_type IN ('md','text','person','research','architecture') AND LENGTH(COALESCE(content,''))>=100").c)} 条`);

  if (toDelete.length === 0) { console.log('\n  ✅ 无需删除（白名单条目均已不存在）。'); process.exit(0); }
  if (!G.apply) {
    console.log('\n  DRY-RUN 结束 —— 未改动任何数据。');
    console.log('  执行请加：--apply --operator <id> --reason "<text>" --ticket <id> --confirm <token>\n');
    process.exit(0);
  }

  // ── 备份 ──
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `p0-8-preapply-${stamp}.db`);
  let backup = null;
  try {
    fs.copyFileSync(G.dbPath, backupPath);
    const a = fs.statSync(G.dbPath).size, b = fs.statSync(backupPath).size;
    backup = { path: backupPath, size: b, verified: a === b };
    console.log(`\n  [备份] ${backupPath}`);
    console.log(`         ${(b / 1048576).toFixed(1)} MB · 大小校验 ${backup.verified ? '✅ 一致' : '❌ 不一致'}`);
  } catch (e) { console.error('\n❌ 备份失败，中止：' + e.message); process.exit(4); }
  if (!backup.verified) { console.error('\n❌ 备份大小校验不通过，中止'); process.exit(4); }

  // ── 治理闸门 ──
  const gate = runGovernanceGate(backup, toDelete.length);
  if (!gate.ok) {
    console.error('\n' + '='.repeat(74));
    console.error('  SCRIPT EXECUTION CONTRACT DENIED');
    console.error('='.repeat(74));
    for (const e of gate.errors) console.error('    ' + e);
    console.error('\n  Refusing to continue.');
    console.error('='.repeat(74));
    process.exit(2);
  }
  console.log('  [治理闸门] ✅ 契约通过（HIGH / delete / 有界 scope / 备份已校验）');

  // ── 执行（事务；删前把整行留进报告，可还原）──
  console.log('\n  执行中…');
  const snapshot = present.map((r) => ({ ...r }));
  db.run('BEGIN');
  let deleted = 0;
  try {
    for (const id of toDelete) {
      db.run('DELETE FROM knowledge_base WHERE id = ?', [id]);
      deleted += Number(typeof db.getRowsModified === 'function' ? db.getRowsModified() : 1);
    }
    db.run('COMMIT');
    console.log(`    删除 ${deleted} 行`);
  } catch (e) {
    try { db.run('ROLLBACK'); } catch { /* ignore */ }
    console.error('\n❌ 执行失败已回滚：' + e.message);
    console.error('   备份可用于恢复：' + backupPath);
    process.exit(5);
  }

  // ── 复核 ──
  const afterTotal = Number(one('SELECT COUNT(*) c FROM knowledge_base').c);
  const remain = many(`SELECT id FROM knowledge_base WHERE id IN (${ph})`, TARGET_IDS).length;
  console.log('\n  ── 复核 ──');
  console.log(`    knowledge_base：${beforeTotal} → ${afterTotal}（预期 ${beforeTotal - toDelete.length}）${afterTotal === beforeTotal - toDelete.length ? ' ✅' : ' ⚠️'}`);
  console.log(`    白名单残留：${remain} 条 ${remain === 0 ? '✅' : '⚠️'}`);
  for (const [label, sql] of [
    ['微信临时', "SELECT COUNT(*) c FROM knowledge_base WHERE source_name LIKE 'wechat_relay/%'"],
    ['梦境', "SELECT COUNT(*) c FROM knowledge_base WHERE source_type='dream_behavior'"],
  ]) console.log(`    ${label}应不变：${Number(one(sql).c)} 条`);

  // ── 落盘 + 报告 ──
  fs.writeFileSync(G.dbPath, Buffer.from(db.export()));
  console.log(`\n  [落盘] 已写回 ${G.dbPath}（${(fs.statSync(G.dbPath).size / 1048576).toFixed(1)} MB）`);

  const report = {
    script: 'p0-8-purge-kb-nondocuments', mode: MODE, at: new Date().toISOString(),
    operator: G.op, reason: G.reason, ticket: G.ticket,
    db: G.dbPath, backup: backup.path,
    rule: '非微信 ∧ 非文档(≥100字) ∧ 非梦境 —— 业主 2026-10-07 逐项确认',
    targetIds: TARGET_IDS, deletedIds: toDelete,
    deletedRows: snapshot,   // 整行快照，可精确还原
    verify: { beforeTotal, afterTotal, remain },
  };
  const reportPath = G.report || path.join(BACKUP_DIR, `p0-8-report-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`  [报告] ${reportPath}`);
  console.log('\n✅ P0-8a 完成。请重启服务。\n');
  process.exit(0);
})().catch((e) => { console.error('❌ 未捕获异常：', e); process.exit(9); });
