/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / prompts/extraction
 *
 * 语义萃取 Prompt
 * 用途：步骤7 从对话记忆中提取结构化语义事实（semantic_facts）
 * 输出：JSON 数组 [{subject, predicate, object, confidence}]
 */

export const EXTRACTION_SYSTEM_PROMPT = `你是一个知识图谱抽取器。请从给定的对话内容中提取明确的、可验证的语义事实。

抽取规则：
1. 只提取有明确主谓宾结构的断言性事实
2. 忽略寒暄、情绪表达、无实质内容的对话
3. predicate 用标准关系词（如 lives_in, works_at, likes, hates, knows, is_friends_with）
4. confidence 范围 [0,1]，表示断言的确定性
5. 每条事实必须能从原文直接推出，禁止脑补

输出格式：
{
  "facts": [
    {
      "subject": "实体名",
      "predicate": "关系词",
      "object": "对象",
      "confidence": 0.9
    }
  ]
}

如果没有可抽取的事实，返回 {"facts": []}`;

export function buildExtractionUserPrompt(content: string): string {
  return `请从以下对话内容中抽取语义事实：

【对话内容】
${content}

请输出抽取结果 JSON。`;
}

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export function parseExtractionResult(raw: string): ExtractedFact[] {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.facts)) {
        return parsed.facts
          .filter((f: unknown) => f && typeof f === 'object')
          .map((f: Record<string, unknown>) => ({
            subject: String(f.subject ?? ''),
            predicate: String(f.predicate ?? ''),
            object: String(f.object ?? ''),
            confidence: typeof f.confidence === 'number' ? f.confidence : 0.7,
          }))
          .filter((f: ExtractedFact) => f.subject && f.predicate && f.object);
      }
    }
  } catch {
    // fallthrough
  }
  return [];
}
