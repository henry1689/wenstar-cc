/**
 * reindex-knowledge.ts — 一次性：为所有无向量分块的知识条目补索引
 *
 * 运行: node --max-old-space-size=4096 node_modules/tsx/dist/cli.mjs scripts/reindex-knowledge.ts
 * 效果: 直接操作 SQLite + 本地 TF-IDF 嵌入，绕过 ensureIndex() 全量加载
 */
import { createHash } from 'node:crypto';
import { FileChunker } from '../src/app/tools/FileChunker.js';
import { createLocalEmbedding } from '../src/app/knowledge/EmbeddingProvider.js';

const DB_PATH = 'data/webui/fusion_memory.db';
const chunker = new FileChunker({ strategy: 'paragraph', chunkSize: 500, overlap: 50, minChunkLen: 20 });
const embed = createLocalEmbedding();

// 直接 sqlite3 操作（import 太慢，用 child_process 里的 sqlite3）
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function sql(sql: string, params: any[] = []): Promise<any[]> {
  const tmp = join(tmpdir(), `sql_${Date.now()}.txt`);
  const cmd = params.length > 0
    ? `sqlite3 -json "${DB_PATH}" "${sql.replace(/"/g, '\\"')}"`
    : `sqlite3 -json "${DB_PATH}" "${sql}"`;
  try {
    const out = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    return out.trim() ? JSON.parse(out) : [];
  } catch (e: any) {
    console.error(`[sql error] ${sql.substring(0, 60)}: ${e.message.substring(0, 100)}`);
    return [];
  }
}

async function run(sql: string, params: any[] = []): Promise<void> {
  // sqlite3 不支持参数化，用简单的引号转义
  let safeSql = sql;
  for (const p of params) {
    const escaped = String(p).replace(/'/g, "''");
    safeSql = safeSql.replace(/\?/, `'${escaped}'`);
  }
  try {
    execSync(`sqlite3 "${DB_PATH}" "${safeSql.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' });
  } catch (e: any) {
    console.error(`[run error] ${safeSql.substring(0, 80)}: ${e.message.substring(0, 80)}`);
  }
}

async function main() {
  // 1. 找出所有知识条目
  const rows = await sql('SELECT id, title, content FROM knowledge_base');
  console.log(`[pre] 知识条目总数: ${rows.length}`);

  // 2. 找出已有 chunk 的条目
  const hasChunk = await sql('SELECT DISTINCT kn_id FROM knowledge_chunks WHERE embedding IS NOT NULL');
  const chunkedIds = new Set((hasChunk as any[]).map((r: any) => r.kn_id));
  console.log(`[pre] 已有向量分块的条目: ${chunkedIds.size}`);

  // 3. 需要索引的条目
  const toIndex = rows.filter((r: any) => !chunkedIds.has(r.id));
  console.log(`[pre] 需要索引的条目: ${toIndex.length}`);

  if (toIndex.length === 0) {
    console.log('[done] 全部已有索引，无需操作');
    return;
  }

  // 4. 逐条处理
  let success = 0;
  let fail = 0;
  const totalChunks = toIndex.length * 3; // 粗略估计
  let processed = 0;

  for (const row of toIndex) {
    const knId = row.id;
    const content = row.content || '';
    processed++;
    if (processed % 5 === 0) {
      console.log(`  [${processed}/${toIndex.length}] 正在处理...`);
    }

    try {
      // 分块
      const chunkResult = chunker.chunkWithSummary({ text: content, source: knId });
      if (chunkResult.chunks.length === 0) {
        console.log(`  [skip] ${row.title?.substring(0, 30)}: 无有效分块`);
        continue;
      }

      // 删除旧 chunk
      await run(`DELETE FROM knowledge_chunks WHERE kn_id = '${knId.replace(/'/g, "''")}'`);

      // 生成嵌入
      const chunkTexts = chunkResult.chunks.map(c => c.content);
      const embeddings = await embed.embedBatch(chunkTexts);

      // 写入新 chunk
      for (let i = 0; i < chunkResult.chunks.length; i++) {
        const chunk = chunkResult.chunks[i];
        const chunkId = `${knId}_${chunk.index}`;
        const emb = embeddings[i] || [];
        const embJson = emb.length > 0 ? JSON.stringify(emb) : 'NULL';
        await run(
          `INSERT INTO knowledge_chunks (id, kn_id, chunk_index, chunk_text, embedding) VALUES ('${chunkId}', '${knId}', ${chunk.index}, '${chunk.content.replace(/'/g, "''")}', ${embJson})`
        );
      }

      success++;
    } catch (err: any) {
      fail++;
      console.error(`  [fail] ${row.title?.substring(0, 30)}: ${err.message?.substring(0, 60)}`);
    }
  }

  // 5. 写入 zvec（内存降级，不持久化，但向量搜索路径需要）
  console.log(`[zvec] 跳过 zvec 写入（native 不可用，仅内存降级）`);

  // 6. 验证
  const after = await sql('SELECT COUNT(*) as cnt FROM knowledge_chunks WHERE embedding IS NOT NULL');
  const afterCount = (after[0] as any)?.cnt ?? 0;
  console.log(`[post] 有向量分块的条目: ${afterCount}`);
  console.log(`[result] 成功: ${success}, 跳过/失败: ${fail}`);
}

main().catch(err => {
  console.error('[error]', err);
  process.exit(1);
});
