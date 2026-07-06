#!/usr/bin/env node
/**
 * 📜 太虚境·信息权威铁律 — 全链路更新脚本
 *
 * 第三章·第三节: 用户三令五申要求更正信息时，必须同时更新所有相关层级
 *
 * 用法:
 *   node scripts/full-chain-update.cjs <人物名> <字段> <新值> [--reason="更正原因"]
 *
 * 示例:
 *   node scripts/full-chain-update.cjs 徐诗韵 age 25 --reason="用户确认诗韵真实年龄为25岁"
 *   node scripts/full-chain-update.cjs 徐诗雨 occupation "总经理" --reason="诗雨升职"
 *
 * 更新链路:
 *   S级: FamilyGraph.nodes.properties  ← 主数据
 *   A级: EntityTopology               ← 仅关系变更时
 *   B级: KnowledgeBase 文档            ← 如果有相关文档
 *   C级: 金库记忆                      ← 追加变更记录
 */

const path = require('path');
const fs = require('fs');
const { exit } = require('process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── 解析参数 ───
const args = process.argv.slice(2);
let personName = '';
let field = '';
let newValue = '';
let reason = '用户确认更正';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--reason') {
    reason = args[++i] || reason;
  } else if (!personName) {
    personName = args[i];
  } else if (!field) {
    field = args[i];
  } else if (!newValue) {
    newValue = args[i];
  }
}

if (!personName || !field || newValue === undefined) {
  console.error('用法: node scripts/full-chain-update.cjs <人物名> <字段> <新值> [--reason="原因"]');
  console.error('示例: node scripts/full-chain-update.cjs 徐诗韵 age 25 --reason="用户确认"');
  exit(1);
}

console.log('🏛️ 全链路更新开始');
console.log(`   人物: ${personName}`);
console.log(`   字段: ${field} → ${newValue}`);
console.log(`   原因: ${reason}`);
console.log('');

// ─── 辅助函数 ───
function log(level, msg) {
  const labels = { S: '📜S级 FG', A: '🔗A级 拓扑', B: '📚B级 知识库', C: '🗃️C级 记忆', '!': '⚠️ 注意' };
  const label = labels[level] || level;
  console.log(`  [${label}] ${msg}`);
}

// ─── S级: FamilyGraph ───
function updateFG() {
  const FG_PATH = path.join(PROJECT_ROOT, 'data', 'webui', 'knowledge', 'family_graph.db');
  if (!fs.existsSync(FG_PATH)) {
    log('!', `FG文件不存在: ${FG_PATH}`);
    return false;
  }

  const Database = require('better-sqlite3');
  const db = new Database(FG_PATH);

  // 查找此人节点
  const rows = db.prepare("SELECT id, properties FROM nodes WHERE type='person'").all();
  let targetNode = null;

  for (const row of rows) {
    try {
      const props = JSON.parse(row.properties);
      if (props.name === personName) {
        targetNode = { id: row.id, properties: props };
        break;
      }
    } catch (e) { /* skip */ }
  }

  if (!targetNode) {
    log('!', `未在FG中找到 "${personName}" 的节点`);
    db.close();
    return false;
  }

  // 更新属性
  const oldValue = targetNode.properties[field];
  targetNode.properties[field] = newValue;
  const newProps = JSON.stringify(targetNode.properties);

  db.prepare('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?')
    .run(newProps, new Date().toISOString(), targetNode.id);

  log('S', `${personName}.${field}: ${oldValue !== undefined ? oldValue : '(无)'} → ${newValue}`);
  db.close();
  return true;
}

// ─── A级: Entity Topology（仅关系字段时更新） ───
function updateTopology() {
  const DB_PATH = path.join(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db');
  if (!fs.existsSync(DB_PATH)) {
    log('!', `数据库不存在: ${DB_PATH}`);
    return false;
  }

  const relationFields = ['relation', 'relation_type', 'relation_to_user', 'mother', 'father', 'sibling'];
  if (!relationFields.includes(field)) {
    log('A', `字段 "${field}" 非关系字段，跳过拓扑更新`);
    return false;
  }

  // 拓扑不存年龄，只存关系类型。如果修改的是关系才更新
  log('A', `关系字段变更 — 需手动通过 EntityTopologyManager.addRelation() 同步`);
  log('A', `  或: node scripts/manage-topology.cjs ${personName} ${field} ${newValue}`);
  return true;
}

// ─── B级: Knowledge Base ───
function updateKB() {
  const DB_PATH = path.join(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db');
  if (!fs.existsSync(DB_PATH)) {
    log('!', `数据库不存在: ${DB_PATH}`);
    return false;
  }

  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  // 查找涉及此人且包含该字段的知识库文档
  const kbEntries = db.prepare("SELECT id, title, content FROM knowledge_base WHERE content LIKE ?").all(`%${personName}%`);

  if (kbEntries.length === 0) {
    log('B', `未找到 "${personName}" 相关的知识库文档`);
    db.close();
    return false;
  }

  let updatedCount = 0;
  for (const entry of kbEntries) {
    const fieldPatterns = [
      new RegExp(`(年龄[：:])[\\s]*\\d+`, 'g'),
      new RegExp(`(${field}[：:])[^\\n]+`, 'g'),
    ];

    let newContent = entry.content;
    for (const pattern of fieldPatterns) {
      newContent = newContent.replace(pattern, (match, prefix) => {
        return `${prefix}${newValue}`;
      });
    }

    if (newContent !== entry.content) {
      db.prepare('UPDATE knowledge_base SET content = ?, updated_at = ? WHERE id = ?')
        .run(newContent, new Date().toISOString(), entry.id);
      updatedCount++;
      log('B', `更新文档 ${entry.title.substring(0, 30)}`);
    }
  }

  if (updatedCount === 0) {
    log('B', `已找到 ${kbEntries.length} 个相关文档，但未匹配到可替换的字段模式`);
  }

  db.close();
  return updatedCount > 0;
}

// ─── C级: 记忆存档 ───
function logToMemory() {
  const DB_PATH = path.join(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db');
  if (!fs.existsSync(DB_PATH)) {
    log('!', `数据库不存在: ${DB_PATH}`);
    return false;
  }

  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  const now = new Date().toISOString();
  const changeLog = JSON.stringify({
    type: '📜权威数据更新',
    person: personName,
    field: field,
    oldValue: null,  // 实际使用时可从FG查询
    newValue: newValue,
    reason: reason,
    timestamp: now,
  });

  // 写入金库记忆
  const memoryId = `chain_update_${Date.now()}`;
  try {
    db.prepare(`INSERT INTO memories (id, raw_input, calcium_score, calcium_level, created_at)
      VALUES (?, ?, 3.0, 2, ?)`)
      .run(memoryId, `【权威数据更新】${personName}的${field}已确认为${newValue}，原因：${reason}`, now);
    log('C', `已追加变更记录到金库 (id=${memoryId})`);
  } catch (e) {
    log('!', `写入记忆失败: ${e.message}`);
  }

  db.close();
  return true;
}

// ─── 执行 ───
console.log('─── 执行全链路更新 ───');
const sOk = updateFG();
console.log('');
const aOk = updateTopology();
console.log('');
const bOk = updateKB();
console.log('');
const cOk = logToMemory();
console.log('');

console.log('─── 更新总结 ───');
console.log(`  S级 FG:       ${sOk ? '✅ 已更新' : '⚠️ 跳过/失败'}`);
console.log(`  A级 拓扑:      ${aOk ? '✅ 已处理' : '⏭️ 跳过（非关系字段）'}`);
console.log(`  B级 知识库:    ${bOk ? '✅ 已更新' : '⏭️ 跳过/无匹配'}`);
console.log(`  C级 记忆存档:  ${cOk ? '✅ 已记录' : '⚠️ 失败'}`);
console.log('');
if (field === 'age') {
  console.log('📌 注意：年龄更新后，实体拓扑中的关系类型不变（年龄不影响关系类型）。');
  console.log('   如果需要更新拓扑中的年龄标签，请使用 manage-topology.js 工具。');
}
console.log('🏛️ 全链路更新完成');
