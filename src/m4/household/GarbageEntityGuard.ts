/**
 * GarbageEntityGuard — FG 垃圾实体守卫 (V12.0 P1-1)
 * ==================================================
 * 在实体写入 FamilyGraph 前做最后一道垃圾过滤。
 * 输入: 候选实体名 → 输出: 是否允许写入 FG。
 *
 * 此前散落在各写入路径的脏词/称谓/泛词过滤收敛到此模块。
 * 使用 app-identity 中的 ENTITY_BLACKLIST + EntityCandidateGrader 分级。
 */

import { gradeEntity, type GradedEntity } from '../../app/entity/EntityCandidateGrader.js';
import { ENTITY_BLACKLIST } from '../../config/app-identity.js';

/** L0 称谓扩展（FamilyGraph 上下文特需） */
const FG_EXTRA_BLOCK = new Set([
  '妈妈','爸爸','姐姐','妹妹','哥哥','弟弟','叔叔','阿姨',
  '老婆','老公','儿子','女儿','爷爷','奶奶','外公','外婆',
  '宝贝','亲爱的','心肝','乖乖','小鬼',
]);

/** 允许通过的实体等级 */
const MIN_GRADE = 3; // L3 候选姓名及以上

/**
 * 检查实体名是否可以通过垃圾过滤
 *
 * @param name         候选实体名
 * @param existingNames FG 中已有的人名集合（用于 L4 已知实体判定）
 * @returns { allowed: boolean, reason: string, grade: number }
 */
export function checkEntity(
  name: string,
  existingNames: Set<string> = new Set(),
): { allowed: boolean; reason: string; grade: number; evidenceLevel?: 'strong' | 'weak' } {
  // 快速路径：已知实体直接放行
  if (existingNames.has(name)) {
    return { allowed: true, reason: '已登记的已知实体', grade: 4 };
  }

  // L0: 硬黑名单（无需分词的直接匹配）
  if (ENTITY_BLACKLIST.has(name) || FG_EXTRA_BLOCK.has(name)) {
    return { allowed: false, reason: `黑名单禁止词: ${name}`, grade: 0 };
  }

  // 分级
  const graded = gradeEntity(name, existingNames);

  if (graded.grade < MIN_GRADE) {
    return { allowed: false, reason: `${graded.reason} (L${graded.grade})`, grade: graded.grade };
  }

  // 批12: 透传证据强度 —— weak(L3仅长度达标) 由调用方放入观察区(candidate)
  return { allowed: true, reason: graded.reason, grade: graded.grade, evidenceLevel: graded.evidenceLevel };
}

/**
 * 批量检查
 * @returns 过滤后的安全实体列表
 */
export function filterEntities(
  names: string[],
  existingNames: Set<string> = new Set(),
): { safe: string[]; blocked: Array<{ name: string; reason: string }> } {
  const safe: string[] = [];
  const blocked: Array<{ name: string; reason: string }> = [];
  for (const name of names) {
    const result = checkEntity(name, existingNames);
    if (result.allowed) safe.push(name);
    else blocked.push({ name, reason: result.reason });
  }
  return { safe, blocked };
}

/**
 * 检查并记录垃圾实体（用于启动审计日志）
 */
export function auditGarbage(allNames: string[]): { clean: string[]; garbage: string[] } {
  const existingNames = new Set(allNames);
  const clean: string[] = [];
  const garbage: string[] = [];
  for (const name of allNames) {
    const result = checkEntity(name, new Set()); // 不传入 existingNames 避免全部放行
    if (result.allowed) clean.push(name);
    else garbage.push(name);
  }
  return { clean, garbage };
}

export default { checkEntity, filterEntities, auditGarbage };
