/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / prompts/gist
 *
 * Episode Gist 生成 Prompt
 * 用途：步骤2 事件封口时，为 open episode 生成要点摘要
 * 输出格式：JSON { gist: string, key_entities: string[], arousal_peak: number }
 */

export const GIST_SYSTEM_PROMPT = `你是一个记忆巩固引擎的事件摘要生成器。你的任务是将一段对话事件压缩为结构化要点。

规则：
1. 用 1-3 句话概括整个事件的核心内容
2. 提取 3-7 个关键实体（人名、地名、重要概念）
3. 评估整个事件的峰值唤醒度 [0,1]
4. 输出严格 JSON 格式，不要有多余解释

输出格式：
{
  "gist": "一句话核心摘要",
  "key_entities": ["实体1", "实体2"],
  "arousal_peak": 0.5
}`;

export function buildGistUserPrompt(conversationContent: string, messageCount: number, timeRange: string): string {
  return `请处理以下对话事件片段：

【事件时间范围】${timeRange}
【消息条数】${messageCount}
【对话内容】
${conversationContent}

请生成事件 gist。`;
}

export interface GistResult {
  gist: string;
  key_entities: string[];
  arousal_peak: number;
}

export function parseGistResult(raw: string): GistResult {
  try {
    // 尝试提取 JSON 部分
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        gist: parsed.gist ?? raw.slice(0, 200),
        key_entities: parsed.key_entities ?? [],
        arousal_peak: typeof parsed.arousal_peak === 'number' ? parsed.arousal_peak : 0.5,
      };
    }
  } catch {
    // fallthrough
  }
  return { gist: raw.slice(0, 200), key_entities: [], arousal_peak: 0.5 };
}
