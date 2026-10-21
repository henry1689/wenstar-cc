/**
 * RelationLabels — 关系边→中文展示标签（T011 Phase1 派生自 RELATION_TYPE_DEFS）
 *
 * 🎯 单一真源：RELATION_TYPE_DEFS（74 项）是唯一关系类型定义。
 *    本模块不再维护独立词表，改为从 DEFS 派生正向/反向标签。
 *
 * 使用方：
 *   - FamilyGraph._getEdgeDisplayLabel → getRelationLabel()
 *   - EntityContextBuilder._getRelatedEdges → getRelationLabel()
 */

import { RELATION_TYPE_DEFS } from '../../../app/fg/RelationshipTypes.js';

/**
 * 根据边类型和方向返回中文展示标签（派生自 RELATION_TYPE_DEFS）。
 *
 * @param relation - 边类型 (如 "mother_of")
 * @param isOutgoing - 是否正向（true=source→target 方向，false=target→source 方向）
 * @returns 中文标签，如 "母亲"、"姐姐"、"同事"
 */
export function getRelationLabel(relation: string, isOutgoing: boolean): string {
  const def = RELATION_TYPE_DEFS[relation];
  if (!def) return relation; // fallback: 直接返回原始边类型名

  // 正向标签：直接用 DEFS 中定义的 label
  if (isOutgoing) return def.label;

  // 反向标签：查找 reverse 指向的类型的 label
  // 如果 reverse === relation（对称关系如 spouse_of），返回相同标签
  if (def.reverse === relation) return def.label;

  const reverseDef = RELATION_TYPE_DEFS[def.reverse];
  if (reverseDef) return reverseDef.label;

  // reverse 指向的类型不存在于 DEFS，返回当前类型的 label（降级）
  return def.label;
}

/**
 * V10.4: 获取修正后的 relation_to_user
 * ======================================
 * FG 启动迁移脚本有 bug——反复覆盖 nodes.properties.relation_to_user。
 * 此函数是全局唯一定义点：EntityContextBuilder /
 * EntityGreetingProtocol / M4Orchestrator 均从此处读取。
 *
 * 新增/修正实体时，只改此处的 FIXES 映射即可，全局生效。
 */
const RELATION_FIXES: Record<string, string> = {
  '徐诗雨': '同事——熊勇的下属（高峰电业）',
  '徐诗韵': '密友——通过姐姐诗雨认识',
  '徐诗涵': '密友——通过姐姐诗雨认识',
  '熊梓铭': '熊勇的女儿（心理学专业学生）',
  '熊梓玥': '熊勇的小女儿（学生）',
  '熊勇': '同事——高峰电业营销总监',
  '王全芬': '熊勇的妻子（全职太太）',
  '阿苏': '徐家姐妹的母亲（全职太太）',
  '徐东伟': '徐家姐妹的父亲（在贵港务工）',
};

export function getCorrectedRelation(entityName: string, profileRel: string | undefined | null): string {
  return RELATION_FIXES[entityName] || profileRel || '';
}
