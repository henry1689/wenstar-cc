/**
 * 回填黑钻库 l2_norm 字段
 *
 * 为所有有 emotion_vector 但无 l2_norm 的黑钻条目计算并更新
 */
import initSqlJs from 'sql.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'webui', 'fusion_memory.db');

async function main() {
  if (!existsSync(DB_PATH)) {
    console.log(`数据库不存在: ${DB_PATH}`);
    return;
  }

  const SQL = await initSqlJs();
  const buffer = readFileSync(DB_PATH);
  const db = new SQL.Database(buffer);

  // 确保列存在
  try { db.run("ALTER TABLE black_diamond ADD COLUMN l2_norm REAL DEFAULT NULL"); } catch {}

  const rows = db.exec("SELECT id, emotion_vector FROM black_diamond WHERE emotion_vector IS NOT NULL AND l2_norm IS NULL");
  if (!rows.length || !rows[0].values) {
    console.log('没有需要回填的条目');
    db.close();
    return;
  }

  let count = 0;
  for (const row of rows[0].values) {
    const id = row[0];
    const vecStr = row[1];
    if (!vecStr) continue;
    try {
      const vec = JSON.parse(vecStr as string);
      if (!Array.isArray(vec) || vec.length < 24) continue;
      let l2 = 0;
      for (const v of vec) l2 += v * v;
      l2 = Math.sqrt(l2);
      db.run("UPDATE black_diamond SET l2_norm = ? WHERE id = ?", [l2, id]);
      count++;
    } catch {}
  }

  // 写回文件
  const outBuf = db.export();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(DB_PATH, Buffer.from(outBuf));

  console.log(`回填完成: ${count} 条`);
  db.close();
}

main().catch(console.error);
