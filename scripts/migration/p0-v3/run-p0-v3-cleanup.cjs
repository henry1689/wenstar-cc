#!/usr/bin/env node
/**
 * P0-3 存量清洗 runner（记忆体系止血 · 第三批）
 * ============================================================================
 * 依据：docs/P0-记忆体系止血任务书-V3.md §3；SQL 见同目录 p0-v3-cleanup.sql
 *
 * 步次（🔴 顺序有讲究，不可随意调换）：
 *   A  memories 字符串'null'归一  →  A2  black_diamond 同  →  E  P0-3c 还原 24 条  →  C  vault_log 归属回填
 *   E 必须在 C 之前：E 还原的那 24 条一旦拿掉归属，C 就少掉 17 条本不该回填的 promote 记录。
 *   详见 STEPS 里 C 步上方的注释。
 *   幂等：四步全部可复跑（复跑时各自影响 0 行）。
 *
 * 用法：
 *   预览（默认，不改任何东西）：
 *     node scripts/migration/p0-v3/run-p0-v3-cleanup.cjs
 *   执行：
 *     node scripts/migration/p0-v3/run-p0-v3-cleanup.cjs --apply \
 *       --operator <id> --reason "<text>" --ticket <id> --confirm <token> [--report <path>]
 *
 * 🔴 前置条件（本脚本会自己检查前两条）：
 *   1. **服务已停**（wenstar-webui）。本库是 sql.js 全量驻内存 + 整库写回，
 *      服务运行期间的外部改动会被内存态 flush **静默覆写**（见 src/app/locking/ServerLock.ts）。
 *   2. 无存活进程持有 data/webui/server.lock。
 *   3. 备份成功且校验通过 —— 失败即中止，绝不带着未校验的备份往下走。
 *
 * 安全契约（沿用本仓 scripts/_governance-gate.cjs 的执行契约）：
 *   riskLevel=HIGH · operationType=update（破坏性）· environment=local
 *   ⇒ 触发 R001–R003（确认）、R008–R010+R013（备份）、R011（有界 scope）。
 *   任何一条不满足即拒绝执行（exit 2），与仓内既有迁移脚本同规。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DB = path.resolve(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db');
const LOCK = path.resolve(PROJECT_ROOT, 'data', 'webui', 'server.lock');
const BACKUP_DIR = path.resolve(PROJECT_ROOT, 'data', 'backups', 'p0-v3');

// ── 入参 ──
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const G = {
  apply: argv.includes('--apply'),
  op: arg('--operator'),
  reason: arg('--reason'),
  ticket: arg('--ticket'),
  confirm: arg('--confirm'),
  report: arg('--report'),
  dbPath: arg('--db') || DB,
};
const MODE = G.apply ? 'apply' : 'dry-run';

/** 载入 sql.js（本项目唯一 SQLite 运行时）*/
function loadSqlJs() {
  const req = createRequire(path.join(PROJECT_ROOT, 'package.json'));
  return req('sql.js');
}

/** 安全前置：无存活进程持有 server.lock。
 *  语义对齐 ServerLock 自身（fail-open：无锁/损坏/残留 → 放行；存活他进程持锁 → 拒绝）。 */
function assertServerStopped() {
  if (!fs.existsSync(LOCK)) return { ok: true, why: '无锁文件' };
  let raw = '';
  try { raw = fs.readFileSync(LOCK, 'utf8'); } catch { return { ok: true, why: '锁文件不可读 → 放行' }; }
  let pid = null;
  try {
    const j = JSON.parse(raw);
    pid = Number(j.pid ?? j.pidPid ?? j.owner);
  } catch { pid = Number(String(raw).trim().split(/\s+/)[0]); }
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true, why: '锁内容无法解析出 pid → 放行（与 ServerLock 同语义）' };
  try { process.kill(pid, 0); }
  catch { return { ok: true, why: `锁的持有进程 ${pid} 已不存在 → 残留锁，放行` }; }
  return { ok: false, why: `进程 ${pid} 仍存活并持有 server.lock —— 服务可能仍在运行` };
}

/** 治理闸门：沿用 scripts/_governance-gate.cjs */
function runGovernanceGate(backup) {
  let validateGate, recordGovernanceDecision;
  try {
    ({ validateGate, recordGovernanceDecision } = require('../../_governance-gate.cjs'));
  } catch (e) {
    return { ok: false, errors: [`无法载入 _governance-gate.cjs: ${e.message}`] };
  }
  const C = {
    scriptId: 'p0-v3-cleanup',
    riskLevel: 'HIGH',
    operationType: 'update',
    mode: MODE,
    environment: 'local',
    operator: { operatorId: G.op || '', reason: G.reason || '', ticket: G.ticket || null },
    scope: {
      selector: 'table:memories+black_diamond+vault_log',
      limit: 500,
      batchSize: 100,
      since: null,
      until: null,
    },
    confirmation: { required: true, provided: !!G.confirm, tokenDigest: G.confirm || null },
    backup: {
      required: true,
      created: !!backup,
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

// ── P0-3c · E 步的显式 id 清单 ──────────────────────────────────────────────
// 🔴 必须显式：这 24 条在线上已是真实 UUID，无法再从线上反推"哪 24 条"。
//    清单取自 A 步执行前的备份（belong_entity_uuid = 'null' 的 24 行），已逐条核对：
//    备份 24/24 命中、无缺失、无非字符串'null'。
//    来源文件（仓外）：D:/tmp/p03c-ids.json（本批执行完毕后按临时文件纪律清理）。
const E_IDS = [
  'mem_00003520260720005916M01EMON_15156',
  'mem_00011320260814103319M01EMOP_31575',
  'mem_00012920260814105055M01FAMF_31583',
  'mem_00015120260814111114M01EMOP_31597',
  'mem_00015920260810031954M01EMOP_29015',
  'mem_00019320260807141028M01FAMC_27857',
  'mem_00024720260719155954M01FAMC_14210',
  'mem_00024920260730125633M01EMOP_23637',
  'mem_00032720260719192904M01WRKS_14586',
  'mem_00033320260812141952M01FAMC_30451',
  'mem_00035720260810100746M01FAMC_29049',
  'mem_00036120260810101214M01FAMC_29051',
  'mem_00038120260810103413M01FAMC_29063',
  'mem_00039920260816191205M01EMOP_32391',
  'mem_00054320260810143824M01EMOP_29169',
  'mem_00055520260810145223M01EMON_29175',
  'mem_00056920260810152319M01EMOP_29177',
  'mem_00081120260727145621M01EMOP_21998',
  'mem_00081320260727145839M01EMOP_22000',
  'mem_00090120260727154928M01EMRO_22068',
  'mem_00094720260727164707M01FAMC_22090',
  'mem_00095120260727165150M01WRKP_22092',
  'mem_00110320260716190732M01EMOP_11894',
  'mem_sand_fallback_32654_32654',
];
const E_ID_LIST = E_IDS.map((s) => `'${s}'`).join(',');

// ── P0-3b 提交信息的更正（如实记录）─────────────────────────────────────────
// P0-3b 的 commit 信息写着「2 条认错」，其判据是「结构列（entity_genes/fg_entity_names）
// 指向别的实体」。**该判据经本批复核后不成立**：全表实测 9453 条已归属记忆中，结构列
// 不含该归属的有 1331 条（14.1%），且不一致样例里混着大量**非人名 token**
// （句子片段与关系词）⇒ 不一致 ≠ 错误。正确表述是「那 24 条由**已被删除的文本推断方法**
// 给出，来源不可靠」，而不是「已证明其中 2 条错」。提交信息无法追改，故在此留更正。
const CORRECTION_NOTE =
  '对本仓 commit ea1f9cb（P0-3b）提交信息中「2 条认错」的更正：该结论的判据（结构列 entity_genes/'
  + 'fg_entity_names 指向别的实体）经复核不成立 —— 全表 9453 条已归属记忆中结构列不含该归属的有 1331 条'
  + '（14.1%），且不一致样例混有大量非人名 token（句子片段/关系词），不一致只说明"不一致"、不能证明"错"。'
  + '正确表述：那 24 条由已被删除的「按正文推断」方法给出，来源不可靠；不是"已证明其中 2 条错"。';

// ── 各步清洗的 SQL（与 p0-v3-cleanup.sql 逐字一致）──
const STEPS = [
  {
    key: 'A',
    label: "memories.belong_entity_uuid 字符串 'null' → SQL NULL",
    countSql: "SELECT COUNT(*) c FROM memories WHERE belong_entity_uuid = 'null'",
    sql: "UPDATE memories SET belong_entity_uuid = NULL WHERE belong_entity_uuid = 'null'",
    expect: 24,
  },
  {
    key: 'A2',
    label: "black_diamond.belong_entity_uuid 字符串 'null' → SQL NULL",
    countSql: "SELECT COUNT(*) c FROM black_diamond WHERE belong_entity_uuid = 'null'",
    sql: "UPDATE black_diamond SET belong_entity_uuid = NULL WHERE belong_entity_uuid = 'null'",
    expect: 19,
  },
  {
    key: 'E',
    label: 'P0-3c 还原 24 条「被文本推断认领」的归属 → SQL NULL',
    countSql: `SELECT COUNT(*) c FROM memories
        WHERE belong_entity_uuid IS NOT NULL AND id IN (${E_ID_LIST})`,
    sql: `UPDATE memories SET belong_entity_uuid = NULL
          WHERE belong_entity_uuid IS NOT NULL AND id IN (${E_ID_LIST})`,
    // 复核基线 22 = live 侧现状（另 2 条在 A 步后未被重启回填认领，已是 NULL）。
    // 复跑时本步影响 0 行 ⇒ 幂等。
    expect: 22,
    // 可逆性：还原前的值记进报告（本步是唯一会"抹掉"线上值的动作）。
    captureSql: `SELECT id, belong_entity_uuid FROM memories
        WHERE belong_entity_uuid IS NOT NULL AND id IN (${E_ID_LIST})`,
  },
  {
    // 🔴 E 必须排在 C **之前**（2026-10-07 实测调整）：
    //   这 24 条在重启回填拿到真 UUID 之后，连带让 17 条 09-22/09-23 的 promote 记录
    //   （source_id 逐条命中 E 清单）变成了 C 的候选。若 C 先跑，它会用"马上要被还原"的
    //   归属值回填这 17 条 ⇒ vault_log 留着一份源记忆已不承认的归属。
    //   先 E 后 C，C 的 EXISTS 自然不成立 ⇒ C 影响 0 条。（P0-3 时 C 影响 353 条，
    //   跑完复核 0；本次重跑从 353 变成 17，正是这 17 条的来源。）
    key: 'C',
    label: 'vault_log 归属回填（landmark/promote/merge_promote 走 source_id → memories.id）',
    countSql: `SELECT COUNT(*) c FROM vault_log
        WHERE operation IN ('landmark','promote','merge_promote')
          AND (belong_entity_uuid IS NULL OR belong_entity_uuid = '')
          AND EXISTS (SELECT 1 FROM memories m WHERE m.id = vault_log.source_id
                        AND m.belong_entity_uuid IS NOT NULL
                        AND m.belong_entity_uuid NOT IN ('', 'null'))`,
    sql: `UPDATE vault_log SET belong_entity_uuid = (
              SELECT m.belong_entity_uuid FROM memories m
               WHERE m.id = vault_log.source_id
                 AND m.belong_entity_uuid IS NOT NULL
                 AND m.belong_entity_uuid NOT IN ('', 'null')
               LIMIT 1)
          WHERE operation IN ('landmark','promote','merge_promote')
            AND (belong_entity_uuid IS NULL OR belong_entity_uuid = '')
            AND EXISTS (SELECT 1 FROM memories m WHERE m.id = vault_log.source_id
                          AND m.belong_entity_uuid IS NOT NULL
                          AND m.belong_entity_uuid NOT IN ('', 'null'))`,
    // 复核基线：P0-3 首跑 353（已执行）；本批重跑在 E 之后应为 0。
    expect: 0,
  },
];

/** 不动作的两项（写进报告，防止后人以为是遗漏）*/
const NO_OP_ITEMS = [
  { key: 'B', label: 'memories 的 142 条 SQL NULL 归属', why: 'B3 结构关联实测救回 0/166；按正文人名推断会让 29.2% 串档 ⇒ 保持 NULL 是结论而非遗漏' },
  { key: 'D', label: 'vault_log 的 promote_sand(139) / auto_promote(5)', why: '根因已查明：这两类 operation 是批次汇总日志（detail 形如「砂金晋升金库 N 条」），source_id 从未被写入 ⇒ 源信息不可恢复，保持 NULL' },
];

(async () => {
  console.log('='.repeat(74));
  console.log('  P0-3 存量清洗 · ' + (G.apply ? '【APPLY 执行】' : '【DRY-RUN 预览，不写任何数据】'));
  console.log('='.repeat(74));
  console.log('  库: ' + G.dbPath);

  // ── 前置检查 ──
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
  const buf = fs.readFileSync(G.dbPath);
  const db = new SQL.Database(buf);
  const many = (sql) => { const st = db.prepare(sql); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };
  const one = (sql) => many(sql)[0] || {};

  // ── 预览各项影响面 ──
  // 🔴 按**实际顺序模拟执行再回滚**，而不是对每步各自独立取数：
  //    步与步之间有依赖（E 把 24 条置 NULL 后，C 就少掉 17 条本不该回填的候选），
  //    独立取数会打印出一个执行时永远不会发生的数字。
  console.log('\n  待执行项（按实际顺序模拟，模拟结束已回滚，不留痕）：');
  const counts = [];
  db.run('BEGIN');
  try {
    for (const s of STEPS) {
      counts.push(Number(one(s.countSql).c) || 0);
      db.run(s.sql); // 让后续步骤看到前置步骤的效果
    }
  } finally {
    db.run('ROLLBACK');
  }
  STEPS.forEach((s, i) => {
    const c = counts[i];
    const flag = c === s.expect ? '✅' : '⚠️ ';
    console.log(`    ${flag} ${s.key.padEnd(3)} ${s.label}`);
    console.log(`          将影响 ${c} 条（复核基线 ${s.expect}）`);
  });
  console.log('\n  刻意不动作项（写进报告，防止后人误当遗漏）：');
  for (const n of NO_OP_ITEMS) console.log(`    ⏸  ${n.key}  ${n.label}\n        理由: ${n.why}`);

  if (!G.apply) {
    console.log('\n  DRY-RUN 结束 —— 未改动任何数据。');
    console.log('  执行请加：--apply --operator <id> --reason "<text>" --ticket <id> --confirm <token>\n');
    process.exit(0);
  }

  // ── 备份（先建后判，供治理闸门核对 backup.created/verified）──
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `p0-v3-preapply-${stamp}.db`);
  let backup = null;
  try {
    fs.copyFileSync(G.dbPath, backupPath);
    const a = fs.statSync(G.dbPath).size, b = fs.statSync(backupPath).size;
    backup = { path: backupPath, size: b, verified: a === b };
    console.log(`\n  [备份] ${backupPath}`);
    console.log(`         ${(b / 1048576).toFixed(1)} MB · 大小校验 ${backup.verified ? '✅ 一致' : '❌ 不一致'}`);
  } catch (e) {
    console.error('\n❌ 备份失败，中止：' + e.message);
    process.exit(4);
  }
  if (!backup.verified) { console.error('\n❌ 备份大小校验不通过，中止（绝不带未校验的备份往下走）'); process.exit(4); }

  // ── 治理闸门 ──
  const gate = runGovernanceGate(backup);
  if (!gate.ok) {
    console.error('\n' + '='.repeat(74));
    console.error('  SCRIPT EXECUTION CONTRACT DENIED');
    console.error('='.repeat(74));
    for (const e of gate.errors) console.error('    ' + e);
    console.error('\n  Refusing to continue.');
    console.error('='.repeat(74));
    process.exit(2);
  }
  console.log('  [治理闸门] ✅ 契约通过（HIGH / update / 有界 scope / 备份已校验）');

  // ── 执行 ──
  console.log('\n  执行中…');
  db.run('BEGIN');
  const applied = [];
  try {
    for (const s of STEPS) {
      // 先取证后改：只有 E 步声明了 captureSql（它会抹掉线上已有值，须记录以便还原）。
      const capture = s.captureSql ? many(s.captureSql) : null;
      db.run(s.sql);
      const n = typeof db.getRowsModified === 'function' ? db.getRowsModified() : -1;
      applied.push({ key: s.key, label: s.label, affected: n, revertedFrom: capture });
      console.log(`    ${s.key.padEnd(3)} 影响 ${n} 行`);
    }
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch { /* ignore */ }
    console.error('\n❌ 执行失败已回滚：' + e.message);
    console.error('   备份可用于恢复：' + backupPath);
    process.exit(5);
  }

  // ── 复核 ──
  console.log('\n  ── 复核（执行后重查）──');
  const verify = [];
  for (const s of STEPS) {
    const c = Number(one(s.countSql).c) || 0;
    verify.push({ key: s.key, remaining: c });
    console.log(`    ${s.key.padEnd(3)} 剩余待处理 ${c} 条  ${c === 0 ? '✅' : '⚠️ 非零（幂等复跑可再处理）'}`);
  }
  const totals = ['memories', 'black_diamond', 'vault_log'].map((t) => {
    const r = one(`SELECT COUNT(*) tot,
                          SUM(CASE WHEN belong_entity_uuid = 'null' THEN 1 ELSE 0 END) strnull,
                          SUM(CASE WHEN belong_entity_uuid IS NULL THEN 1 ELSE 0 END) nul,
                          SUM(CASE WHEN belong_entity_uuid IS NOT NULL
                                    AND belong_entity_uuid NOT IN ('', 'null') THEN 1 ELSE 0 END) has
                     FROM ${t}`);
    return { table: t, total: r.tot || 0, has: r.has || 0, strnull: r.strnull || 0, nul: r.nul || 0 };
  });
  console.log('\n  ── 全表归属状态（P0-3c 后 memories 应为 已归属 9431 · SQL NULL 166 · 字符串\'null\' 0）──');
  for (const t of totals) {
    console.log(`    ${t.table.padEnd(14)} 共 ${String(t.total).padStart(5)} · 已归属 ${String(t.has).padStart(5)}`
      + ` · SQL NULL ${String(t.nul).padStart(5)} · 字符串'null' ${t.strnull}`);
  }

  // ── 落盘 + 报告 ──
  fs.writeFileSync(G.dbPath, Buffer.from(db.export()));
  console.log(`\n  [落盘] 已写回 ${G.dbPath}（${(fs.statSync(G.dbPath).size / 1048576).toFixed(1)} MB）`);

  const report = {
    script: 'p0-v3-cleanup',
    mode: MODE,
    at: new Date().toISOString(),
    operator: G.op, reason: G.reason, ticket: G.ticket,
    db: G.dbPath,
    backup: backup.path,
    preview: STEPS.map((s, i) => ({ key: s.key, label: s.label, planned: counts[i] })),
    applied,
    verify,
    final: totals,
    noOp: NO_OP_ITEMS,
    correction: CORRECTION_NOTE,
  };
  const reportPath = G.report || path.join(BACKUP_DIR, `p0-v3-report-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`  [报告] ${reportPath}`);
  console.log('\n✅ P0-3 + P0-3c 完成。请重启服务并复核会晤/对话行为。');
  console.log('   🔴 memories 应回到 已归属 9431 · SQL NULL 166 —— 即 V3 §3.3 的原始判据。');
  console.log('   ⚠️  本批含对本仓 commit ea1f9cb（P0-3b）提交信息中「2 条认错」的更正，见报告 correction 字段。\n');
  process.exit(0);
})().catch((e) => { console.error('❌ 未捕获异常：', e); process.exit(9); });
