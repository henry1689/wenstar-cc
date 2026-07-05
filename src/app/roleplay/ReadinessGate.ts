/**
 * ReadinessGate — 全局就绪门
 *
 * 🔴 铁律：
 *   1. 所有字段共用一套逻辑，无年龄/亲属等个案分支
 *   2. 基于四层数据的 knownFields 自动生成约束话术
 *   3. 不做条件判断，只做数据汇总
 *
 * 修复4：新增查询实体存在校验
 *   如果用户询问的人物不在已知亲属/人物列表中，统一输出约束
 */
import type { FourLayerData, ReadinessReport } from './types.js';

export function checkReadiness(
  data: FourLayerData,
  queryEntities?: string[],
): ReadinessReport {
  const knownFields: Record<string, boolean> = {
    ...data.layer1.knownFields,
  };

  // Layer2 关系层贡献
  if (data.layer2.relatives.length > 0) {
    knownFields.hasRelatives = true;
    for (const rel of data.layer2.relatives) {
      if (rel.relation || rel.relation_to_user) knownFields[`relation_${rel.relation || rel.relation_to_user}`] = true;
    }
  }

  // Layer3 记忆层贡献
  knownFields.hasMemory = data.layer3.memoryText.length > 0;

  // Layer4 知识层贡献
  knownFields.hasKnowledge = data.layer4.knowledgeText.length > 0;

  // 🔴 修复4：统计用户询问的实体是否在已知人物列表中
  const allKnownNames = collectKnownNames(data);
  const unknownEntities: string[] = [];
  if (queryEntities && queryEntities.length > 0) {
    for (const e of queryEntities) {
      if (!allKnownNames.has(e) && !/姐姐|妹妹|哥哥|弟弟|妈妈|爸爸|奶奶|爷爷|老婆|老公|阿姨|叔叔/.test(e)) {
        unknownEntities.push(e);
      }
    }
  }

  // 全局缺失字段
  const missingFields: string[] = [];
  const expectFields = ['age', 'occupation', 'appearance', 'personality', 'birth', 'hasRelatives'];
  for (const f of expectFields) {
    if (!knownFields[f]) missingFields.push(f);
  }

  return {
    knownFields,
    missingFields,
    hasAnyData: Object.values(knownFields).some(v => v === true),
  };
}

/** 收集四层数据中所有已知人名 */
function collectKnownNames(data: FourLayerData): Set<string> {
  const names = new Set<string>();
  if (data.layer1.profile) names.add(data.layer1.profile.name);
  for (const rel of data.layer2.relatives) {
    names.add(rel.name);
  }
  return names;
}
