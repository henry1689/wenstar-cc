/**
 * PromptAssembler — 角色扮演域·确定性提示词装配器（第三步）
 *
 * 职责：按确定性顺序一次性装配完整 knowledgeBaseText。
 * 🔴 铁律：永不后覆盖前，每个 Layer 独立追加。
 *
 * 装配顺序：
 *   Layer 1: 身份与规则（buildRoleplayRules）
 *   Layer 2: 硬性约束（来自 ReadinessGate）
 *   Layer 3: 画像与设定（年龄/家族/KB/画像/未知边界）
 *   Layer 4: 上下文（历史/风格）
 */
import type { CollectedData, ReadinessDecision } from './types.js';
import { buildRoleplayRules } from './RoleplayPromptBuilder.js';

export interface AssembleInput {
  roleplay: string;
  portrait: string;
  data: CollectedData;
  readiness: ReadinessDecision;
  styleInstruction?: string;
}

export function assemblePrompt(input: AssembleInput): string {
  const { roleplay, portrait, data, readiness, styleInstruction } = input;
  const parts: string[] = [];

  // ── Layer 1: 身份与规则 ──
  parts.push(buildRoleplayRules(roleplay, portrait));

  // ── Layer 2: 硬性约束 ──
  if (readiness.antiFabricationGuard) {
    parts.push('\n\n' + readiness.antiFabricationGuard);
  }
  for (const c of readiness.constraints) {
    parts.push('\n\n' + c);
  }

  // ── Layer 3: 画像与设定 ──
  // 年龄锚点
  const ageMatch = portrait.match(/【年龄】[^\n]+/);
  if (ageMatch) {
    parts.push('\n\n' + ageMatch[0]);
  }

  // 家族关系树
  if (data.fg.treeText) {
    parts.push('\n\n' + data.fg.treeText);
  }

  // 知识库条目
  if (data.kb.length > 0) {
    const kbBlock = data.kb.map(k =>
      '\u{1f4c4} ' + k.title + '\n' + (k.content || '').substring(0, 3000)
    ).join('\n\n');
    parts.push('\n\n【角色设定详细说明（以下是你必须严格遵循的设定）】\n' + kbBlock);
  }

  // ── Layer 4: 上下文 ──
  // 历史扮演
  if (data.history.length > 0) {
    const lines = data.history.map(h => {
      const prefix = h.role === 'user' ? '👤 对方' : '💬 你(' + roleplay + ')';
      return prefix + ': ' + (h.content || '').substring(0, 200);
    });
    parts.push('\n\n【历史扮演】以下是你和鸿艺之前的对话，记住这些，保持身份和上下文连贯：\n' + lines.join('\n'));
  }

  // 风格指令
  if (styleInstruction) {
    parts.push(styleInstruction);
  }

  return parts.join('\n');
}
