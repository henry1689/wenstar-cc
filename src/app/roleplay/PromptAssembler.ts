/**
 * PromptAssembler — 四层提示词装配器
 *
 * 🔴 约束4：层级顺序不可逆 Layer1→Layer2→Layer3→Layer4
 *    约束5：记忆严格控量（Top5+最近Top3取并集 ≤8条）
 */
import type { FourLayerData } from './DataCollector.js';
import { buildRoleplayRules } from './RoleplayPromptBuilder.js';
import { assembleFourLayers } from '../../core/cognitive/FourLayerAssembler.js';
import { getSessionCache } from './RoleplaySessionCache.js';

export interface AssembleInput {
  roleplay: string;
  portrait: string;
  data: FourLayerData;
  styleInstruction?: string;
}

export function assemblePrompt(input: AssembleInput): string {
  const { roleplay, portrait, data, styleInstruction } = input;
  const cache = getSessionCache();

  // Layer1: 核心身份
  const layer1Identity = cache?.layer1Identity ?? portrait;

  // Layer2: 关系
  const layer2Relations = cache?.layer2Relations ?? data.layer2.relations;

  // Layer3: 记忆（控量：历史40轮 + 金库Top5 + 黑钻）
  const memoryParts: string[] = [];
  if (data.layer3.history.length > 0) {
    memoryParts.push('【近期对话】\n' + data.layer3.history.slice(-10).join('\n'));
  }
  if (data.layer3.goldMemories.length > 0) {
    memoryParts.push(...data.layer3.goldMemories.slice(0, 5));
  }
  if (data.layer3.diamondMemories.length > 0) {
    memoryParts.push(...data.layer3.diamondMemories);
  }
  const layer3Memory = memoryParts.join('\n\n');

  // Layer4: 知识
  const layer4Knowledge = data.layer4.kbEntries.join('\n\n');

  // 规则（前置）
  const rules = buildRoleplayRules(roleplay, layer1Identity);

  // 用基类装配
  const assembled = assembleFourLayers({
    layer1Identity: rules,
    layer2Relations,
    layer3Memory,
    layer4Knowledge,
  });

  // 追加年龄锚点
  const ageGuard = data.layer1.ageGuard;
  const result = ageGuard ? assembled + '\n\n' + ageGuard : assembled;

  // 追加风格
  if (styleInstruction) {
    return result + '\n\n' + styleInstruction;
  }
  return result;
}
