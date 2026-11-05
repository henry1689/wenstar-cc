/**
 * backfill-entity-uuids — 给主库 entities 表补全域 UUID
 *
 * 为什么需要：
 *   `entities` 3,999 个实体里只有 1,047 个有 uuid（26%）。下游全部卡在这里：
 *   · `entity_relations` 13,636 行两端都能映射到 uuid 的只有 **14 行** → PPR 腿空转；
 *   · `memory_entities` 14,008 行有 3,739 行缺实体 uuid → trace_entities 不全。
 *   不补 uuid，「v2 完整版」永远差两条腿。
 *
 * 🔴 必须停服执行：
 *   主库 `data/webui/fusion_memory.db` 由 sql.js 整库载入内存、flushNow 时**整库覆盖**
 *   磁盘文件。服务运行期间直接改库，改动会在下一次 flush 时被无声抹掉。
 *   执行前置：`pm2 stop wenstar-webui`。
 *
 * 用法：
 *   npx tsx scripts/backfill-entity-uuids.ts --dry-run
 *   npx tsx scripts/backfill-entity-uuids.ts
 *
 * 幂等：只处理 uuid 为空/NULL 的行；已有 uuid 一律不动。
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MAIN_DB = join(ROOT, 'data', 'webui', 'fusion_memory.db');
const BACKUP_DIR = join(ROOT, 'data', 'backups');
const DRY = process.argv.includes('--dry-run');

/** 补 uuid 的优先级（人在前，其次实体物、地点、事件、情绪、自我） */
const TYPE_ORDER = ['person', 'object', 'place', 'event', 'emotion', 'self'];

const fmt = (n: number): string => n.toLocaleString('en-US');

function main(): void {
  if (!existsSync(MAIN_DB)) {
    console.error(`❌ 主库不存在：${MAIN_DB}`);
    process.exit(1);
  }

  const db = new Database(MAIN_DB);
  db.pragma('busy_timeout = 30000');
  try {
    const before = db.prepare(
      "SELECT COUNT(*) AS c FROM entities WHERE uuid IS NULL OR uuid = ''",
    ).get() as { c: number };
    if (before.c === 0) {
      console.log('✅ 所有实体都已有 uuid，进入去重检查');
      dedupe(db, DRY);
      return;
    }

    const maxRow = db.prepare(
      "SELECT MAX(CAST(SUBSTR(uuid, 5) AS INTEGER)) AS m FROM entities WHERE uuid LIKE 'TXS-%'",
    ).get() as { m: number | null };
    let next = (maxRow.m ?? 0) + 1;
    console.log(`待补 ${fmt(before.c)} 个实体，起始序号 TXS-${String(next).padStart(9, '0')}`);

    // 按类型优先级取，保证 person 拿到靠前的号段
    const rows = db.prepare(
      "SELECT id, type, name FROM entities WHERE uuid IS NULL OR uuid = ''",
    ).all() as Array<{ id: number; type: string; name: string }>;
    rows.sort((a, b) => {
      const ia = TYPE_ORDER.indexOf(a.type);
      const ib = TYPE_ORDER.indexOf(b.type);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.id - b.id;
    });

    const preview: string[] = [];
    const plan: Array<{ id: number; uuid: string; type: string; name: string }> = [];
    for (const r of rows) {
      const uuid = `TXS-${String(next++).padStart(9, '0')}`;
      plan.push({ id: r.id, uuid, type: r.type, name: r.name });
      if (preview.length < 3) preview.push(`  ${r.type}/${r.name} → ${uuid}`);
    }

    if (DRY) {
      console.log('DRY-RUN：将写入以下（示例前 3 条）:');
      for (const p of preview) console.log(p);
      const byType: Record<string, number> = {};
      for (const p of plan) byType[p.type] = (byType[p.type] || 0) + 1;
      console.log('按类型:', JSON.stringify(byType));
      return;
    }

    // 🔴 写前备份：这是主库，改坏了无法从 v2 反推
    if (!existsSync(BACKUP_DIR)) throw new Error(`备份目录不存在：${BACKUP_DIR}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(BACKUP_DIR, `fusion_memory_pre-uuid-${stamp}.db`);
    copyFileSync(MAIN_DB, backupPath);
    console.log(`已备份主库 → ${backupPath}（${(statSync(backupPath).size / 1048576).toFixed(1)} MB）`);

    const upd = db.prepare('UPDATE entities SET uuid = ? WHERE id = ?');
    const tx = db.transaction(() => { for (const p of plan) upd.run(p.uuid, p.id); });
    tx();

    const after = db.prepare(
      "SELECT COUNT(*) AS c FROM entities WHERE uuid IS NULL OR uuid = ''",
    ).get() as { c: number };
    const dup = db.prepare(
      'SELECT COUNT(*) AS c FROM (SELECT uuid FROM entities WHERE uuid IS NOT NULL AND uuid <> \'\' GROUP BY uuid HAVING COUNT(*) > 1)',
    ).get() as { c: number };
    console.log(`✅ 写入 ${fmt(plan.length)} 个 uuid；剩余空值 ${fmt(after.c)}；重复 uuid 组 ${dup.c}`);
    dedupe(db, DRY);
  } finally {
    db.close();
  }
}

/**
 * 去重：同一 uuid 挂在多个实体上时，保留 id 最小者，其余重新分配。
 *
 * 实测 7 组重复，分两类：
 *   · 真别名（王全芬/阿芬、阿珍/罗珍思）—— 拆开不丢关系：关系表用 entity_id 引用，
 *     不是用 uuid 引用；拆开只是让别名不再"冒充"本人身份。
 *   · 短语污染（「能看」「尤其」「后一起」等句子碎片被赋了真人 uuid）—— 必须拆，
 *     否则这些碎片会和真人共享 PPR 邻居，把噪声灌进多跳联想。
 */
function dedupe(db: Database.Database, dry: boolean): void {
  const dupRows = db.prepare(
    "SELECT uuid FROM entities WHERE uuid IS NOT NULL AND uuid <> '' GROUP BY uuid HAVING COUNT(*) > 1",
  ).all() as Array<{ uuid: string }>;
  if (dupRows.length === 0) {
    console.log('✅ 无重复 uuid');
    return;
  }

  const maxRow = db.prepare(
    "SELECT MAX(CAST(SUBSTR(uuid, 5) AS INTEGER)) AS m FROM entities WHERE uuid LIKE 'TXS-%'",
  ).get() as { m: number | null };
  let next = (maxRow.m ?? 0) + 1;

  const plan: Array<{ id: number; name: string; oldUuid: string; newUuid: string }> = [];
  for (const d of dupRows) {
    const ents = db.prepare('SELECT id, name FROM entities WHERE uuid = ? ORDER BY id').all(d.uuid) as Array<{ id: number; name: string }>;
    for (const e of ents.slice(1)) {
      plan.push({ id: e.id, name: e.name, oldUuid: d.uuid, newUuid: `TXS-${String(next++).padStart(9, '0')}` });
    }
  }

  console.log(`\n去重：${dupRows.length} 组，需重分配 ${plan.length} 个实体`);
  for (const p of plan) console.log(`  #${p.id} ${p.name}: ${p.oldUuid} → ${p.newUuid}`);

  if (dry) return;

  const upd = db.prepare('UPDATE entities SET uuid = ? WHERE id = ?');
  const tx = db.transaction(() => { for (const p of plan) upd.run(p.newUuid, p.id); });
  tx();

  const left = db.prepare(
    "SELECT COUNT(*) AS c FROM (SELECT uuid FROM entities WHERE uuid IS NOT NULL AND uuid <> '' GROUP BY uuid HAVING COUNT(*) > 1)",
  ).get() as { c: number };
  console.log(`✅ 去重完成，剩余重复组 ${left.c}`);
}

main();
