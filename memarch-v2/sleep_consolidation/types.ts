/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / types
 *
 * 睡眠巩固统一类型定义
 * 遵循主设计文档第十六章数据模型约定
 */

// ===== 十步流水线步骤枚举 =====
export type SleepStepName =
  | 'scan_pending'           // 步骤1：扫描待处理条目
  | 'seal_episodes'          // 步骤2：事件封口 + gist 生成
  | 'reeval_raw_only'        // 步骤3：RAW_ONLY 复评
  | 'score_salience_llm'     // 步骤4：LLM 精确显著性打分
  | 'build_replay_set'       // 步骤5：优先回放集 + STC 标记
  | 'merge_dedupe'           // 步骤6：合并去重
  | 'extract_semantic'       // 步骤7：语义萃取
  | 'resolve_temporal'       // 步骤8：双时态冲突消解
  | 'promote_lifecycle'      // 步骤9：晋升评估 + 生命周期推进
  | 'purge_tombstones';      // 步骤10：墓碑清理 + 索引维护

export const SLEEP_STEPS: SleepStepName[] = [
  'scan_pending',
  'seal_episodes',
  'reeval_raw_only',
  'score_salience_llm',
  'build_replay_set',
  'merge_dedupe',
  'extract_semantic',
  'resolve_temporal',
  'promote_lifecycle',
  'purge_tombstones',
];

// ===== 生命周期状态 =====
export type LifecycleState =
  | 'fresh'
  | 'weakening'
  | 'expiring'
  | 'consolidated'
  | 'tombstone'
  | 'purged';

// ===== 睡眠运行模式 =====
export type SleepMode = 'main' | 'nap';

// ===== 步骤执行上下文（跨步骤传递） =====
export interface StepContext {
  runId: string;
  mode: SleepMode;
  namespace: string;
  /** 步骤1扫描出的待处理条目 ID 列表 */
  pendingTraceIds: string[];
  /** 步骤2封口的 episode 列表 */
  sealedEpisodes: string[];
  /** 步骤3复评后 RAW_ONLY → WRITE 的 trace_id 列表 */
  reevaluatedTraces: string[];
  /** 步骤4 LLM 打分更新后的 trace_id 列表 */
  llmScoredTraces: string[];
  /** 步骤5构建的回放集 */
  replaySet: string[];
  /** 步骤6合并产生的新 trace_id 列表 */
  mergedTraces: string[];
  /** 步骤7萃取的 semantic_fact 数量 */
  extractedFactCount: number;
  /** 步骤8消解的冲突数量 */
  resolvedConflictCount: number;
  /** 步骤9晋升的条目数量 */
  promotedCount: number;
  /** 步骤10 purge 的条目数量 */
  purgedCount: number;
  /** STC 标记的条目数量 */
  stcMarkedCount: number;
}

// ===== 步骤执行结果 =====
export interface StepResult {
  stepName: SleepStepName;
  status: 'success' | 'skipped' | 'deferred' | 'failed';
  durationMs: number;
  itemsProcessed: number;
  llmCalls: number;
  tokensUsed: number;
  error?: string;
}

// ===== Harness 指标看板数据结构 =====
export interface HarnessMetrics {
  runId: string;
  mode: SleepMode;
  startedAt: number;
  finishedAt?: number;
  totalDurationMs?: number;
  status: 'running' | 'completed' | 'failed' | 'paused';
  currentStep: SleepStepName | null;
  /** 各步骤耗时明细 */
  stepResults: StepResult[];
  /** LLM 预算消耗 */
  llmBudget: {
    usedTokens: number;
    totalBudget: number;
    remainingTokens: number;
    utilizationRatio: number;
    callCounts: Record<string, number>;
  };
  /** purge 数量 */
  purgeCount: number;
  /** 今日累计 purge（跨运行统计） */
  dailyPurgeCount: number;
  /** 断点状态 */
  checkpoint: {
    step: SleepStepName | null;
    resumedFrom: SleepStepName | null;
    isResumed: boolean;
  };
  /** 晋升统计 */
  promotionStats: {
    freshToConsolidated: number;
    weakeningToExpiring: number;
    expiringToTombstone: number;
    tombstoneToPurged: number;
  };
}

// ===== LLM 调用抽象接口 =====
export interface LLMClient {
  chat(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<{
    content: string;
    tokensUsed: number;
  }>;
}

// ===== M2 接口复用：RAW_ONLY 数据源 =====
export interface RawOnlyTrace {
  traceId: string;
  conversationId: number;
  content: string;
  ts_utc: number;
  episodeId?: string;
  salience: number;
  namespace: string;
}
