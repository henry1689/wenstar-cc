/**
 * 新皮层生成层类型定义 — S1 骨架期
 *
 * PromptFragment 结构为 S3 提示词拆分预留
 */
import type { EmotionState24, RelationState, Atmosphere } from '../bus/types.js';

/** 提示词片段（S3 充实） */
export interface PromptFragment {
  id: string;
  category: 'personality' | 'emotion' | 'memory' | 'scene' | 'role' | 'instruction';
  content: string;
  priority: number;
}

/** 生成请求上下文 */
export interface GenerationContext {
  fragments: PromptFragment[];
  emotionVector: EmotionState24;
  relationState: RelationState;
  atmosphere: Atmosphere;
  userMessage: string;
  conversationHistory: Array<{ role: string; content: string }>;
}

/** 生成结果 */
export interface GenerationResult {
  content: string;
  finishReason: string;
}
