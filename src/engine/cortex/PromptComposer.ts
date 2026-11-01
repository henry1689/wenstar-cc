/**
 * PromptComposer — 提示词组装器
 *
 * 按认知层级动态拼接提示词片段：
 * 人格基底 → 情绪状态 → 关系阶段 → 记忆上下文 → 场景指令 → 输出规范
 *
 * 所有提示词片段与业务代码完全解耦。
 * 修改人设只需改 prompts/ 目录下的配置文件。
 */
import type { PromptFragment } from './types.js';
import type { EmotionState24, RelationState, Atmosphere, MemoryPermission } from '../bus/types.js';
import { PERSONALITY_FRAGMENTS } from './prompts/personality.js';
import { RULES_FRAGMENTS } from './prompts/rules.js';
import { buildEmotionFragments } from './prompts/emotion-state.js';
import { buildIntimateFragments } from './prompts/intimate-scenes.js';
import { buildCommunicationFragments } from './prompts/communication-mode.js';

export interface ComposerInput {
  emotionVector: EmotionState24;
  relationState: RelationState;
  atmosphere: Atmosphere;
  memoryPermission: MemoryPermission;
  level?: number;
  hasKnowledgeBase?: boolean;
  hasMemory?: boolean;
  hasFamilyContext?: boolean;
  currentTime?: string;
  userMessage?: string;
  desireHints?: string[];
  emergenceHint?: string;
  /** 时空感知块（来自 TemporalContextAggregator） */
  temporalBlock?: string;
  /** 通信模式（face_to_face / phone / messaging） */
  communicationMode?: string;
}

/**
 * 组装完整系统提示词
 *
 * 按 priority 排序，同 category 聚合，最终拼装。
 */
export function composeSystemPrompt(input: ComposerInput): string {
  const fragments: PromptFragment[] = [];

  // 1. 人格基底（永远在最前面）
  fragments.push(...PERSONALITY_FRAGMENTS);

  // 2. 核心规则
  fragments.push(...RULES_FRAGMENTS);

  // 3. 时空感知（从天象聚合器输出）
  if (input.temporalBlock) {
    fragments.push({
      id: 'context-temporal',
      category: 'scene',
      priority: 250,
      content: input.temporalBlock,
    });
  }

  // 3a. 通信模式（非面对面时注入特定模式指令）
  if (input.communicationMode && input.communicationMode !== 'face_to_face') {
    fragments.push(...buildCommunicationFragments(input.communicationMode));
  }

  // 4. 情绪状态（基于 Heart 输出动态生成）
  fragments.push(...buildEmotionFragments(
    input.emotionVector,
    input.relationState,
    input.atmosphere,
  ));

  // 5. 亲密场景（level ≥ 2 时注入）
  fragments.push(...buildIntimateFragments(
    input.emotionVector,
    input.relationState,
    input.level,
  ));

  // 5. 记忆/知识库上下文
  const contextFragments = buildContextFragments(input);
  fragments.push(...contextFragments);

  // 6. 欲望/涌现提示
  if (input.desireHints?.length) {
    fragments.push({
      id: 'desire-hints',
      category: 'emotion',
      priority: 500,
      content: `【内驱提示】${input.desireHints.join('；')}`,
    });
  }
  if (input.emergenceHint) {
    fragments.push({
      id: 'emergence-hint',
      category: 'emotion',
      priority: 600,
      content: `【情绪涌现】${input.emergenceHint}`,
    });
  }

  // 按优先级排序后拼装
  fragments.sort((a, b) => a.priority - b.priority);
  return fragments.map(f => f.content).join('\n\n');
}

function buildContextFragments(input: ComposerInput): PromptFragment[] {
  const result: PromptFragment[] = [];
  let priority = 400;

  if (input.currentTime) {
    result.push({
      id: 'context-time',
      category: 'memory',
      priority: priority++,
      content: `当前系统时间（北京时间）: ${input.currentTime}`,
    });
  }

  if (input.hasKnowledgeBase) {
    result.push({
      id: 'context-knowledge',
      category: 'memory',
      priority: priority++,
      content: `【知识库】有相关知识可用。自然地运用在回答中，不要提"知识库"或"资料显示"。`,
    });
  }

  if (input.hasMemory) {
    result.push({
      id: 'context-memory',
      category: 'memory',
      priority: priority++,
      content: `【记忆】有相关历史记忆可参考。自然融入回答，不要说"根据记忆"。`,
    });
  }

  if (input.hasFamilyContext) {
    result.push({
      id: 'context-family',
      category: 'memory',
      priority: priority++,
      content: `【家族图谱】有相关人物关系信息。可以用在回答中。`,
    });
  }

  return result;
}
