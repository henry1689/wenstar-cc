/**
 * SourceTypePolicy — 知识库 source_type 统一分类策略
 * =====================================================
 * 所有知识条目按 source_type 分为三类，检索时统一过滤：
 *
 *  FILE — 用户上传的参考文件（md/pdf/txt/…）
 *  ANALYSIS — 系统自动生成的分析报告（梦境洞察/冲突检测/…）
 *  GARBAGE — 不应进入知识库的碎片（landmark/milestone/…）
 *
 * 🔴 铁律：
 *   - 只有 FILE + ANALYSIS 能被检索到
 *   - GARBAGE 在所有检索路径中强制排除
 *   - 此文件是全系统唯一权威——改一处，全局生效
 */

/** 用户上传的参考文件 */
export const FILE_SOURCE_TYPES = new Set([
  'md','txt','text','pdf','docx','xlsx','csv','json',
  'jpg','jpeg','png','gif','bmp','webp','svg',
  'mp4','avi','mov','mkv','webm',
  'architecture','protocol','research','person',
]);

/** 系统自动生成的分析报告 */
export const ANALYSIS_SOURCE_TYPES = new Set([
  'dream_behavior',        // SleepTimeConsolidator - 梦境行为分析
  'systems_consolidation', // SleepTimeConsolidator - 系统巩固
  'prospective_simulation',// ProspectiveSimulator - 前瞻模拟
  'monthly_topic',         // DailyMaintenanceScheduler - 月度话题
  'conflict',              // ConflictDetector - 冲突检测
]);

/** 垃圾——永久排除检索 */
export const GARBAGE_SOURCE_TYPES = new Set([
  'landmark','milestone','dream','spec','query',
]);

/** 可检索的类型 = FILE ∪ ANALYSIS */
export const RETRIEVABLE_SOURCE_TYPES = new Set([
  ...FILE_SOURCE_TYPES,
  ...ANALYSIS_SOURCE_TYPES,
]);

/** 生成 SQL IN 子句用的逗号分隔字符串 */
export function RETRIEVABLE_SQL_IN(): string {
  return [...RETRIEVABLE_SOURCE_TYPES].map(s => `'${s}'`).join(',');
}

/** 生成 SQL NOT IN 子句用的逗号分隔字符串 */
export function GARBAGE_SQL_NOT_IN(): string {
  return [...GARBAGE_SOURCE_TYPES].map(s => `'${s}'`).join(',');
}

/** 判断一个 source_type 是否可入库（add()守卫用） */
export function isAllowedForAdd(srcType: string | null | undefined): boolean {
  if (!srcType) return true; // null/empty → 兼容旧数据
  return FILE_SOURCE_TYPES.has(srcType.toLowerCase()) || ANALYSIS_SOURCE_TYPES.has(srcType.toLowerCase());
}

/** 判断一个 source_type 是否可检索 */
export function isRetrievable(srcType: string | null | undefined): boolean {
  if (!srcType) return true;
  return RETRIEVABLE_SOURCE_TYPES.has(srcType.toLowerCase());
}
