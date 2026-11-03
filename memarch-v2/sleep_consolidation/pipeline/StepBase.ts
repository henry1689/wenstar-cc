/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / pipeline/StepBase
 *
 * 所有流水线步骤的抽象基类
 * 统一：耗时统计、LLM 预算检查、幂等性保护
 */

import type Database from 'better-sqlite3';
import type { StepContext, StepResult, SleepStepName, LLMClient } from '../types.js';
import type { BudgetTracker } from '../config/budget.js';
import type { SleepQuota } from '../config/quota.js';
import type { FeatureFlags } from '../config/flags.js';

export interface StepDeps {
  db: Database.Database;
  llm: LLMClient | null;
  budget: BudgetTracker;
  quota: SleepQuota;
  flags: FeatureFlags;
  namespace: string;
}

export abstract class BaseStep {
  abstract readonly name: SleepStepName;
  abstract readonly description: string;

  constructor(protected deps: StepDeps) {}

  /** 执行步骤（模板方法：计时 + 结果包装） */
  async run(ctx: StepContext): Promise<StepResult> {
    const start = Date.now();
    try {
      const { itemsProcessed, llmCalls, tokensUsed } = await this.execute(ctx);
      return {
        stepName: this.name,
        status: 'success',
        durationMs: Date.now() - start,
        itemsProcessed,
        llmCalls,
        tokensUsed,
      };
    } catch (err) {
      return {
        stepName: this.name,
        status: 'failed',
        durationMs: Date.now() - start,
        itemsProcessed: 0,
        llmCalls: 0,
        tokensUsed: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 子类实现具体逻辑 */
  protected abstract execute(ctx: StepContext): Promise<{
    itemsProcessed: number;
    llmCalls: number;
    tokensUsed: number;
  }>;

  /** 小睡模式下是否跳过此步骤 */
  abstract shouldSkipInNap(): boolean;
}
