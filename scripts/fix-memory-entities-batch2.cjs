/**
 * 批次2: memory_entities 清理 + 从 entity_genes 重建
 * ====================================================
 * 策略: 以 fusion_memory.entities 中 type=person & uuid=TXS-* 的 name 集合为白名单，
 *       从 entity_genes 派生 memory_entities，排除滑窗垃圾和称谓词。
 * 幂等: DELETE + INSERT OR IGNORE，可重复跑。
 */

const Database = require('better-sqlite3');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');

const MEM_DB_PATH = 'data/webui/fusion_memory.db';
const BACKUP_PATH = 'data/webui/fusion_memory_before_batch2.db';

function main() {
  console.log('═'.repeat(60));
  console.log('  批次2: memory_entities 清理重建');
  console.log('═'.repeat(60));

  if (existsSync(MEM_DB_PATH)) {
    writeFileSync(BACKUP_PATH, readFileSync(MEM_DB_PATH));
    console.log('已备份到:', BACKUP_PATH);
  }

  const mem = new Database(MEM_DB_PATH);

  // 构建 FG 认可的人名白名单（type=person + TXS UUID）
  const fgPersonNames = new Set();
  for (const r of mem.prepare(
    "SELECT name FROM entities WHERE type='person' AND uuid IS NOT NULL AND uuid LIKE 'TXS-%'"
  ).all()) {
    fgPersonNames.add(String(r.name).trim());
  }
  console.log(`FG 人名白名单: ${fgPersonNames.size} 个`);

  // 统计当前状态
  const beforeCount = mem.prepare('SELECT COUNT(*) as c FROM memory_entities').get();
  console.log(`\n当前 memory_entities: ${beforeCount.c} 条`);

  // 清空
  mem.prepare('DELETE FROM memory_entities').run();
  console.log('已清空 memory_entities');

  // 从 entity_genes 派生
  const genes = mem.prepare(
    "SELECT id, entity_genes FROM memories WHERE entity_genes IS NOT NULL AND entity_genes != '' AND entity_genes != '[]'"
  ).all();

  let inserted = 0;
  let skippedNoMatch = 0;
  let skippedNotPerson = 0;
  const BATCH = 200;
  let lastLog = 0;

  for (let i = 0; i < genes.length; i++) {
    const { id: memId, entity_genes: geneJson } = genes[i];
    let parsed;
    try { parsed = JSON.parse(geneJson); } catch { continue; }
    if (!Array.isArray(parsed)) continue;

    for (const g of parsed) {
      if (!g || !g.name) continue;
      if (g.type !== 'person') { skippedNotPerson++; continue; }
      const nameKey = String(g.name).trim();
      if (!fgPersonNames.has(nameKey)) { skippedNoMatch++; continue; }

      const entityIdRow = mem.prepare(
        "SELECT id FROM entities WHERE name=? AND type='person' AND uuid LIKE 'TXS-%'"
      ).get(nameKey);
      if (!entityIdRow) { skippedNoMatch++; continue; }

      mem.prepare(
        'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, allele, phenotype, knowledge_type)' +
        ' VALUES (?, ?, ?, ?, ?)'
      ).run(memId, entityIdRow.id, g.allele || nameKey, g.phenotype || 'neutral', g.knowledge_type || 'factual');
      inserted++;
    }

    if (i - lastLog >= BATCH || i === genes.length - 1) {
      console.log(`  进度: ${i + 1}/${genes.length} | 已插入: ${inserted} | 跳过(非person): ${skippedNotPerson} | 跳过(无匹配): ${skippedNoMatch}`);
      lastLog = i;
    }
  }

  // 验证
  const afterCount = mem.prepare('SELECT COUNT(*) as c FROM memory_entities').get();
  const afterPersonCount = mem.prepare("SELECT COUNT(*) as c FROM memory_entities me JOIN entities e ON me.entity_id=e.id WHERE e.type='person'").get();
  const otherCount = mem.prepare("SELECT COUNT(*) as c FROM memory_entities me JOIN entities e ON me.entity_id=e.id WHERE e.type!='person'").get();
  const totalMems = mem.prepare('SELECT COUNT(*) as c FROM memories').get();
  const covered = mem.prepare('SELECT COUNT(DISTINCT memory_id) as c FROM memory_entities').get();

  console.log(`\n完成!`);
  console.log(`  插入: ${inserted} 条`);
  console.log(`  跳过(非person): ${skippedNotPerson} 条`);
  console.log(`  跳过(无FG匹配): ${skippedNoMatch} 条`);
  console.log(`  结果: ${afterCount.c} 条 (person: ${afterPersonCount.c}, other: ${otherCount.c})`);
  console.log(`  覆盖率: ${covered.c}/${totalMems.c} (${(covered.c / totalMems.c * 100).toFixed(1)}%)`);
  console.log('═'.repeat(60));

  mem.close();
}

main();
