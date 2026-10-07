/**
 * EntityUUIDBackfill — 实体归属的**结构传播**（原 V12.1 的文本推断部分已由 P0-3d 移除）
 * ==================================================================================
 * 🔴 历史与现状（2026-10-07 P0-3d 改写，务必读完再改）：
 *
 *   本模块原以「新实体首次对话时 belong_entity_uuid=NULL」为由，用**全文匹配**回填归属：
 *     · UPDATE conversations SET belong_entity_uuid=? WHERE belong_entity_uuid IS NULL AND content   LIKE '%人名%'
 *     · UPDATE memories      SET belong_entity_uuid=? WHERE belong_entity_uuid IS NULL AND raw_input LIKE '%人名%'
 *   —— 这两步属《P0 记忆体系止血任务书 V3》§3.1 **分类禁止**的「按正文提及的人名推断归属」，
 *   已删除。依据（实测）：166 条无归属记录里 142 条根本不提任何人名；全表 **29.2%** 的已归属记忆
 *   正文提到的是**别人**。P0-3c 的实测后果：刚把 24 条还原为 NULL，本模块（与
 *   MigrationManager.repairDataIntegrity）在下次启动/下一轮对话时把它们**重新认领**回去。
 *
 *   现仅保留**结构关联**一步：black_diamond 沿 `source_id → memories.id` 传导归属 ——
 *   与 `SQLiteAdapter.initialize()` 的第 ⑤ 步、P0-3 的 vault_log C 步同源同法，**不读任何正文**。
 *
 * ⚠️ 功能缺口（已登记为待办，本批刻意不补）：删掉文本回填后，那些"写入时就没定归属"的记录会
 *   **永久保持 NULL**。正解是**写入期就落值**（persistence-stage 在写入时本就知道本轮的
 *   belongEntityUuid，YuyaoMemoryService 的 P0-2a 就是这么做的），而不是事后按正文猜。
 *
 * 设计：独立纯函数，不依赖 FG（避免循环依赖）；幂等（只填 belong_entity_uuid IS NULL 的行）。
 */

/**
 * 结构传播：把 memories 的归属按 `source_id → memories.id` 传导给 black_diamond。
 * 🔴 只读结构列（id / source_id / belong_entity_uuid），**不做任何文本匹配**。
 *
 * @param sqliteDB  fusion_memory.db 的 sql.js 实例
 * @param uuid      实体 UUID (TXS-ID)
 * @returns 本次实际写入的行数（增量，不是总量）
 */
export function propagateBelongBySourceId(sqliteDB: any, uuid: string): number {
  if (!sqliteDB || !uuid) return 0;

  let count = 0;
  try {
    sqliteDB.run(
      "UPDATE black_diamond SET belong_entity_uuid = ? WHERE belong_entity_uuid IS NULL AND source_id IN (SELECT id FROM memories WHERE belong_entity_uuid = ?)",
      [uuid, uuid]
    );
    count += (sqliteDB.getRowsModified?.() || 0);
  } catch { /* 传播不阻塞 */ }

  if (count > 0) console.log(`[EntityUUIDBackfill] black_diamond 结构归属传播 (${uuid}) → ${count} 条`);
  return count;
}

/**
 * 批量传播 —— 对 FG 全部已知 person 的 UUID 各重试一次。
 * 供 pipeline 在 FG 变更后调用（调用点在 persistence-stage）。
 *
 * 🔴 改名说明（P0-3d）：原名 `backfillAllEntities` 保留（调用方未变），但它现在**只做结构传播**；
 *    内部的 `backfillEntityUUID(name, uuid)` 已删除 —— 那个函数名承诺的"按人名回填"正是被禁的做法。
 *    此处按 **UUID 去重**后逐个传播（原实现按人名循环，同一个人多个别名会重复执行同一条 UPDATE）。
 */
export function backfillAllEntities(sqliteDB: any, fg: any): number {
  if (!sqliteDB || !fg) return 0;
  let total = 0;
  try {
    const names = fg.getAllPersonNames?.() || [];
    const uuids = new Set<string>();
    for (const name of names) {
      if (name.length < 2 || name === '我') continue;
      const uuid = fg.getUUIDByName?.(name);
      if (uuid) uuids.add(String(uuid));
    }
    for (const uuid of uuids) total += propagateBelongBySourceId(sqliteDB, uuid);
  } catch { /* 不阻塞 */ }
  if (total > 0) console.log(`[EntityUUIDBackfill] 批量结构传播: ${total} 条`);
  return total;
}

export default { propagateBelongBySourceId, backfillAllEntities };
