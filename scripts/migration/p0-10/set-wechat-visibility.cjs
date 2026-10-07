#!/usr/bin/env node
/**
 * P0-10 工作微信限流 —— 给 910 条 `wechat_relay/*` 条目设「户籍域内可见」名单
 * ============================================================================
 * 业主指令（2026-10-07）：「微信是工作微信，他只对玉瑶和徐诗雨开放。」
 *                  （2026-10-08）：「微信每天晚上都要定时清除的。」
 *
 * 依据：《户籍三元组全域统一任务书 V1》法条第三条（按域分治）· 三态模型的第二态
 *   「户籍域内可见」——`visible_entity_uuids` 非空 ⇒ 名单内实体可见。
 *   `belong_entity_uuid` 只回答「这是谁的数据」，可见性由本列回答；
 *   批2 之前两者由同一列承担，导致「只对两人开放」这种语义**根本表达不了**。
 *
 * 用法：
 *   预览（默认，不改任何东西）：node scripts/migration/p0-10/set-wechat-visibility.cjs
 *   执行：node scripts/migration/p0-10/set-wechat-visibility.cjs --apply \
 *           --operator <id> --reason "<text>" --ticket <id> --confirm <token> [--report <path>]
 *
 * 🔴 改的是什么：**只改 `visible_entity_uuids` 一列**。不删任何行、不动 belong、
 *   不动 content/title/任何其它列。报告里存**整行快照**（改前值），可精确回退。
 *
 * 🔴 有界 + 防漂移：目标集由**结构性判据** `source_name LIKE 'wechat_relay/%'` 枚举
 *   （这是微信中继的命名约定，也是每晚清理用的同一条判据，不是"看起来像垃圾"的猜测），
 *   且**数量必须等于 EXPECTED_COUNT**，否则直接中止让人来看 —— 防判据漂移导致误改。
 *   （本项目两次数据损失都源于"按类别扫的谓词"，故此处加了这道数量闸。）
 *
 * 🔴 前置条件（脚本自检）：服务已停（sql.js 整库写回，运行期外部改动会被静默覆写）。
 * 🔴 幂等：只处理 `visible_entity_uuids` 为空的行；已设过的跳过 ⇒ 可复跑。
 * 🔴 安全契约（scripts/_governance-gate.cjs）：HIGH · backfill（破坏性档）· 备份 required/verified · 有界 scope。
 *
 * ⚠️ 微信是**临时**数据：每晚由 DailyMaintenanceScheduler ⓪-b 彻底清除。
 *   本脚本设的可见集只对"当天入库、尚未被清"的行有意义。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DB = path.resolve(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db');
const LOCK = path.resolve(PROJECT_ROOT, 'data', 'webui', 'server.lock');
const BACKUP_DIR = path.resolve(PROJECT_ROOT, 'data', 'backups', 'p0-10');

/** 可见名单 —— 业主裁定：工作微信只对这两人开放 */
const VISIBLE = ['TXS-000000001', 'TXS-000000007'];   // 玉瑶 · 徐诗雨

/** 结构性判据（与每晚清理同源） */
const PREDICATE = "COALESCE(source_name,'') LIKE 'wechat_relay/%'";

/** 🔴 数量闸：实测基线（2026-10-08 只读扫描）。对不上就中止，不猜。 */
const EXPECTED_COUNT = 910;

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
    scriptId: 'p0-10-set-wechat-visibility',
    riskLevel: 'HIGH',
    operationType: 'backfill',          // 破坏性档 ⇒ 强制备份/票据/确认
    mode: MODE,
    environment: 'local',
    operator: { operatorId: G.op || '', reason: G.reason || '', ticket: G.ticket || null },
    scope: { selector: 'table:knowledge_base', limit: plannedCount, batchSize: 100, since: null, until: null },
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
  console.log('  P0-10 工作微信限流 · ' + (G.apply ? '【APPLY 执行】' : '【DRY-RUN 预览，不写任何数据】'));
  console.log('='.repeat(74));
  console.log('  库: ' + G.dbPath);
  console.log('  可见名单: ' + JSON.stringify(VISIBLE) + '  (玉瑶 · 徐诗雨)');

  const pre = assertServerStopped();
  console.log(`  [前置] 停服检查: ${pre.ok ? '✅' : '❌'} ${pre.why}`);
  if (!pre.ok) {
    console.error('\n❌ 拒绝执行：服务仍在运行。本库为 sql.js 整库写回，外部改动会被静默覆写。');
    console.error('   请先 `pm2 stop wenstar-webui`（并按需停 harness-mcp），确认端口 3000 无监听后再跑。');
    process.exit(3);
  }
  if (!fs.existsSync(G.dbPath)) { console.error('\n❌ 库不存在: ' + G.dbPath); process.exit(3); }

  const initSqlJs = loadSqlJs();
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(G.dbPath));
  const many = (sql, p) => { const st = db.prepare(sql); if (p) st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };
  const one = (sql, p) => many(sql, p)[0] || {};

  // ── 列存在性（批2 的 v17 迁移必须先跑过）──
  const hasCol = many("PRAGMA table_info(knowledge_base)").some((c) => c.name === 'visible_entity_uuids');
  console.log(`  [前置] visible_entity_uuids 列: ${hasCol ? '✅ 已存在' : '❌ 缺失'}`);
  if (!hasCol) {
    console.error('\n❌ 拒绝执行：knowledge_base 缺 visible_entity_uuids 列。');
    console.error('   请先启动一次服务让 MigrationManager 的 v17 迁移执行，再停服跑本脚本。');
    process.exit(3);
  }

  // ── 枚举目标集（结构性判据 + 数量闸）──
  const rows = many(
    `SELECT id, title, source_type, source_name, belong_entity_uuid, visible_entity_uuids,
            LENGTH(COALESCE(content,'')) len, created_at
       FROM knowledge_base WHERE ${PREDICATE} ORDER BY created_at, id`,
  );
  const total = rows.length;
  const already = rows.filter((r) => r.visible_entity_uuids && String(r.visible_entity_uuids).trim());
  const todo = rows.filter((r) => !(r.visible_entity_uuids && String(r.visible_entity_uuids).trim()));

  console.log(`\n  [现状] 命中判据 ${PREDICATE} 共 ${total} 条`);
  console.log(`         已设可见集 ${already.length} 条（幂等跳过）· 待设 ${todo.length} 条`);

  if (total !== EXPECTED_COUNT) {
    console.error('\n' + '='.repeat(74));
    console.error(`❌ 数量闸未通过：实测 ${total} 条，基线 ${EXPECTED_COUNT} 条。`);
    console.error('   判据可能漂移（或微信已被每晚清理部分回收）。');
    console.error('   ⚠️ 脚本拒绝继续 —— 请人工核对后再决定是否更新 EXPECTED_COUNT。');
    console.error('='.repeat(74));
    process.exit(6);
  }
  console.log(`  [数量闸] ✅ 实测 ${total} = 基线 ${EXPECTED_COUNT}`);

  console.log('\n  ── 目标清单（前 12 条 + 统计）──');
  for (const r of rows.slice(0, 12)) {
    console.log(`   · ${String(r.id).padEnd(26)} ${String(r.source_name || '').padEnd(28)} ${String(r.len).padStart(5)}字  ${String(r.title).slice(0, 30)}`);
  }
  if (total > 12) console.log(`   … 其余 ${total - 12} 条同构，全部 id 写入报告`);

  console.log('\n  ── 明确不动的（供对照）──');
  console.log(`   ✅ 非微信条目 ${Number(one(`SELECT COUNT(*) c FROM knowledge_base WHERE NOT (${PREDICATE})`).c)} 条 —— 本脚本**一个不碰**`);
  console.log(`   ✅ 归属列 belong_entity_uuid ${Number(one(`SELECT COUNT(*) c FROM knowledge_base WHERE ${PREDICATE} AND belong_entity_uuid IS NOT NULL AND belong_entity_uuid!=''`).c)} 条（微信本就没有归属，本次也不写它）`);

  if (todo.length === 0) { console.log('\n  ✅ 无需处理（目标集已全部设过可见集）。'); process.exit(0); }
  if (!G.apply) {
    console.log('\n  DRY-RUN 结束 —— 未改动任何数据。');
    console.log('  执行请加：--apply --operator <id> --reason "<text>" --ticket <id> --confirm <token>\n');
    process.exit(0);
  }

  // ── 备份 ──
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `p0-10-preapply-${stamp}.db`);
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
  const gate = runGovernanceGate(backup, todo.length);
  if (!gate.ok) {
    console.error('\n' + '='.repeat(74));
    console.error('  SCRIPT EXECUTION CONTRACT DENIED');
    console.error('='.repeat(74));
    for (const e of gate.errors) console.error('    ' + e);
    console.error('\n  Refusing to continue.');
    console.error('='.repeat(74));
    process.exit(2);
  }
  console.log('  [治理闸门] ✅ 契约通过（HIGH / backfill / 有界 scope / 备份已校验）');

  // ── 执行（事务；改前整行留进报告，可精确回退）──
  console.log('\n  执行中…');
  const payload = JSON.stringify(VISIBLE);
  const snapshot = todo.map((r) => ({
    id: r.id, title: r.title, source_name: r.source_name,
    belong_entity_uuid: r.belong_entity_uuid,
    visible_entity_uuids_before: r.visible_entity_uuids ?? null,
  }));
  const ph = todo.map(() => '?').join(',');
  db.run('BEGIN');
  let updated = 0;
  try {
    db.run(
      `UPDATE knowledge_base SET visible_entity_uuids = ? WHERE id IN (${ph})`,
      [payload, ...todo.map((r) => r.id)],
    );
    updated = Number(typeof db.getRowsModified === 'function' ? db.getRowsModified() : todo.length);
    db.run('COMMIT');
    console.log(`    更新 ${updated} 行`);
  } catch (e) {
    try { db.run('ROLLBACK'); } catch { /* ignore */ }
    console.error('\n❌ 执行失败已回滚：' + e.message);
    console.error('   备份可用于恢复：' + backupPath);
    process.exit(5);
  }

  // ── 复核 ──
  const afterSet = Number(one(`SELECT COUNT(*) c FROM knowledge_base WHERE ${PREDICATE} AND COALESCE(visible_entity_uuids,'') <> ''`).c);
  const afterTotal = Number(one('SELECT COUNT(*) c FROM knowledge_base').c);
  const beforeTotal = total + Number(one(`SELECT COUNT(*) c FROM knowledge_base WHERE NOT (${PREDICATE})`).c);
  console.log('\n  ── 复核 ──');
  console.log(`    总行数 ${beforeTotal} → ${afterTotal} ${afterTotal === beforeTotal ? '✅ 未增未减' : '⚠️ 行数变了！'}`);
  console.log(`    微信条目已设可见集：${already.length} + ${updated} = ${afterSet} / ${total} ${afterSet === total ? '✅' : '⚠️'}`);
  console.log(`    归属列未被触碰：${Number(one(`SELECT COUNT(*) c FROM knowledge_base WHERE ${PREDICATE} AND belong_entity_uuid IS NOT NULL AND belong_entity_uuid!=''`).c)} 条（应仍为 0）`);

  // ── 落盘 + 报告 ──
  fs.writeFileSync(G.dbPath, Buffer.from(db.export()));
  console.log(`\n  [落盘] 已写回 ${G.dbPath}（${(fs.statSync(G.dbPath).size / 1048576).toFixed(1)} MB）`);

  const report = {
    script: 'p0-10-set-wechat-visibility', mode: MODE, at: new Date().toISOString(),
    operator: G.op, reason: G.reason, ticket: G.ticket,
    db: G.dbPath, backup: backup.path,
    rule: `工作微信限流（业主裁定：只对玉瑶 + 徐诗雨开放）—— 结构性判据 ${PREDICATE}，数量闸 ${EXPECTED_COUNT}`,
    visible: VISIBLE,
    predicate: PREDICATE,
    expectedCount: EXPECTED_COUNT,
    todoIds: todo.map((r) => r.id),
    touchedRows: snapshot,           // 改前整行快照 ⇒ 精确回退
    verify: { beforeTotal, afterTotal, alreadySet: already.length, updated, afterSet, total },
  };
  const reportPath = G.report || path.join(BACKUP_DIR, `p0-10-report-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`  [报告] ${reportPath}`);
  console.log('\n✅ P0-10 完成。请重启服务。\n');
  process.exit(0);
})().catch((e) => { console.error('❌ 未捕获异常：', e); process.exit(9); });
