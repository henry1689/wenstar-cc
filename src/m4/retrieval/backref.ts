/**
 * backref.ts — 回源键校验与回填（Foundation V1.0）
 * ================================================
 * V13 fake id 修复的基础：SearchHit.backref 携带真实回源键（table + PK），
 * 下游长文直取 / recall_count 更新直接使用，不再靠 `source==='conversation'` 猜 id。
 *
 * backfillBackrefs 用于存量 RankedItem → SearchHit 映射后的校验：
 *   - 按 domain 查表校验 id 真实存在
 *   - 存在 → 补 backref
 *   - 不存在（假 id，如 mapped source='conversation' 但 id 是 memories UUID）→ 剔除，
 *     杜绝泄漏到下游 fetchLongText（retrieval-stage L543-544 注释场景）
 *
 * 设计原则：
 *   - 纯函数，只读 sqlite，零副作用
 *   - family_graph 无归属列 → 不校验（FG 节点 uuid 即户籍 UUID，天然可信）
 */

import type { SearchDomain, SearchHit } from './types.js';

/** 回源键表映射：domain → { table, idCol }；null = 无归属表（不校验） */
export const BACKREF_TABLE: Record<SearchDomain, { table: string; idCol: string } | null> = {
  conversation:    { table: 'conversations',  idCol: 'id' },
  memory:          { table: 'memories',       idCol: 'id' },
  black_diamond:   { table: 'black_diamond',  idCol: 'id' },
  knowledge:       { table: 'knowledge_base', idCol: 'id' },
  vault:           { table: 'vault_log',      idCol: 'id' },
  work:            { table: 'works',          idCol: 'work_id' },
  family_graph:    null,   // FG 节点无归属列，uuid 即户籍 UUID，不校验
  note:            { table: 'memories',       idCol: 'id' },
  // 🔴 ADR-010 P1-C1: 对话块回源到块表本身（不是 conversations）——
  //   下游若要取块的正文/元数据，按 dialog_group_id 去 conversations 聚合即可；
  //   回源键指向 dialog_groups 才能校验「这个块真的存在且归这个户口」。
  //   缺此条 = TS2741 编译失败（SearchDomain 是联合类型，穷举映射必须同步补齐）。
  dialog_group:    { table: 'dialog_groups',  idCol: 'dialog_group_id' },
};

/** 校验单条命中回源键真实存在（sqlite.queryAll 兼容任意带该方法的数据源） */
function backrefExists(
  sqlite: { queryAll(sql: string, params?: unknown[]): unknown[] },
  table: string,
  idCol: string,
  id: string,
): boolean {
  try {
    const rows = sqlite.queryAll(
      `SELECT ${idCol} FROM ${table} WHERE ${idCol} = ? LIMIT 1`,
      [String(id)],
    );
    return rows.length > 0;
  } catch {
    // 表不存在/查询失败 → 保守剔除（宁缺勿滥，杜绝假 id 泄漏）
    return false;
  }
}

/**
 * 校验并回填回源键（V13 假 id 修复）。
 * SQL 适配器在生产时即带 backref；此函数主要服务存量映射与新域缺表场景。
 *
 * @param hits   待校验命中
 * @param sqlite 数据源（queryAll 兼容）
 * @returns      通过校验的命中（假 id 剔除，有效 id 补 backref）
 */
export function backfillBackrefs(
  hits: SearchHit[],
  sqlite: { queryAll(sql: string, params?: unknown[]): unknown[] } | null,
): SearchHit[] {
  if (!hits || hits.length === 0) return hits;
  if (!sqlite) return hits; // 无数据源 → 原样返回（不校验）

  const out: SearchHit[] = [];
  for (const h of hits) {
    const t = BACKREF_TABLE[h.domain];
    // 无归属表（family_graph）→ 保留
    if (!t) { out.push(h); continue; }
    // 已有 backref 且 table 一致 → 保留（生产适配器已带真实键）
    if (h.backref && h.backref.table === t.table) { out.push(h); continue; }
    // 校验 id 真实存在
    if (backrefExists(sqlite, t.table, t.idCol, h.id)) {
      out.push({ ...h, backref: { table: t.table, id: h.id } });
    }
    // 假 id → 剔除（不泄漏到下游）
  }
  return out;
}
