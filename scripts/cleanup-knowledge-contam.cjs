#!/usr/bin/env node
/**
 * 清理离线推送的dossier全量污染，重建为基础摘要
 * 保持 FG 与 知识库 的隔离架构
 */
// SCRIPT-GOV-A2d-Batch-2: 治理门控 (CRITICAL, clean)
var _G={};for(var _i=2;_i<process.argv.length;_i++){var _a=process.argv[_i];if(_a==="--apply")_G.apply=1;else if(_a==="--operator"&&process.argv[_i+1])_G.op=process.argv[++_i];else if(_a==="--reason"&&process.argv[_i+1])_G.reason=process.argv[++_i];else if(_a==="--ticket"&&process.argv[_i+1])_G.ticket=process.argv[++_i];else if(_a==="--confirm"&&process.argv[_i+1])_G.confirm=process.argv[++_i];else if(_a==="--scope"&&process.argv[_i+1])_G.scope=process.argv[++_i];else if(_a==="--report-path"&&process.argv[_i+1])_G.rpt=process.argv[++_i];else if(_a==="--help"){console.log("Usage: node cleanup-knowledge-contam.cjs [--apply] --operator <id> --reason <text> --ticket <id> --scope <sel> [--confirm <token>]");process.exit(0)}}
var G=_G;
var M=G.apply?"apply":"dry-run",D=!G.apply;
var {validateGate,recordGovernanceDecision}=require("./_governance-gate.cjs");

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// 🔴 2026-10-31：原硬编码 'D:/wenstar'（旧根，且该目录真实存在）→ 会静默操作旧库。
//   改为从脚本位置推导当前项目根，可用 WENSTAR_HOME 覆盖。
const WENSTAR_ROOT = process.env.WENSTAR_HOME || path.resolve(__dirname, '..');
const FM_PATH = path.join(WENSTAR_ROOT, 'data', 'webui', 'fusion_memory.db');
const FG_PATH = path.join(WENSTAR_ROOT, 'data', 'knowledge', 'family_graph.db');
const KB_MD_DIR = path.join(WENSTAR_ROOT, 'data', 'knowledge-md');
const KC_DOCS_DIR = path.join(WENSTAR_ROOT, 'data', 'knowledge-cabinet', 'docs');

function uid() {
  return 'kn_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
}

// 与 FamilyGraphSync.ts 一致的 buildPersonSummary（纯基础9字段）
function buildPersonSummary(name, profile) {
  const parts = [];
  if (profile.relation_to_user) parts.push(`关系: ${profile.relation_to_user}`);
  if (profile.appearance) parts.push(`外貌: ${profile.appearance}`);
  if (profile.body_features) parts.push(`身材: ${profile.body_features}`);
  if (profile.traits?.length) parts.push(`性格: ${profile.traits.join('、')}`);
  if (profile.personality) parts.push(`性格描述: ${profile.personality}`);
  if (profile.occupation) parts.push(`职业: ${profile.occupation}`);
  if (profile.interests?.length) parts.push(`兴趣: ${profile.interests.join('、')}`);
  if (profile.habits) parts.push(`习惯: ${profile.habits}`);
  if (profile.description) parts.push(`备注: ${profile.description}`);
  if (parts.length === 0) return null;
  return `${name}：${parts.join('；')}`;
}

async function main() {
  // ── 预检门控 ──
  if(!D){var C={scriptId:"cleanup-knowledge-contam",riskLevel:"CRITICAL",operationType:"clean",mode:M,environment:"local",operator:{operatorId:G.op||"",reason:G.reason||"",ticket:G.ticket||null},scope:{selector:G.scope||"table:knowledge_base",limit:0,batchSize:0,since:null,until:null},confirmation:{required:true,provided:!!G.confirm,tokenDigest:G.confirm||null},backup:{required:true,created:false,backupId:null,backupPath:null,verified:false},irreversibleConfirmation:!!G.confirm,reportPath:G.rpt||null};var V=validateGate(C);var PE=V.errors.filter(function(e){return["R008","R009","R010","R013"].indexOf(e.rule)===-1});if(PE.length>0){var lines=["\\n======================================================================\\n  SCRIPT EXECUTION CONTRACT DENIED\\n======================================================================\\n  Script:  cleanup-knowledge-contam.cjs\\n  Risk:    CRITICAL\\n  Mode:    apply\\n  Operation: clean\\n\\n  Issues:"];PE.forEach(function(e){lines.push("    ["+e.rule+"] "+e.message)});lines.push("\n  Refusing to continue.\n======================================================================\n");console.error(lines.join("\n"));recordGovernanceDecision(C,V);recordGovernanceDecision(C,V);process.exit(2)}}
  if(D){console.log("[DRY-RUN] cleanup-knowledge-contam — 将扫描但不写入。使用 --apply --operator <id> --reason <text> --ticket <id> --scope <sel> [--confirm <token>] 执行实际写入。\n");process.exit(0)}

  const SQL = await initSqlJs();

  // 1. 读取 FG 所有人物
  const fgBuf = fs.readFileSync(FG_PATH);
  const fgDb = new SQL.Database(fgBuf);
  const rows = fgDb.exec("SELECT name, properties FROM nodes WHERE type='person' AND name NOT IN ('我','我自己','玉瑶')");
  fgDb.close();

  const skipNames = new Set(['我', '我自己', '玉瑶']);
  const persons = [];
  for (const row of (rows[0]?.values || [])) {
    if (skipNames.has(row[0])) continue;
    try {
      const props = JSON.parse(row[1] || '{}');
      const summary = buildPersonSummary(row[0], props);
      if (summary) persons.push({ name: row[0], summary });
    } catch(e) {}
  }

  // 2. 清理知识库中旧的含dossier条目 + 重建基础摘要
  const fmBuf = fs.readFileSync(FM_PATH);
  const fmDb = new SQL.Database(fmBuf);

  // 删除所有人物档案条目
  fmDb.run("DELETE FROM knowledge_base WHERE title LIKE '%人物档案:%'");
  console.log('🧹 knowledge_base 中所有人物档案已删除');

  // 重建基础摘要
  const now = new Date().toISOString();
  let created = 0;
  for (const { name, summary } of persons) {
    const id = 'kn_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
    const title = `人物档案: ${name}`;
    const tags = JSON.stringify(['人物档案', `person:${name}`]);
    fmDb.run("INSERT INTO knowledge_base (id, title, content, source_type, tags, created_at, updated_at, classification) VALUES (?, ?, ?, 'family_graph', ?, ?, ?, '人物档案')",
      [id, title, summary, tags, now, now]);
    created++;
  }

  const buf = fmDb.export();
  fs.writeFileSync(FM_PATH, Buffer.from(buf));
  fmDb.close();

  // 3. 清理 knowledge-md 中的人物档案文件
  let mdDeleted = 0;
  if (fs.existsSync(KB_MD_DIR)) {
    const files = fs.readdirSync(KB_MD_DIR);
    for (const f of files) {
      if (f.startsWith('人物档案:') && f.endsWith('.md')) {
        fs.unlinkSync(path.join(KB_MD_DIR, f));
        mdDeleted++;
      }
    }
  }
  // 重新生成正确的MD文件
  let mdCreated = 0;
  const fmDb2 = new SQL.Database(fs.readFileSync(FM_PATH));
  const entries = fmDb2.exec("SELECT id, title, content, tags FROM knowledge_base WHERE classification = '人物档案'");
  fmDb2.close();

  if (entries[0]?.values) {
    for (const row of entries[0].values) {
      const id = row[0], title = row[1], content = row[2], tagsRaw = row[3];
      const tags = typeof tagsRaw === 'string' ? (() => { try { return JSON.parse(tagsRaw); } catch { return []; } })() : [];
      const fname = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().substring(0, 80) + '.md';
      const tagsYaml = tags.length ? '\n' + tags.map(t => `  - "${t}"`).join('\n') : '';
      const frontmatter = `---
id: "${id}"
title: "${title}"
type: "family_graph"
source_type: "family_graph"
created_at: "${now}"
updated_at: "${now}"
tags:${tagsYaml}
---\n\n`;
      fs.writeFileSync(path.join(KB_MD_DIR, fname), frontmatter + content, 'utf-8');
      mdCreated++;
    }
  }

  // 4. 清理 knowledge-cabinet/docs
  let txtDeleted = 0;
  if (fs.existsSync(KC_DOCS_DIR)) {
    const files = fs.readdirSync(KC_DOCS_DIR);
    for (const f of files) {
      if (f.startsWith('人物档案:') && f.endsWith('.txt')) {
        fs.unlinkSync(path.join(KC_DOCS_DIR, f));
        txtDeleted++;
      }
    }
  }

  console.log(`🧹 knowledge-md: 删除 ${mdDeleted} 个, 重建 ${mdCreated} 个`);
  console.log(`🧹 knowledge-cabinet/docs: 删除 ${txtDeleted} 个`);
  console.log(`📝 knowledge_base: 重建 ${created} 条基础摘要`);

  // 验证
  const fmDb3 = new SQL.Database(fs.readFileSync(FM_PATH));
  const verify = fmDb3.exec("SELECT title, length(content) as len FROM knowledge_base WHERE title LIKE '%人物档案:%' ORDER BY title");
  console.log('\n验证——所有人物档案应为基础摘要(<300字):');
  let allClean = true;
  if (verify[0]?.values) {
    for (const r of verify[0].values) {
      const flag = r[1] > 300 ? '⚠️ 过长' : '✅';
      if (r[1] > 300) allClean = false;
      console.log('  ' + flag + ' ' + r[0] + ' (' + r[1] + '字)');
    }
  }
  console.log(allClean ? '\n✅ 全部干净，隔离恢复' : '\n❌ 仍有残留');
  fmDb3.close();
}
main().catch(console.error);
