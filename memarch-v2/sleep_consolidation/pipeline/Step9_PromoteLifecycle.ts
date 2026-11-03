/**
 * 步骤9：晋升评估 + 生命周期推进
 * 调用 PromotionEvaluator 批量推进所有记忆的生命周期
 */

import type { StepContext } from '../types.js';
import { PromotionEvaluator } from '../lifecycle/index.js';
import { BaseStep, type StepDeps } from './StepBase.js';

export class PromoteLifecycleStep extends BaseStep {
  readonly name = 'promote_lifecycle' as const;
  readonly description = '生命周期晋升评估与状态推进';

  private evaluator: PromotionEvaluator;

  constructor(deps: StepDeps) {
    super(deps);
    this.evaluator = new PromotionEvaluator(deps.db, deps.quota);
  }

  shouldSkipInNap(): boolean { return false; }

  protected async execute(ctx: StepContext): Promise<{ itemsProcessed: number; llmCalls: number; tokensUsed: number }> {
    const result = await this.evaluator.evaluateAll(this.deps.namespace);
    const { applied } = this.evaluator.applyDecisions(result.decisions);

    ctx.promotedCount = result.promotedCount;

    return {
      itemsProcessed: applied,
      llmCalls: 0,
      tokensUsed: 0,
    };
  }
}
