/**
 * PromptAssembler — 四层提示词装配器
 *
 * v4.1: XML分层置顶刚性规则 + fact_database独立区块
 * 底层检索/拓扑不动，仅调整提示结构
 */
import type { FourLayerData } from './types.js';
import { getSessionCache, setSessionCache } from './RoleplaySessionCache.js';

export interface AssembleInput {
  roleplay: string;
  data: FourLayerData;
  styleInstruction?: string;
}

export function assemblePrompt(input: AssembleInput): string {
  const { roleplay, data, styleInstruction } = input;
  const cache = getSessionCache();

  const layer1Text = cache ? cache.layer1 : data.layer1.identityText;
  const layer2Text = cache ? cache.layer2 : data.layer2.relationText;
  const layer3Text = data.layer3.memoryText;
  const layer4Text = data.layer4.knowledgeText;

  if (!cache) setSessionCache(roleplay, layer1Text, layer2Text);

  // ─── 装配 ───
  const parts: string[] = [];

  // 0. 🏷️ 角色扮演标记（下游M5/LLM检测此标记决定绕行策略+温度/推理参数）
  parts.push('【角色扮演】你是' + roleplay + '，用' + roleplay + '的口吻回复。');

  // 1. 核心规则（最顶部，高优先级）
  parts.push(buildCoreRules(roleplay, data));

  // 2. 结构化事实库（独立区块，不与闲聊混同）
  parts.push(buildFactDatabase(roleplay, layer1Text, layer2Text, data));

  // 3. 记忆+知识
  if (layer3Text) parts.push('【过往记忆】\n' + layer3Text);
  if (layer4Text) parts.push('【知识背景】\n' + layer4Text);

  let assembled = parts.join('\n\n---\n\n');

  if (styleInstruction) assembled += '\n\n' + styleInstruction;
  return assembled;
}

function buildCoreRules(roleplay: string, data: FourLayerData): string {
  const lines: string[] = [];

  lines.push('<core_rules priority="MAX">');
  lines.push('1. 事实强制准则：下方【事实库】存在对应亲属、身份记录时，绝对不能回避回答。无记录才可用兜底话术。');
  lines.push('2. 双向禁止红线：');
  lines.push('   ① 禁止抛开人名、亲属关系写大段抒情故事，客观信息必须放在回答首句；');
  lines.push('   ② 禁止刻意冷漠回避已有事实，不得只谈情绪不答问题。');
  lines.push('3. 身份隔离铁律：我为' + roleplay + '，与徐诗雨为两个独立人物，双方亲属、经历完全隔离，严禁混用。');
  lines.push('4. 🔴【场景连续性铁律】');
  lines.push('   ① 对话场景由上下文决定。如果你刚在办公室谈话，继续在办公室。每轮不需要重新描述起身/开门/敲门。');
  lines.push('   ② 用户说短词（是的/嗯/对/好/行/知道了）是普通的肯定回应，不是叫你名字，不要因此中断当前场景。');
  lines.push('   ③ 不要在每轮回复开头插入新的场景描写。只用延续上一轮的对话状态，除非用户明确提到新地点。');
  lines.push('5. 输出格式硬性要求：');
  lines.push('   用户询问家人/亲属类问题，第一行直接给出对应亲属姓名与关系。情绪描写仅做少量补充。');
  lines.push('</core_rules>');

  // 固定身份声明
  lines.push('');
  lines.push('<fixed_identity>');
  lines.push('当前唯一身份：' + roleplay);
  lines.push('我不是徐诗雨，也不是其他任何人。');
  lines.push('</fixed_identity>');

  // 已知人物列表
  const names = collectKnownNames(data);
  if (names.size > 1) {
    lines.push('');
    lines.push('【我认识的人】');
    for (const n of names) if (n !== roleplay) lines.push('  · ' + n);
  }

  return lines.join('\n');
}

function buildFactDatabase(
  roleplay: string,
  layer1Text: string,
  layer2Text: string,
  data: FourLayerData,
): string {
  const lines: string[] = [];
  lines.push('<fact_database>');

  // 核心身份
  if (layer1Text) {
    lines.push('【自身档案】');
    lines.push(layer1Text);
  }

  // 亲属拓扑
  if (layer2Text) {
    lines.push('【亲属关系】');
    lines.push(layer2Text);
  }

  lines.push('</fact_database>');

  // 问答格式指令（紧贴事实库后）
  lines.push('');
  lines.push('【回答格式】');
  lines.push('用户问亲属→第一行直接回答。例如："我妈妈是阿苏。"');
  lines.push('用户问年龄→第一行直接回答。例如："我今年14岁。"');
  lines.push('只有以上<fact_database>中有记录才能回答。没有任何记录时说"我不清楚，你没跟我说过"。');
  lines.push('回答完事实后可以少量补充情绪，但情绪不能覆盖事实。');

  return lines.join('\n');
}

function collectKnownNames(data: FourLayerData): Set<string> {
  const names = new Set<string>();
  if (data.layer1.profile) names.add(data.layer1.profile.name);
  for (const rel of data.layer2.relatives) names.add(rel.name);
  return names;
}
