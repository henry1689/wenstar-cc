/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / pipeline/SleepOrchestrator
 *
 * 十步睡眠流水线编排器
 * 功能：
 *   - 断点续跑（从 sleep_runs 表恢复）
 *   - 幂等执行（已完成步骤跳过）
 *   - 小睡 / 主睡眠模式切换
 *   - Harness 指标看板输出
 *
 * 验收标准：
 *   - 主睡眠 ≤ 30 分钟（万级条目）
 *   - 小睡 ≤ 5 分钟
 *   - 断点续跑：步骤5中断后重启从步骤5继续
 *   - 幂等：同一步骤执行两次数据不重复
 *   - MEMORY_FORGET_ENABLED=0 时遗忘只计算不执行
 *   - 每日 purge 达 500 条自动停止
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type {
  StepContext, StepResult, SleepStepName, SleepMode, HarnessMetrics, LLMClient,
} from '../types.js';
import { SLEEP_STEPS } from '../types.js';
import type { SleepConfig } from '../config/index.js';
import { BudgetTracker } from '../config/budget.js';
import { CheckpointStore, type CheckpointData } from '../checkpoint/CheckpointStore.js';
import { BaseStep, type StepDeps } from './StepBase.js';

import { ScanPendingStep } from './Step1_ScanPending.js';
import { SealEpisodesStep } from './Step2_SealEpisodes.js';
import { ReevalRawOnlyStep } from './Step3_ReevalRawOnly.js';
import { ScoreSalienceLLMStep } from './Step4_ScoreSalienceLLM.js';
import { BuildReplaySetStep } from './Step5_BuildReplaySet.js';
import { MergeDedupeStep } from './Step6_MergeDedupe.js';
import { ExtractSemanticStep } from './Step7_ExtractSemantic.js';
import { ResolveTemporalStep } from './Step8_ResolveTemporal.js';
import { PromoteLifecycleStep } from './Step9_PromoteLifecycle.js';
import { PurgeTombstonesStep } from './Step10_PurgeTombstones.js';

export class SleepOrchestrator {
  private readonly steps: BaseStep[];
  private readonly checkpoint: CheckpointStore;
  private readonly db: Database.Database;
  private readonly config: SleepConfig;
  private llm: LLMClient | null = null;

  constructor(db: Database.Database, config: SleepConfig) {
    this.db = db;
    this.config = config;
    this.checkpoint = new CheckpointStore(db, config.namespace);

    // 构建依赖
    const budget = new BudgetTracker(config.budget, 'main');
    const deps: StepDeps = {
      db,
      llm: null, // 由 setLLM 注入
      budget,
      quota: config.quota,
      flags: config.flags,
      namespace: config.namespace,
    };

    this.steps = [
      new ScanPendingStep(deps),
      new SealEpisodesStep(deps),
      new ReevalRawOnlyStep(deps),
      new ScoreSalienceLLMStep(deps),
      new BuildReplaySetStep(deps),
      new MergeDedupeStep(deps),
      new ExtractSemanticStep(deps),
      new ResolveTemporalStep(deps),
      new PromoteLifecycleStep(deps),
      new PurgeTombstonesStep(deps),
    ];
  }

  /** 注入 LLM 客户端 */
  setLLM(llm: LLMClient): void {
    this.llm = llm;
    for (const step of this.steps) {
      (step as unknown as { deps: StepDeps }).deps.llm = llm;
    }
  }

  /**
   * 执行完整睡眠流水线
   * @param mode 主睡眠 / 小睡
   * @param resume 是否尝试断点续跑
   */
  async execute(mode: SleepMode = 'main', resume = true): Promise<HarnessMetrics> {
    const runStart = Date.now();
    let checkpoint: CheckpointData;
    let isResumed = false;
    let resumedFrom: SleepStepName | null = null;

    // 尝试恢复断点
    if (resume) {
      const existing = this.checkpoint.findResumableRun();
      if (existing) {
        checkpoint = existing;
        isResumed = true;
        resumedFrom = this.checkpoint.getNextStep(checkpoint);
      } else {
        checkpoint = this.checkpoint.createRun(randomUUID(), mode);
      }
    } else {
      checkpoint = this.checkpoint.createRun(randomUUID(), mode);
    }

    const ctx: StepContext = {
      runId: checkpoint.runId,
      mode,
      namespace: this.config.namespace,
      pendingTraceIds: checkpoint.context.pendingTraceIds ?? [],
      sealedEpisodes: checkpoint.context.sealedEpisodes ?? [],
      reevaluatedTraces: checkpoint.context.reevaluatedTraces ?? [],
      llmScoredTraces: checkpoint.context.llmScoredTraces ?? [],
      replaySet: checkpoint.context.replaySet ?? [],
      mergedTraces: checkpoint.context.mergedTraces ?? [],
      extractedFactCount: checkpoint.context.extractedFactCount ?? 0,
      resolvedConflictCount: checkpoint.context.resolvedConflictCount ?? 0,
      promotedCount: checkpoint.context.promotedCount ?? 0,
      purgedCount: checkpoint.context.purgedCount ?? 0,
      stcMarkedCount: checkpoint.context.stcMarkedCount ?? 0,
    };

    // 超时控制
    const timeoutMin = mode === 'main' ? this.config.quota.mainSleepTimeoutMin : this.config.quota.napTimeoutMin;
    const timeoutMs = timeoutMin * 60 * 1000;
    const timeoutHandle = setTimeout(() => {
      this.checkpoint.markPaused(checkpoint);
      throw new Error(`Sleep timeout after ${timeoutMin}min`);
    }, timeoutMs);

    try {
      // 逐步执行
      while (true) {
        const nextStep = this.checkpoint.getNextStep(checkpoint);
        if (!nextStep) break;

        // 小睡模式：跳过标记为 shouldSkipInNap 的步骤
        const step = this.steps.find(s => s.name === nextStep)!;
        if (mode === 'nap' && step.shouldSkipInNap()) {
          // 小睡模式下直接标记为 skipped，不落 checkpoint 跳过逻辑
          const skipResult: StepResult = {
            stepName: nextStep,
            status: 'skipped',
            durationMs: 0,
            itemsProcessed: 0,
            llmCalls: 0,
            tokensUsed: 0,
          };
          this.checkpoint.markStepComplete(checkpoint, skipResult);
          continue;
        }

        // 幂等检查：已完成的步骤跳过
        if (this.checkpoint.isStepCompleted(checkpoint, nextStep)) {
          continue;
        }

        this.checkpoint.markStepStart(checkpoint, nextStep);
        const result = await step.run(ctx);

        if (result.status === 'failed') {
          this.checkpoint.markFailed(checkpoint, result.error ?? 'unknown');
          break;
        }

        // 更新上下文
        this.checkpoint.updateContext(checkpoint, {
          pendingTraceIds: ctx.pendingTraceIds,
          sealedEpisodes: ctx.sealedEpisodes,
          reevaluatedTraces: ctx.reevaluatedTraces,
          llmScoredTraces: ctx.llmScoredTraces,
          replaySet: ctx.replaySet,
          mergedTraces: ctx.mergedTraces,
          extractedFactCount: ctx.extractedFactCount,
          resolvedConflictCount: ctx.resolvedConflictCount,
          promotedCount: ctx.promotedCount,
          purgedCount: ctx.purgedCount,
          stcMarkedCount: ctx.stcMarkedCount,
        });

        this.checkpoint.markStepComplete(checkpoint, result);
      }

      this.checkpoint.markCompleted(checkpoint);
    } finally {
      clearTimeout(timeoutHandle);
    }

    // 构建 Harness 指标看板
    return this.buildMetrics(checkpoint, runStart, isResumed, resumedFrom);
  }

  /** 构建 Harness 指标看板数据结构 */
  private buildMetrics(
    checkpoint: CheckpointData,
    startedAt: number,
    isResumed: boolean,
    resumedFrom: SleepStepName | null,
  ): HarnessMetrics {
    const finishedAt = Date.now();
    const budgetTracker = new BudgetTracker(this.config.budget, checkpoint.context.mode === 'main' ? 'main' : 'nap');
    const budgetSnapshot = budgetTracker.snapshot();

    // 统计各步骤 LLM 调用与 token 消耗
    let totalLlmCalls = 0;
    let totalTokens = 0;
    for (const r of checkpoint.stepResults) {
      totalLlmCalls += r.llmCalls;
      totalTokens += r.tokensUsed;
    }

    // 今日 purge 计数
    const todayStart = new Date().toISOString().slice(0, 10);
    const dailyPurge = (this.db.prepare(`
      SELECT COUNT(*) as cnt FROM tombstones
      WHERE reason = 'decay' AND date(deleted_at / 1000, 'unixepoch') = ?
    `).get(todayStart) as { cnt: number }).cnt;

    return {
      runId: checkpoint.runId,
      mode: checkpoint.context.mode ?? 'main',
      startedAt,
      finishedAt,
      totalDurationMs: finishedAt - startedAt,
      status: checkpoint.status === 'completed' ? 'completed' : checkpoint.status,
      currentStep: checkpoint.currentStep,
      stepResults: checkpoint.stepResults,
      llmBudget: {
        usedTokens: totalTokens,
        totalBudget: budgetSnapshot.totalBudget,
        remainingTokens: budgetSnapshot.totalBudget - totalTokens,
        utilizationRatio: +(totalTokens / budgetSnapshot.totalBudget).toFixed(4),
        callCounts: { total: totalLlmCalls },
      },
      purgeCount: checkpoint.context.purgedCount ?? 0,
      dailyPurgeCount: dailyPurge,
      checkpoint: {
        step: checkpoint.currentStep,
        resumedFrom,
        isResumed,
      },
      promotionStats: {
        freshToConsolidated: 0,
        weakeningToExpiring: 0,
        expiringToTombstone: 0,
        tombstoneToPurged: checkpoint.context.purgedCount ?? 0,
      },
    };
  }
}
