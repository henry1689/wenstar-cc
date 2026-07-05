/**
 * PromptAssembler — 四层提示词装配器
 *
 * 🔴 架构铁律：
 *   1. 角色声明前缀 → 告诉 LLM 它是谁（极简）
 *   2. 四层数据独立列出（Layer1-4）
 *   3. 认知规则在后：四层数据就是全部知识，没有就不知道
 *   4. 不对任何字段加锚点或声明——数据自己说话
 *
 *   不再使用 ageGuard / factPreamble 等补丁。
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

  // ── 角色声明（强制性身份绑定） ──
  const roleHeader = [
    `【角色扮演 — 你完全变成「${roleplay}」】`,
    `你不是玉瑶。你不是阅读材料的人。你就是${roleplay}本人。`,
    `下面四个区域是你的全部记忆和知识。这些不是"你读到的内容"，是你自己知道的事。`,
    `用${roleplay}的口吻直接回答，不要评价或讨论这些信息。`,
  ].join('\n');

  // ── Layer1: 核心身份 ──
  const layer1Identity = cache?.layer1Identity ?? portrait;

  // ── Layer2: 关系 ──
  const layer2Relations = cache?.layer2Relations ?? data.layer2.relations;

  // ── Layer3: 记忆 ──
  const memoryParts: string[] = [];
  if (data.layer3.history.length > 0) {
    memoryParts.push('【近期对话】\n' + data.layer3.history.slice(-6).join('\n'));
  }
  if (data.layer3.goldMemories.length > 0) {
    memoryParts.push(...data.layer3.goldMemories.slice(0, 5));
  }
  if (data.layer3.diamondMemories.length > 0) {
    memoryParts.push(...data.layer3.diamondMemories);
  }
  const layer3Memory = memoryParts.join('\n\n');

  // ── Layer4: 知识 ──
  const layer4Knowledge = data.layer4.kbEntries.join('\n\n');

  // ── 装配四层数据 ──
  const dataBlock = assembleFourLayers({
    layer1Identity,
    layer2Relations,
    layer3Memory,
    layer4Knowledge,
  });

  // ── 认知规则 ──
  const cognitionRule = [
    '【规则】',
    '你的全部信息都在上面四个区域中。',
    '如果被问到具体信息（年龄、关系、人名等），先搜索四层数据：',
    '  Layer1身份层 → Layer2关系层 → Layer3记忆层 → Layer4知识层',
    '四层都找不到就说"不知道"/"你没告诉过我"。',
    '不知道就是不知道，不要编造，不要模糊回避。',
  ].join('\n');

  // ── 组装 ──
  let assembled = [
    roleHeader,
    '',
    dataBlock,
    '',
    cognitionRule,
  ].join('\n\n');

  // ── 追加风格 ──
  if (styleInstruction) {
    assembled += '\n\n' + styleInstruction;
  }

  return assembled;
}
