/**
 * sync-entity-dict — 把主库 entities 的 (uuid, name, type) 投影到 v2 的 entity_names
 *
 * 用途：给 PPR 腿提供中文实体名识别能力。见 memarch-v2/storage/entity_dict.ts 的说明。
 *
 * 用法：npx tsx scripts/sync-entity-dict.ts
 * 幂等：全量替换。
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { replaceEntityDict } from '../memarch-v2/storage/entity_dict.js';

const ROOT = process.cwd();
const V2_DB = join(ROOT, 'data', 'memarch-v2.db');
const MAIN_DB = join(ROOT, 'data', 'webui', 'fusion_memory.db');

function main(): void {
  if (!existsSync(V2_DB) || !existsSync(MAIN_DB)) {
    console.error('❌ 库文件缺失');
    process.exit(1);
  }
  const main = new Database(MAIN_DB, { readonly: true });
  const v2 = new Database(V2_DB, { allowExtension: true });
  try {
    const rows = main.prepare(
      "SELECT uuid, name, type FROM entities WHERE uuid IS NOT NULL AND uuid <> '' AND name IS NOT NULL AND name <> ''",
    ).all() as Array<{ uuid: string; name: string; type: string }>;

    // 🔴 同一个 uuid 可能有多个别名（王全芬/阿芬 已各自独立，但历史上存在多行同名）。
    //   INSERT OR REPLACE 按 uuid 主键去重 —— 保留最后一条，名字可能不是最常用的。
    //   这里按行数先统计一下，便于发现异常。
    const byUuid = new Map<string, { uuid: string; name: string; type: string }>();
    for (const r of rows) byUuid.set(r.uuid, r);

    const n = replaceEntityDict(v2, Array.from(byUuid.values()));
    console.log(`✅ entity_names 已同步 ${n} 条（主库原文 ${rows.length} 行，去重后 ${byUuid.size} 个 uuid）`);

    const dupNames = v2.prepare(
      'SELECT name, COUNT(*) c FROM entity_names GROUP BY name HAVING c > 1 ORDER BY c DESC LIMIT 5',
    ).all() as Array<{ name: string; c: number }>;
    if (dupNames.length) console.log('同名多 uuid（最长匹配时会取第一个命中）:', JSON.stringify(dupNames));
  } finally {
    main.close(); v2.close();
  }
}

main();
