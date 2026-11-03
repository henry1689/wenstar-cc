/**
 * 步骤7：语义萃取
 * 从高显著性记忆中提取结构化 semantic_facts
 */

import type { StepContext } from '../types.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt, parseExtractionResult } from '../prompts/index.js';
import { BaseStep, type StepDeps } from './StepBase.js';

export class ExtractSemanticStep extends BaseStep {
  readonly name = 'extract_semantic' as const;
  readonly description = '从记忆中萃取结构化语义事实';

  constructor(deps: StepDeps) { super(deps); }

  shouldSkipInNap(): boolean { return true; }

  protected async execute(ctx: StepContext): Promise<{ itemsProcessed: number; llmCalls: number; tokensUsed: number }> {
    if (!this.deps.flags.SEMANTIC_EXTRACTION_ENABLED || !this.deps.llm) {
      return { itemsProcessed: 0, llmCalls: 0, tokensUsed: 0 };
    }

    // 选出高显著性、尚未萃取过的记忆
    const candidates = this.deps.db.prepare(`
      SELECT m.id, m.raw_input, m.summary
      FROM memories m
      WHERE m.namespace = ?
        AND m.salience >= 0.6
        AND m.lifecycle_state NOT IN ('purged', 'tombstone')
        AND NOT EXISTS (
          SELECT 1 FROM semantic_facts sf WHERE sf.source_ids LIKE '%' || m.id || '%'
        )
      ORDER BY m.salience DESC
      LIMIT ?
    `).all(this.deps.namespace, this.deps.quota.conflictBatchSize) as {
      id: string; raw_input: string | null; summary: string | null;
    }[];

    let llmCalls = 0;
    let tokensUsed = 0;
    let factCount = 0;
    const now = Date.now();

    for (const mem of candidates) {
      if (!this.deps.budget.canAfford('extractionPerCallTokens')) break;

      const content = mem.summary ?? mem.raw_input ?? '';
      if (!content.trim()) continue;

      if (this.deps.budget.reserve('extractionPerCallTokens')) {
        try {
          const res = await this.deps.llm.chat(
            `${EXTRACTION_SYSTEM_PROMPT}\n\n${buildExtractionUserPrompt(content)}`,
            { temperature: 0.1, maxTokens: 400 },
          );
          llmCalls++;
          tokensUsed += res.tokensUsed;

          const facts = parseExtractionResult(res.content);
          for (const fact of facts) {
            const factId = `fact_${Buffer.from(`${mem.id}_${fact.subject}_${fact.predicate}_${fact.object}`).toString('hex').slice(0, 16)}`;
            this.deps.db.prepare(`
              INSERT OR IGNORE INTO semantic_facts (
                id, domain, subject_uuid, predicate, object_text,
                valid_from, recorded_at, confidence, source_ids
              ) VALUES (?, 'kb', ?, ?, ?, ?, ?, ?, ?)
            `).run(
              factId, fact.subject, fact.predicate, fact.object,
              now, now, fact.confidence, JSON.stringify([mem.id]),
            );
            factCount++;
          }
        } catch {
          // 萃取失败跳过
        }
      }
    }

    ctx.extractedFactCount = factCount;
    return {
      itemsProcessed: factCount,
      llmCalls,
      tokensUsed,
    };
  }
}
