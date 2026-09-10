/**
 * EntityNameCodec — 「实体名」列的统一编解码标准（C2，2026-09-11）
 * =============================================================
 * 背景（架构性根因）：
 *   「实体名」这一个概念在本仓有**两个列名、两种格式、5+ 处各自实现**：
 *     - conversations.entity_names  —— 逗号分隔（ConversationDB 用 join(',')）
 *     - memories.fg_entity_names    —— 逗号分隔
 *     - memories.entity_genes       —— JSON 数组（含 type/allele/phenotype）
 *   读侧各自实现解析（parseEntityNames / parseConversationEntities / 裸 split ……），
 *   无单一事实源 → **查错列是必然**。已实证 4 处静默降级事故：
 *     SleepTimeConsolidator（归纳恒 0）/ ProspectiveSimulator（匹配恒 0）/
 *     NoveltyDetector（恒 fallback）/ KnowledgeAccessFacade（检索恒空）。
 *
 * 本模块提供唯一入口，并解决一个历史陷阱：
 *   **同一概念两个列名分居两表** —— 用 COLS 常量代替手写列名，避免写错目标表
 *   （memories 只有 fg_entity_names，写成 entity_names 会静默抛错被 catch 吞掉）。
 *
 * 兼容性策略（**忠实超集**，迁移不改行为）：
 *   解析同时接受 ①逗号分隔字符串 ②JSON 数组（元素为字符串或对象）③已是数组的入参；
 *   序列化统一为逗号分隔（本仓写入侧既定格式，见 ConversationDB / MemoryAssessor）。
 *
 * 🔴 永不抛错：这些都是被 try/catch 包裹的旁路读取，抛错会静默降级
 *    —— 正是本项目反复踩的坑，故非法输入一律返回 []。
 */

/** 归一化后的条目：人名串，或旧 JSON 格式的结构化对象 */
export type EntityNameEntry = string | Record<string, unknown>;

/**
 * 两个承载「实体名」的列名常量 —— 唯一事实源，禁止在别处手写这两组字面量。
 * ⚠️ memories 表**只有** fg_entity_names；conversations 表**只有** entity_names。
 */
export const ENTITY_NAME_COLUMNS = {
  /** conversations 表的实体名列 */
  conversations: 'entity_names',
  /** memories 表的实体名列（注意 fg_ 前缀，是同一概念的另一个名字） */
  memories: 'fg_entity_names',
} as const;

/** 从结构化条目里取人名（兼容 name 形状） */
function nameOf(entry: EntityNameEntry): string {
  if (typeof entry === 'string') return entry.trim();
  const n = (entry as Record<string, unknown>).name;
  return typeof n === 'string' ? n.trim() : '';
}

/**
 * 把原始值归一为条目数组。兼容：
 *   - ''/null/undefined                → []
 *   - '徐诗韵,徐诗雨'                   → ['徐诗韵','徐诗雨']
 *   - '["徐诗韵"]'                      → ['徐诗韵']
 *   - '[{"name":"徐诗韵","type":"person"}]' → [{name:'徐诗韵',type:'person'}]
 *   - 已是数组的入参                     → 逐项归一
 */
export function parseEntries(raw: unknown): EntityNameEntry[] {
  if (raw === null || raw === undefined) return [];

  // 已是数组：逐项归一
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === 'string' ? item.trim() : item))
      .filter((item) => (typeof item === 'string' ? item.length > 0 : !!item)) as EntityNameEntry[];
  }

  if (typeof raw !== 'string') return [];
  const s = raw.trim();
  if (!s) return [];

  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => {
            if (typeof item === 'string') return item.trim();
            if (item && typeof item === 'object') return item as Record<string, unknown>;
            return null;
          })
          .filter((item): item is EntityNameEntry => item !== null && item !== '') as EntityNameEntry[];
      }
    } catch {
      /* 非合法 JSON → 落到逗号分支（与历史实现一致） */
    }
  }

  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 只取人名串（最常用路径：SQL LIKE 过滤、话题聚类、跨会话关联……）。
 * 对结构化条目取 `.name`，因此也安全接受 entity_genes 形状的 JSON。
 */
export function parseNames(raw: unknown): string[] {
  return parseEntries(raw)
    .map(nameOf)
    .filter((n) => n.length > 0);
}

/**
 * 规范序列化：逗号分隔（写入侧唯一格式）。
 * 空数组 → ''（与 ConversationDB 既有 `join(',') || ''` 语义一致）。
 */
export function formatNames(names: readonly string[] | null | undefined): string {
  if (!Array.isArray(names) || names.length === 0) return '';
  return names.map((n) => String(n).trim()).filter(Boolean).join(',');
}

/** 便捷判定：该值是否含任意实体名 */
export function hasNames(raw: unknown): boolean {
  return parseNames(raw).length > 0;
}

export default {
  ENTITY_NAME_COLUMNS,
  parseEntries,
  parseNames,
  formatNames,
  hasNames,
};
