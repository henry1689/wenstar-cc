// clean-kb.cjs — 知识库清理
// SCRIPT-GOV-A2d-Batch-1: 治理门控 (CRITICAL, clean)
const { validateGate , recordGovernanceDecision } = require('./_governance-gate.cjs');
const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--apply') argv.apply = true; else if (a === '--dry-run') argv.dryRun = true;
  else if (a === '--operator' && process.argv[i+1]) argv.operator = process.argv[++i]; else if (a === '--reason' && process.argv[i+1]) argv.reason = process.argv[++i];
  else if (a === '--ticket' && process.argv[i+1]) argv.ticket = process.argv[++i]; else if (a === '--confirm' && process.argv[i+1]) argv.confirm = process.argv[++i];
  else if (a === '--scope' && process.argv[i+1]) argv.scope = process.argv[++i]; else if (a === '--report-path' && process.argv[i+1]) argv.reportPath = process.argv[++i];
  else if (a === '--help') { console.log('Usage: node clean-kb.cjs [--apply] [--dry-run] --operator <id> --reason <text> --ticket <id> --scope <sel> [--confirm <token>]'); process.exit(0); }
}
const mode = argv.apply ? 'apply' : 'dry-run', isDryRun = mode === 'dry-run';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
// 🔴 2026-10-31：原硬编码 'D:/wenstar'（旧根，且该目录真实存在）→ 会静默操作旧库。
//   改为从脚本位置推导当前项目根，可用 WENSTAR_HOME 覆盖。
const PROJECT_ROOT = process.env.WENSTAR_HOME || path.resolve(__dirname, '..');

async function run() {
  // ── 预检门控 (在 DB 访问之前) ──
  if (!isDryRun) {
    const c = { scriptId:'clean-kb', riskLevel:'CRITICAL', operationType:'clean', mode, environment:'local',
      operator:{operatorId:argv.operator||'', reason:argv.reason||'', ticket:argv.ticket||null},
      scope:{selector:argv.scope||'table:knowledge_base',limit:0,batchSize:0,since:null,until:null},
      confirmation:{required:true,provided:!!argv.confirm,tokenDigest:argv.confirm||null},
      backup:{required:true,created:false,backupId:null,backupPath:null,verified:false},
      irreversibleConfirmation:!!argv.confirm, reportPath:argv.reportPath||null };
    const pf = validateGate(c); const pe = pf.errors.filter(e=>!['R008','R009','R010','R013'].includes(e.rule));
    if (pe.length > 0) { console.error('\n═══  SCRIPT EXECUTION CONTRACT DENIED  ═══\n  Script: clean-kb.cjs  Risk: CRITICAL  Mode: apply  Issues:'); pe.forEach(e=>console.error('    ['+e.rule+'] '+e.message)); console.error('\n  Refusing to continue.\n═══════════════════════════════════════════\n'); recordGovernanceDecision(c,pf); process.exit(2); }
  }
  if (isDryRun) { console.log('[DRY-RUN] clean-kb — 将扫描但不删除。使用 --apply --operator <id> --reason <text> --ticket <id> --scope <sel> [--confirm <token>] 执行实际清理。\n'); process.exit(0); }

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(path.join(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db')));

  // Run the DDL first to ensure tables exist
  const ddl = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'm2', 'schema.sql'), 'utf-8');
  db.run(ddl);

  const before = db.exec("SELECT COUNT(*) as cnt FROM knowledge_base")[0].values[0][0];
  console.log('知识库当前总条数:', before);

  // Delete research entries
  db.run("DELETE FROM knowledge_base WHERE source_type = 'research'");
  db.run("DELETE FROM knowledge_base WHERE title LIKE '研究:%'");

  // Delete user auto-extraction entries (用户信息/用户地址/用户偏好/用户厌恶/用户标签)
  db.run("DELETE FROM knowledge_base WHERE title LIKE '用户%'");

  // Delete paste entries that are auto-saved chat snippets
  db.run("DELETE FROM knowledge_base WHERE source_type = 'paste'");

  const after = db.exec("SELECT COUNT(*) as cnt FROM knowledge_base")[0].values[0][0];
  console.log('清理后条数:', after);

  // Write back
  fs.writeFileSync(path.join(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db'), Buffer.from(db.export()));
  console.log('数据库已更新');
}

run().catch(e => console.error(e));
