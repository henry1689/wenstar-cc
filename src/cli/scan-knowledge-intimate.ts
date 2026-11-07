/**
 * 🔍 存量知识库亲密内容扫描脚本
 *
 * 复用 config/ingestion-guard.ts 的规则，全量扫描现有 knowledge_base，
 * 将命中规则的内容标记或清理。
 *
 * 运行:
 *   npx tsx src/cli/scan-knowledge-intimate.ts           # 只扫描，不删除
 *   npx tsx src/cli/scan-knowledge-intimate.ts --clean    # 扫描并清理
 *   npx tsx src/cli/scan-knowledge-intimate.ts --report   # 输出 JSON 报告
 *
 * 🔴 2026-11-07 存储底座收尾（ADR-017）：
 *   原实现用 sql.js 整库载入 + `db.export()` 覆盖写 DB_PATH —— 服务在跑时执行
 *   会把「载入那一刻的快照」整库覆盖回去，配合服务端的 WAL 重放直接损坏库。
 *   现改 SqlJsCompat（better-sqlite3）：页级落盘，删除即时生效，不再有整库覆盖。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INGESTION_GUARD } from '../config/ingestion-guard.js';
import { SqlJsCompat } from '../m2/SqlJsCompat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');
const DB_PATH = join(PROJECT_ROOT, 'data', 'webui', 'fusion_memory.db');

interface ScanResult {
  item: { id: string; title: string; content_preview: string; classification?: string };
  reason: string;
}

async function main() {
  const args = process.argv.slice(2);
  const doClean = args.includes('--clean');
  const doReport = args.includes('--report');

  if (!existsSync(DB_PATH)) {
    console.error('🔴 数据库不存在:', DB_PATH);
    process.exit(1);
  }

  const db = new SqlJsCompat(DB_PATH);

  // 检查表是否存在
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_base'");
  if (tables.length === 0 || tables[0].values.length === 0) {
    console.log('知识库表不存在，无需扫描');
    db.close();
    return;
  }

  const rows = db.exec('SELECT id, title, content, classification, tags FROM knowledge_base ORDER BY created_at DESC');
  if (rows.length === 0 || rows[0].values.length === 0) {
    console.log('知识库为空');
    db.close();
    return;
  }

  const { columns, values } = rows[0];
  const KEYWORDS_RE = new RegExp(INGESTION_GUARD.intimateKeywords.join('|'));
  const WHITELIST_RE = new RegExp(INGESTION_GUARD.whitelistTerms.join('|'));

  const flagged: ScanResult[] = [];
  let scanned = 0;

  for (const row of values) {
    const item: any = {};
    columns.forEach((c: string, i: number) => item[c] = row[i]);
    scanned++;

    const titleContent = (item.title || '') + ' ' + (item.content || '');
    const matched = titleContent.match(KEYWORDS_RE);

    if (matched) {
      // 白名单抵消：如果内容包含医学/生理/科普等白名单词汇，放行
      const hasWhitelist = WHITELIST_RE.test(titleContent);
      if (hasWhitelist) continue;

      flagged.push({
        item: {
          id: item.id,
          title: (item.title || '').substring(0, 60),
          content_preview: (item.content || '').substring(0, 80),
          classification: item.classification || undefined,
        },
        reason: `命中关键词: ${matched.join(', ')}`,
      });
    }
  }

  console.log(`\n📊 扫描结果: 共 ${scanned} 条`);
  console.log(`🚩 命中亲密规则: ${flagged.length} 条`);

  if (flagged.length > 0) {
    console.log('\n=== 命中条目列表 ===');
    for (const f of flagged) {
      console.log(`  [${f.item.id}] ${f.item.title}`);
      console.log(`      内容: ${f.item.content_preview}`);
      console.log(`      分类: ${f.item.classification || '无'}`);
      console.log(`      原因: ${f.reason}`);
      console.log('');
    }

    if (doClean) {
      console.log('🧹 开始清理...');
      let cleaned = 0;
      for (const f of flagged) {
        try {
          db.run('DELETE FROM knowledge_base WHERE id = ?', [f.item.id]);
          db.run('DELETE FROM knowledge_chunks WHERE kn_id = ?', [f.item.id]);
          cleaned++;
        } catch (e) {
          console.warn(`  删除失败: ${f.item.id}`, e);
        }
      }
      // 🔴 不再整库导出：删除已由页级写入即时落盘（close 内含 wal_checkpoint）
      console.log(`✅ 已清理 ${cleaned} 条知识库条目`);
    } else {
      console.log('🟡 未执行清理（添加 --clean 参数执行删除）');
    }
  } else {
    console.log('✅ 知识库干净，无亲密内容');
  }

  if (doReport) {
    const reportPath = join(PROJECT_ROOT, 'data', 'reports', `kb-intimate-scan-${Date.now()}.json`);
    const reportDir = join(PROJECT_ROOT, 'data', 'reports');
    if (!existsSync(reportDir)) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(reportDir, { recursive: true });
    }
    writeFileSync(reportPath, JSON.stringify({
      scannedAt: new Date().toISOString(),
      totalScanned: scanned,
      flagged: flagged.length,
      items: flagged,
      cleaned: doClean,
    }, null, 2));
    console.log(`📝 报告已保存: ${reportPath}`);
  }

  db.close();
}

main().catch(console.error);
