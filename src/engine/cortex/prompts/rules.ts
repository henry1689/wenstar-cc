/**
 * 核心规则提示词片段（补充层）
 *
 * 🔴 P-01（PAS v1 / V27批2）：本文件曾与 `m5/prompts/core-rules.ts` 重复定义
 * 「核心铁律」「回答长度标准」「禁止内心独白」「口语化铁律」等，
 * 而且**不是逐字重复，是两套互相冲突的标准**：
 *   · 长度：core-rules 15-35 / 40-80 / 120-180 / 200-280 字
 *           vs 本文件（旧）30-80 / 200-400 / 200-400 / 300-500 字
 *   · 风格：core-rules「流畅自然，有温度」 vs 本文件（旧）「简短自然，1-4句」
 * 两者分别经 `systemPrompt`（buildSystemPrompt）与 `PFC → finalKnowledgeText`
 * （composeSystemPrompt）注入**同一个 prompt**，使 LLM 收到矛盾的长度与风格要求
 * —— 这是"回答不规范"的直接成因之一（2026-09-19 诊断）。
 *
 * 📜 现行规定（P-01 单一真源）：
 *   **L0 唯一真源 = `m5/prompts/core-rules.ts`**。
 *   本文件只允许保留 core-rules **未覆盖**的补充片段。
 *   新增内容前必须确认 L0 未覆盖，并登记注入点清单（P-17）。
 */
import type { PromptFragment } from '../types.js';
// 🔴 MEM-UNIFY-V1 批1：记忆表达法只引用 MEMORY-LAW-V1 单一法源，本文件不再另写文案。
import { MEMORY_LAW_COMPACT } from '../../../m5/prompts/memory-expression-law.js';

export const RULES_FRAGMENTS: PromptFragment[] = [
  {
    // L0 未覆盖：亲密语境的语气基调（core-rules 只有"口语化/长度/禁止内心独白"）
    id: 'rules-intimacy-tone',
    category: 'instruction',
    priority: 200,
    content: `【亲密语境基调】亲密时自然亲密，不害羞、不扭捏、不拽衣角。热恋中的女友/妻子该怎么说话就怎么说话。`,
  },
  {
    // L0 未覆盖：记忆表达的补充提醒（完整三档法条在会晤 L0；日常由角色模板与本片段承载）。
    // id 保留 rules-anti-hallucination：prompt-assembly-spec 的注入点清单按此 id 登记。
    id: 'rules-anti-hallucination',
    category: 'instruction',
    priority: 400,
    content: MEMORY_LAW_COMPACT,
  },
];
