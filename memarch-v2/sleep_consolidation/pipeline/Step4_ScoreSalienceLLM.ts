/**
 * 步骤4：精确显著性打分（LLM 版）
 * 对候选记忆做五维精确打分，替换 M2 规则版粗分
 * 预算超支自动 defer
 */

import type { StepContext } from '../types.js';
import { SALIENCE_SYSTEM_PROMPT, buildSalienceUserPrompt, parseSalienceResult } from '../prompts/index.js';
import { BaseStep, type StepDeps } from './StepBase.js';

export class ScoreSalienceLLMStep extends BaseStep {
  readonly name = 'score_salience_llm' as const;
  readonly description = 'LLM 精确五维显著性打分';

  constructor(deps: StepDeps) { super(deps); }

  shouldSkipInNap(): boolean { return true; }

  protected async execute(ctx: StepContext): Promise<{ itemsProcessed: number; llmCalls: number; tokensUsed: number }> {
    if (!this.deps.flags.LLM_SALIENCE_ENABLED || !this.deps.llm) {
      return { itemsProcessed: 0, llmCalls: 0, tokensUsed: 0 };
    }

    // 选出 salience 尚未经过 LLM 精分的条目（importance IS NULL）
    const candidates = this.deps.db.prepare(`
      SELECT id, raw_input, summary, episode_id
      FROM memories
      WHERE namespace = ?
        AND importance IS NULL
        AND lifecycle_state IN ('fresh', 'weakening')
        AND suppressed = 0
      ORDER BY salience DESC
      LIMIT ?
    `).all(this.deps.namespace, this.deps.quota.maxLLMSaliencePerCycle) as {
      id: string; raw_input: string | null; summary: string | null; episode_id: string | null;
    }[];

    let llmCalls = 0;
    let tokensUsed = 0;
    const scored: string[] = [];

    for (const mem of candidates) {
      if (!this.deps.budget.canAfford('saliencePerCallTokens')) {
        break; // 预算耗尽，剩余 defer 到下周期
      }

      const content = mem.summary ?? mem.raw_input ?? '';
      if (!content.trim()) continue;

      if (this.deps.budget.reserve('saliencePerCallTokens')) {
        try {
          const res = await this.deps.llm.chat(
            `${SALIENCE_SYSTEM_PROMPT}\n\n${buildSalienceUserPrompt(content)}`,
            { temperature: 0.2, maxTokens: 200 },
          );
          llmCalls++;
          tokensUsed += res.tokensUsed;

          const score = parseSalienceResult(res.content);
          this.updateSalienceScore(mem.id, score);
          scored.push(mem.id);
        } catch {
          // 失败则保留规则版分数
        }
      }
    }

    ctx.llmScoredTraces = scored;
    return {
      itemsProcessed: scored.length,
      llmCalls,
      tokensUsed,
    };
  }

  private updateSalienceScore(traceId: string, score: { importance: number; arousal: number; novelty: number; self_relevance: number; salience: number }): void {
    this.deps.db.prepare(`
      UPDATE memories
      SET importance = ?, arousal = ?, novelty = ?, self_relevance = ?, salience = ?
      WHERE id = ?
    `).run(score.importance, score.arousal, score.novelty, score.self_relevance, score.salience, traceId);
  }
}
