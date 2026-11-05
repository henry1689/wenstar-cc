/**
 * backfill-v2-vectors — 把记忆向量回填进 MemArch v2 的 vec0 表
 *
 * 为什么需要：
 *   v2 的 `vec_mem_semantic` / `vec_mem_perception` / `vec_ep_semantic` 三张表
 *   建好后是空的。没有向量，语义腿与情感腿就是空转 —— 建表只是把「缺件」
 *   从「表不存在」变成「表是空的」，能力仍然没上线。
 *
 * 用法：
 *   npx tsx scripts/backfill-v2-vectors.ts            # 增量（跳过已回填）
 *   npx tsx scripts/backfill-v2-vectors.ts --force     # 全量重算
 *   npx tsx scripts/backfill-v2-vectors.ts --only=perception   # 只做 40D
 *
 * 🔴 幂等：默认按 trace_id 存在性跳过，中断后直接重跑即可续。
 * 🔴 WAL：v2 库是 WAL 模式，和服务进程的读连接并存安全。
 * 🔴 主库只读：`data/webui/fusion_memory.db` 由 sql.js 独占（delete journal），
 *   这里只以 readonly 打开读 perception_40d，不写、不加锁。
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getEmbeddingProvider, EMBEDDING_DIM } from '../memarch-v2/retrieval/embedding/EmbeddingProvider.js';
import { ensureVectorIndex } from '../memarch-v2/storage/vector_index.js';

const ROOT = process.cwd();
const V2_DB = join(ROOT, 'data', 'memarch-v2.db');
const MAIN_DB = join(ROOT, 'data', 'webui', 'fusion_memory.db');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'all';
const BATCH = Number((args.find((a) => a.startsWith('--batch=')) || '').split('=')[1] || 16);

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function log(msg: string): void {
  console.log(msg);
}

// ─────────────────────────────────────────────────────────────
// 情感 40D 向量：主库 memories.perception_40d → vec_mem_perception
// ─────────────────────────────────────────────────────────────
type PerceptionRow = { id: string; perception_40d: string };

function backfillPerception(v2: Database.Database): void {
  if (!existsSync(MAIN_DB)) {
    log(`⚠️ 主库不存在，跳过情感向量：${MAIN_DB}`);
    return;
  }
  const main = new Database(MAIN_DB, { readonly: true });
  try {
    const total = (main.prepare(
      `SELECT COUNT(*) AS c FROM memories WHERE perception_40d IS NOT NULL AND length(perception_40d) > 2`,
    ).get() as { c: number }).c;

    const done = (v2.prepare('SELECT COUNT(*) AS c FROM vec_mem_perception').get() as { c: number }).c;
    log(`\n[perception 40D] 主库可回填 ${fmt(total)} 条，v2 已有 ${fmt(done)} 条${FORCE ? '（--force 全量重算）' : ''}`);

    const rows = main.prepare(
      `SELECT id, perception_40d FROM memories
       WHERE perception_40d IS NOT NULL AND length(perception_40d) > 2`,
    ).iterate() as IterableIterator<PerceptionRow>;

    const hasStmt = v2.prepare('SELECT 1 FROM vec_mem_perception WHERE trace_id = ?');
    const insStmt = v2.prepare('INSERT OR REPLACE INTO vec_mem_perception(trace_id, embedding) VALUES (?, ?)');

    let ok = 0, skip = 0, bad = 0;
    const t0 = Date.now();
    const insertMany = v2.transaction((batch: Array<{ id: string; buf: Buffer }>) => {
      for (const b of batch) insStmt.run(b.id, b.buf);
    });

    let batch: Array<{ id: string; buf: Buffer }> = [];
    for (const r of rows) {
      if (!FORCE && hasStmt.get(r.id)) { skip++; continue; }
      let dims: number[];
      try {
        const j = JSON.parse(r.perception_40d) as { dims?: unknown };
        dims = Array.isArray(j.dims) ? (j.dims as number[]) : [];
      } catch { bad++; continue; }
      if (dims.length !== 40) { bad++; continue; }
      batch.push({ id: r.id, buf: Buffer.from(new Float32Array(dims).buffer) });
      if (batch.length >= 500) { insertMany(batch); ok += batch.length; batch = []; }
    }
    if (batch.length) { insertMany(batch); ok += batch.length; }

    log(`[perception 40D] ✅ 写入 ${fmt(ok)}，跳过 ${fmt(skip)}，格式异常 ${fmt(bad)}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    main.close();
  }
}

// ─────────────────────────────────────────────────────────────
// 语义向量：memories / episodes 文本 → 512D embedding
// ─────────────────────────────────────────────────────────────
interface TextRow { id: string; text: string }

async function backfillSemantic(v2: Database.Database): Promise<void> {
  const embedder = getEmbeddingProvider();
  log(`\n[semantic] 模型 ${embedder.modelId}（${EMBEDDING_DIM} 维），batch=${BATCH}`);

  const targets: Array<{ table: string; idCol: string; sql: string; label: string }> = [
    {
      table: 'vec_mem_semantic', idCol: 'trace_id', label: 'memories',
      sql: `SELECT id, COALESCE(NULLIF(summary,''), raw_input, '') AS text FROM memories
            WHERE COALESCE(NULLIF(summary,''), raw_input, '') <> ''
              AND lifecycle_state NOT IN ('tombstone','purged')`,
    },
    {
      table: 'vec_ep_semantic', idCol: 'episode_id', label: 'episodes',
      // episodes 没有 topic 列（实测 PRAGMA），只有 gist
      sql: `SELECT id, COALESCE(gist, '') AS text FROM episodes
            WHERE COALESCE(gist, '') <> ''`,
    },
  ];

  for (const t of targets) {
    const done = (v2.prepare(`SELECT COUNT(*) AS c FROM ${t.table}`).get() as { c: number }).c;
    const rows = v2.prepare(t.sql).all() as TextRow[];
    log(`\n[semantic:${t.label}] 候选 ${fmt(rows.length)} 条，已有 ${fmt(done)} 条${FORCE ? '（--force 全量重算）' : ''}`);

    const hasStmt = v2.prepare(`SELECT 1 FROM ${t.table} WHERE ${t.idCol} = ?`);
    const insStmt = v2.prepare(`INSERT OR REPLACE INTO ${t.table}(${t.idCol}, embedding) VALUES (?, ?)`);

    let ok = 0, skip = 0;
    const t0 = Date.now();
    let pending: TextRow[] = [];

    const flush = async (): Promise<void> => {
      if (!pending.length) return;
      // 单条过长会拖慢整批 tokenizer —— 截到 300 字，中文 300 字已远超语义所需
      const texts = pending.map((r) => r.text.slice(0, 300));
      const vecs = await embedder.embedBatch(texts);
      const tx = v2.transaction(() => {
        for (let i = 0; i < pending.length; i++) {
          insStmt.run(pending[i].id, Buffer.from(vecs[i].buffer, vecs[i].byteOffset, vecs[i].byteLength));
        }
      });
      tx();
      ok += pending.length;
      pending = [];
      const elapsed = (Date.now() - t0) / 1000;
      const rate = ok / Math.max(elapsed, 0.001);
      process.stdout.write(`\r  [${t.label}] ${fmt(ok)}/${fmt(rows.length)}  ${rate.toFixed(1)} 条/s   `);
    };

    for (const r of rows) {
      if (!FORCE && hasStmt.get(r.id)) { skip++; continue; }
      pending.push(r);
      if (pending.length >= BATCH) await flush();
    }
    await flush();
    log(`\n[semantic:${t.label}] ✅ 写入 ${fmt(ok)}，跳过 ${fmt(skip)}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

// ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!existsSync(V2_DB)) {
    console.error(`❌ v2 库不存在：${V2_DB}`);
    process.exit(1);
  }
  const v2 = new Database(V2_DB, { allowExtension: true });
  v2.pragma('busy_timeout = 30000');
  try {
    // 🔴 本脚本是独立连接：vec0 扩展必须在这个连接上重新加载，
    //   否则查询 vec 表会报 "no such module: vec0"（扩展是连接级的）。
    //   ensureVectorIndex 幂等，顺带把没建的表补上。
    const vs = ensureVectorIndex(v2);
    if (!vs.ok) {
      console.error(`❌ vec0 扩展加载失败：${vs.error}`);
      console.error('   若提示 not authorized，请确认连接以 { allowExtension: true } 打开。');
      process.exit(1);
    }
    log(`vec0 ${vs.version} 已在回填连接上加载`);

    if (ONLY === 'all' || ONLY === 'perception') backfillPerception(v2);
    if (ONLY === 'all' || ONLY === 'semantic') await backfillSemantic(v2);

    log('\n=== 最终统计 ===');
    for (const t of ['vec_mem_semantic', 'vec_ep_semantic', 'vec_mem_perception']) {
      const c = (v2.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
      log(`  ${t}: ${fmt(c)}`);
    }
  } finally {
    v2.close();
  }
}

main().catch((e) => {
  console.error('❌ 回填失败:', e);
  process.exit(1);
});
