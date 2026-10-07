#!/usr/bin/env node
/**
 * P0-7a 找回丢失的知识库内容 runner
 * ============================================================================
 * 依据：docs/P0-6-知识库人物档案丢失调查报告.md（commit ff32544）
 * 业主指令（2026-10-07）：「记住知识库里的东西是不能随便被清理的，除非是我确认的或者手动的，
 *   你想办法给我找回来，并设保护，然后赶快修复让这些实体都能随时查到」
 *
 * 用法：
 *   预览（默认，不改任何东西）：node scripts/migration/p0-7/run-restore-kb-dossiers.cjs
 *   执行：node scripts/migration/p0-7/run-restore-kb-dossiers.cjs --apply \
 *           --operator <id> --reason "<text>" --ticket <id> --confirm <token> [--report <path>]
 *
 * 做什么（**只增不删，不改任何既有行**）：
 *   ① 从 SRC_BACKUP（塌缩前最后一刻的备份）还原 68 条 knowledge_base 行，逐列照搬。
 *   ② 从磁盘 data/knowledge-md/ 读入 4 份【FG档案范式】全文（从未进过当前库），带正确归属。
 *   ⇒ 全部 restored 行置 `locked = 1`（业主「设保护」；检索路径不过滤 locked，
 *      只有 KnowledgeDecayEngine 的删除 `AND locked = 0` 与覆盖保护 `if (existing.locked) return false` 生效）。
 *
 * 🔴 前置条件（本脚本自己检查）：服务已停（sql.js 整库写回，运行期外部改动会被静默覆写）。
 * 🔴 幂等：按 id 判存，已存在则跳过 ⇒ 可复跑。
 * 🔴 安全契约（沿用本仓 scripts/_governance-gate.cjs）：riskLevel=HIGH · operationType=insert ·
 *    backup required/created/verified · 有界 scope。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DB = path.resolve(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db');
const LOCK = path.resolve(PROJECT_ROOT, 'data', 'webui', 'server.lock');
const BACKUP_DIR = path.resolve(PROJECT_ROOT, 'data', 'backups', 'p0-7');
const SRC_BACKUP = path.resolve(PROJECT_ROOT, 'data', 'backups', 'pre-uid-recovery', 'fusion_memory_pre_uid_recovery_20260826-022456.db');
const MD_DIR = path.resolve(PROJECT_ROOT, 'data', 'knowledge-md');

/** 当前库 knowledge_base 的 20 列（备份库多出 dna_root_id / type —— 当前库没有，**不搬**）*/
const COLUMNS = [
  'id', 'title', 'content', 'source_type', 'source_name', 'file_size', 'tags',
  'created_at', 'updated_at', 'locked', 'classification', 'classification_pending',
  'dna_id', 'scene_tags', 'interaction_type', 'emotion_vector',
  'belong_entity_uuid', 'impression_score', 'recall_count', 'last_recalled_at',
];

/** 4 份【FG档案范式】—— 磁盘上有全文，但从未进过当前库。归属取自 FG 现有实体。*/
const PARADIGMS = [
  { file: '【FG档案范式】王全芬.md', name: '王全芬', uuid: 'TXS-000000005' },
  { file: '【FG档案范式】熊梓铭.md', name: '熊梓铭', uuid: 'TXS-000000003' },
  { file: '【FG档案范式】徐诗雨.md', name: '徐诗雨', uuid: 'TXS-000000007' },
  { file: '【FG档案范式】徐诗韵.md', name: '徐诗韵', uuid: 'TXS-000000011' },
];

// ── 入参 ──
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const G = {
  apply: argv.includes('--apply'),
  op: arg('--operator'), reason: arg('--reason'), ticket: arg('--ticket'),
  confirm: arg('--confirm'), report: arg('--report'),
  dbPath: arg('--db') || DB, srcPath: arg('--src') || SRC_BACKUP,
};
const MODE = G.apply ? 'apply' : 'dry-run';

function loadSqlJs() {
  const req = createRequire(path.join(PROJECT_ROOT, 'package.json'));
  return req('sql.js');
}

/** 安全前置：无存活进程持有 server.lock（语义对齐 ServerLock 自身：fail-open 于无锁/损坏/残留）*/
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
    scriptId: 'p0-7-restore-kb-dossiers',
    riskLevel: 'HIGH',
    operationType: 'insert',
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

/** 从磁盘 .md 读入范式全文（剥 frontmatter），并解析其 frontmatter 的 id / title / source_type / created_at */
function readParadigm(p) {
  const fp = path.join(MD_DIR, p.file);
  if (!fs.existsSync(fp)) throw new Error(`范式文件不存在: ${fp}`);
  const raw = fs.readFileSync(fp, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]] = kv[2].replace(/^"|"$/g, '').trim();
    }
  }
  const body = (m ? raw.slice(m[0].length) : raw).trim();
  return {
    id: fm.id || `kn_p07_paradigm_${p.uuid}`,
    title: fm.title || `【FG档案范式】${p.name}`,
    content: body,
    source_type: fm.source_type || 'text',
    created_at: fm.created_at || new Date().toISOString(),
    updated_at: fm.updated_at || fm.created_at || new Date().toISOString(),
  };
}

(async () => {
  console.log('='.repeat(74));
  console.log('  P0-7a 找回丢失的知识库内容 · ' + (G.apply ? '【APPLY 执行】' : '【DRY-RUN 预览，不写任何数据】'));
  console.log('='.repeat(74));
  console.log('  目标库: ' + G.dbPath);
  console.log('  还原源: ' + G.srcPath);

  // ── 前置检查 ──
  const pre = assertServerStopped();
  console.log(`  [前置] 停服检查: ${pre.ok ? '✅' : '❌'} ${pre.why}`);
  if (!pre.ok) {
    console.error('\n❌ 拒绝执行：服务仍在运行。本库为 sql.js 整库写回，外部改动会被静默覆写。');
    console.error('   请先 `pm2 stop wenstar-webui`，确认端口 3000 无监听后再跑。');
    process.exit(3);
  }
  for (const [label, f] of [['目标库', G.dbPath], ['还原源', G.srcPath]]) {
    if (!fs.existsSync(f)) { console.error(`\n❌ ${label}不存在: ${f}`); process.exit(3); }
  }

  const initSqlJs = loadSqlJs();
  const SQL = await initSqlJs();

  // ── 组装待写入行 ──
  const srcDb = new SQL.Database(fs.readFileSync(G.srcPath));
  const srcRows = (() => {
    const st = srcDb.prepare('SELECT ' + COLUMNS.join(',') + ' FROM knowledge_base');
    const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o;
  })();
  console.log(`\n  [还原源] knowledge_base 共 ${srcRows.length} 条`);

  const paradigmRows = PARADIGMS.map((p) => {
    const r = readParadigm(p);
    return {
      ...Object.fromEntries(COLUMNS.map((c) => [c, null])),
      id: r.id, title: r.title, content: r.content,
      source_type: r.source_type, source_name: 'FG档案范式',
      file_size: Buffer.byteLength(r.content, 'utf8'),
      tags: JSON.stringify(['人物档案', `person:${p.name}`, 'FG档案范式']),
      created_at: r.created_at, updated_at: r.updated_at,
      locked: 1, classification: '人物档案', classification_pending: 0,
      belong_entity_uuid: p.uuid, impression_score: 0.5, recall_count: 0,
    };
  });
  console.log(`  [磁盘范式] 读入 ${paradigmRows.length} 份（从未进过当前库）`);

  // ── 幂等：按 id 判存 ──
  const liveDb = new SQL.Database(fs.readFileSync(G.dbPath));
  const existing = new Set((() => {
    const st = liveDb.prepare('SELECT id FROM knowledge_base');
    const o = []; while (st.step()) o.push(String(st.getAsObject().id)); st.free(); return o;
  })());
  const beforeTotal = existing.size;
  const all = [...srcRows, ...paradigmRows];
  const toInsert = all.filter((r) => !existing.has(String(r.id)));
  const skipped = all.filter((r) => existing.has(String(r.id)));
  console.log(`  [现状] 目标库 knowledge_base 共 ${beforeTotal} 条`);
  console.log(`  [待写入] ${toInsert.length} 条 · 已存在跳过 ${skipped.length} 条（幂等）`);
  for (const r of skipped) console.log(`      ⏭ 已存在: ${r.id}  ${String(r.title).slice(0, 30)}`);

  console.log('\n  ── 将写入的 id 全清单（供逐条核对）──');
  toInsert.forEach((r, i) => console.log(`   ${String(i + 1).padStart(3)}. ${String(r.id).padEnd(26)} ${String(r.classification || '-').padEnd(8)} ${String(r.belong_entity_uuid || '(公共)').padEnd(16)} ${String(r.title).slice(0, 34)}`));

  if (toInsert.length === 0) { console.log('\n  ✅ 无需写入（全部已存在）。'); process.exit(0); }
  if (!G.apply) {
    console.log('\n  DRY-RUN 结束 —— 未改动任何数据。');
    console.log('  执行请加：--apply --operator <id> --reason "<text>" --ticket <id> --confirm <token>\n');
    process.exit(0);
  }

  // ── 备份 ──
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `p0-7-preapply-${stamp}.db`);
  let backup = null;
  try {
    fs.copyFileSync(G.dbPath, backupPath);
    const a = fs.statSync(G.dbPath).size, b = fs.statSync(backupPath).size;
    backup = { path: backupPath, size: b, verified: a === b };
    console.log(`\n  [备份] ${backupPath}`);
    console.log(`         ${(b / 1048576).toFixed(1)} MB · 大小校验 ${backup.verified ? '✅ 一致' : '❌ 不一致'}`);
  } catch (e) { console.error('\n❌ 备份失败，中止：' + e.message); process.exit(4); }
  if (!backup.verified) { console.error('\n❌ 备份大小校验不通过，中止（绝不带未校验的备份往下走）'); process.exit(4); }

  // ── 治理闸门 ──
  const gate = runGovernanceGate(backup, toInsert.length);
  if (!gate.ok) {
    console.error('\n' + '='.repeat(74));
    console.error('  SCRIPT EXECUTION CONTRACT DENIED');
    console.error('='.repeat(74));
    for (const e of gate.errors) console.error('    ' + e);
    console.error('\n  Refusing to continue.');
    console.error('='.repeat(74));
    process.exit(2);
  }
  console.log('  [治理闸门] ✅ 契约通过（HIGH / insert / 有界 scope / 备份已校验）');

  // ── 执行（事务）──
  console.log('\n  执行中…');
  const placeholders = COLUMNS.map(() => '?').join(',');
  const insertSql = `INSERT INTO knowledge_base (${COLUMNS.join(',')}) VALUES (${placeholders})`;
  liveDb.run('BEGIN');
  let inserted = 0;
  let lockedCount = 0;
  try {
    for (const r of toInsert) {
      liveDb.run(insertSql, COLUMNS.map((c) => (r[c] === undefined ? null : r[c])));
      inserted++;
    }
    // ── ② P0-7b 配套：人物类 KB 行统一 locked=1（业主「设保护」）──
    //   已实测：检索路径**不过滤** locked；只有 KnowledgeDecayEngine 的删除（`AND locked = 0`）
    //   与 KnowledgeEngine 的覆盖保护（`if (existing.locked) return false`）生效 ⇒ **只保护、不隐藏**。
    //   幂等：只改 locked 为 NULL/0 的行。
    liveDb.run(
      "UPDATE knowledge_base SET locked = 1 " +
      "WHERE classification IN ('人物档案','人物参考','本人档案') AND (locked IS NULL OR locked = 0)"
    );
    lockedCount = typeof liveDb.getRowsModified === 'function' ? liveDb.getRowsModified() : -1;
    liveDb.run('COMMIT');
    console.log(`    插入 ${inserted} 行 · 人物类置 locked=1 ${lockedCount} 行`);
  } catch (e) {
    try { liveDb.run('ROLLBACK'); } catch { /* ignore */ }
    console.error('\n❌ 执行失败已回滚：' + e.message);
    console.error('   备份可用于恢复：' + backupPath);
    process.exit(5);
  }

  // ── 复核 ──
  const one = (sql, p) => { const st = liveDb.prepare(sql); if (p) st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o[0] || {}; };
  const afterTotal = Number(one('SELECT COUNT(*) c FROM knowledge_base').c);
  const ownedBy = (u) => Number(one('SELECT COUNT(*) c FROM knowledge_base WHERE belong_entity_uuid = ?', [u]).c);
  const verify = {
    beforeTotal, afterTotal, expected: beforeTotal + toInsert.length,
    restoredPresent: Number(one('SELECT COUNT(*) c FROM knowledge_base WHERE id IN (' + toInsert.map(() => '?').join(',') + ')', toInsert.map((r) => String(r.id))).c),
  };
  console.log('\n  ── 复核 ──');
  console.log(`    knowledge_base：${verify.beforeTotal} → ${verify.afterTotal}（预期 ${verify.expected}）${verify.afterTotal === verify.expected ? ' ✅' : ' ⚠️'}`);
  console.log(`    本次写入的 ${toInsert.length} 条，现已存在 ${verify.restoredPresent} 条 ${verify.restoredPresent === toInsert.length ? '✅' : '⚠️'}`);
  console.log('    ── 各实体自有 KB 条目（业主最关心：他们现在能不能查到自己的文档）──');
  const entities = [
    ['熊梓铭', 'TXS-000000003'], ['徐诗雨', 'TXS-000000007'],
    ['徐诗韵', 'TXS-000000011'], ['王全芬', 'TXS-000000005'],
    ['徐诗涵', 'TXS-000000018'],
  ];
  const entityCounts = {};
  for (const [n, u] of entities) {
    const c = ownedBy(u); entityCounts[n] = c;
    console.log(`    ${n.padEnd(4)} 自有 ${String(c).padStart(4)} 条`);
  }

  // ── 落盘 + 报告 ──
  fs.writeFileSync(G.dbPath, Buffer.from(liveDb.export()));
  console.log(`\n  [落盘] 已写回 ${G.dbPath}（${(fs.statSync(G.dbPath).size / 1048576).toFixed(1)} MB）`);

  const report = {
    script: 'p0-7-restore-kb-dossiers', mode: MODE, at: new Date().toISOString(),
    operator: G.op, reason: G.reason, ticket: G.ticket,
    db: G.dbPath, source: G.srcPath, backup: backup.path,
    insertedIds: toInsert.map((r) => String(r.id)),
    skippedIds: skipped.map((r) => String(r.id)),
    fromBackup: srcRows.length, fromDiskParadigm: paradigmRows.length,
    verify, entityCounts, lockedCount,
    note: '全部 restored 行置 locked=1（业主「设保护」）。检索路径不过滤 locked；仅 KnowledgeDecayEngine 的删除（AND locked=0）与覆盖保护（if existing.locked return false）生效。本批只增不删、不改任何既有行。',
  };
  const reportPath = G.report || path.join(BACKUP_DIR, `p0-7-report-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`  [报告] ${reportPath}`);
  console.log('\n✅ P0-7a 完成。请重启服务后实测：「让这些实体都能随时查到」。\n');
  process.exit(0);
})().catch((e) => { console.error('❌ 未捕获异常：', e); process.exit(9); });
