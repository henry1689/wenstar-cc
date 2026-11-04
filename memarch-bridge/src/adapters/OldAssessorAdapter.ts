/**
 * OldAssessorAdapter.ts — 旧 vault/MemoryAssessor → 新 M3 SleepConsolidation
 *
 * 【适配关系】
 *   旧：src/app/vault/MemoryAssessor.ts（单条记忆评估/提升）
 *   新：memarch-v2/sleep_consolidation/SleepOrchestrator + PromotionEvaluator
 */

import type Database from 'better-sqlite3';
import { SleepOrchestrator } from '../../../memarch-v2/sleep_consolidation/index.js';
import type {
  MemoryAssessPort,
  MemoryEntry,
  AssessResult,
  SleepRunResult,
} from '../core/MemoryPort.js';
import type { FeatureFlag } from '../core/FeatureFlag.js';

export interface LegacyAssessor {
  assess(entry: MemoryEntry): Promise<AssessResult>;
}

export class OldAssessorAdapter implements MemoryAssessPort {
  private v2Orchestrator: SleepOrchestrator | null = null;

  constructor(
    db: Database.Database,
    private readonly flag: FeatureFlag,
    private readonly legacyAssessor?: LegacyAssessor
  ) {
    // SleepOrchestrator 需要 LLM client 等重依赖，这里延迟构造
    void db;
  }

  async assess(entry: MemoryEntry): Promise<AssessResult> {
    // 单条评估：新旧都走规则版（M3 LLM 评估在睡眠批处理时跑）
    if (this.legacyAssessor && this.flag.route(entry.namespace ?? 'unknown').target === 'legacy') {
      return this.legacyAssessor.assess(entry);
    }
    // 规则版默认评估
    const salience = entry.salience ?? 0.5;
    return {
      salience,
      shouldPromote: salience > 0.7,
      suggestedLifecycle: salience > 0.8 ? 'calcium' : salience > 0.5 ? 'consolidated' : 'fresh',
      reason: 'rule-based default (v2 bridge)',
    };
  }

  async runSleepConsolidation(namespace: string): Promise<SleepRunResult> {
    if (!this.v2Orchestrator) {
      // TODO: 注入真实 LLM client 后再启用
      return { stepsRun: [], tracesPromoted: 0, tracesPurged: 0, durationMs: 0 };
    }
    // 🔴 契约对齐：M3 的入口是 execute()（不是 run()），返回 HarnessMetrics。
    //   字段按真实结构映射，不猜：
    //     stepsRun    ← stepResults 里 success 的 stepName
    //     tracesPromoted ← promotionStats.freshToConsolidated（晋升即 fresh→consolidated）
    //     tracesPurged   ← purgeCount
    //     durationMs     ← totalDurationMs（运行未完成时可能 undefined）
    const result = await this.v2Orchestrator.execute();
    return {
      stepsRun: result.stepResults.filter((s) => s.status === 'success').map((s) => s.stepName),
      tracesPromoted: result.promotionStats.freshToConsolidated,
      tracesPurged: result.purgeCount,
      durationMs: result.totalDurationMs ?? 0,
    };
  }

  async promote(uuid: string, namespace: string, target: 'fresh' | 'consolidated' | 'calcium'): Promise<void> {
    // TODO: 对接 PromotionEvaluator.promote()
    void uuid; void namespace; void target;
  }
}
