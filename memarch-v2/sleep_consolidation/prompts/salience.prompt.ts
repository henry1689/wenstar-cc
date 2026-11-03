/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / prompts/salience
 *
 * 精确显著性打分 Prompt（LLM 版）
 * 用途：步骤4 对候选记忆做五维精确打分
 * 五维：importance / arousal / novelty / self_relevance / (entropy)
 * 输出：JSON 各维度分数 + 综合 salience
 */

export const SALIENCE_SYSTEM_PROMPT = `你是一个记忆显著性评估专家。请对给定的记忆内容从四个维度打分，每个维度范围 [0.0, 1.0]。

打分维度说明：
1. importance（重要性）：该信息对长期目标、身份认知的重要程度。0=闲聊无意义，1=改变人生/核心决策。
2. arousal（唤醒度）：情感强度/情绪波动。0=平淡如水，1=极度震撼/强烈情绪。
3. novelty（新颖性）：信息的新鲜程度。0=已知旧信息重复，1=全新从未接触的领域。
4. self_relevance（自我关联度）：与用户自身、人际关系、个人偏好的关联程度。0=完全无关的外部知识，1=直接关于用户本人。

综合分 salience = importance*0.4 + arousal*0.2 + novelty*0.2 + self_relevance*0.2

严格输出 JSON 格式：
{
  "importance": 0.0,
  "arousal": 0.0,
  "novelty": 0.0,
  "self_relevance": 0.0,
  "salience": 0.0,
  "reasoning": "一句话理由"
}`;

export function buildSalienceUserPrompt(content: string, context?: string): string {
  const contextPart = context ? `【相关上下文】\n${context}\n\n` : '';
  return `请对以下记忆内容进行显著性打分：

${contextPart}【记忆内容】
${content}

请输出打分 JSON。`;
}

export interface SalienceScore {
  importance: number;
  arousal: number;
  novelty: number;
  self_relevance: number;
  salience: number;
  reasoning: string;
}

export function parseSalienceResult(raw: string): SalienceScore {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        importance: clamp01(parsed.importance),
        arousal: clamp01(parsed.arousal),
        novelty: clamp01(parsed.novelty),
        self_relevance: clamp01(parsed.self_relevance),
        salience: clamp01(parsed.salience),
        reasoning: parsed.reasoning ?? '',
      };
    }
  } catch {
    // fallthrough
  }
  // 默认兜底
  return { importance: 0.5, arousal: 0.5, novelty: 0.5, self_relevance: 0.5, salience: 0.5, reasoning: 'parse fallback' };
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
