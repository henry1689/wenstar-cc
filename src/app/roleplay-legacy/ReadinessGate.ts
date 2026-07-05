/**
 * ReadinessGate — 数据覆盖报告
 *
 * 🔴 铁律：不做任何条件判断，不猜用户意图，不注入反编造。
 *   只做一件事：汇总所有已知/未知的数据字段。
 *   最终提示词中「已知信息」和「未知边界」永远同时存在，
 *   不需要 ReadinessGate 来决定"要不要注入反编造"。
 *
 * 职责变化：
 *   之前 → 判断"能不能回答" → 每个新场景加一个 if
 *   现在 → 报告"有什么、没什么" → 零条件，PromptAssembler 无条件使用
 */
import type { CollectedData, DataCoverageReport } from './types.js';

/**
 * 生成数据覆盖报告
 * 🔴 没有条件分支。没有意图分类。只有数据汇总。
 */
export function coverageReport(data: CollectedData): DataCoverageReport {
  const entities = data.context.entities;
  const familyMembers = data.fg.familyMembers;

  // 排除亲属称呼后的真实实体
  const realEntities = entities.filter(e =>
    !/姐姐|妹妹|哥哥|弟弟|妈妈|爸爸|奶奶|爷爷|老婆|老公|阿姨|叔叔/.test(e)
  );

  // 这些实体中有哪些在 FG/KB 中真正有数据
  const knownPersons = realEntities.filter(e =>
    familyMembers.includes(e) ||
    data.kb.some(k => k.title.includes(e) || k.content.includes(e)) ||
    data.fg.treeText.includes(e)
  );

  // 汇总缺失字段
  const missingFields: string[] = [];
  if (!data.knownFields.hasAge) missingFields.push('年龄');
  if (!data.knownFields.hasAppearance) missingFields.push('外貌');
  if (!data.knownFields.hasOccupation) missingFields.push('职业');
  if (!data.knownFields.hasPersonality) missingFields.push('性格');
  if (!data.knownFields.hasRelations) missingFields.push('家族关系');

  return {
    knownFields: { ...data.knownFields },
    missingFields,
    knownPersons,
    unknownEntities: realEntities.filter(e => !knownPersons.includes(e)),
    hasAnyData: Object.values(data.knownFields).some(v => v === true),
  };
}
