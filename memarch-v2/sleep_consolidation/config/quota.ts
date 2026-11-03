/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / config/quota
 *
 * 配额配置：purge 数量、生命周期推进速率、合并批次大小等
 */

export interface SleepQuota {
  /** 每日最大 purge 条数（达到后自动停止物理删除） */
  dailyPurgeLimit: number;
  /** 单次睡眠最大处理的 fresh 条目数 */
  maxFreshPerCycle: number;
  /** 单次睡眠最大封口的 open episode 数 */
  maxEpisodeSealPerCycle: number;
  /** 单次睡眠最大 RAW_ONLY 复评条数 */
  maxRawReevalPerCycle: number;
  /** 单次睡眠最大 LLM 显著性打分条数 */
  maxLLMSaliencePerCycle: number;
  /** 合并去重的批次大小 */
  mergeBatchSize: number;
  /** 双时态事实冲突消解的批次大小 */
  conflictBatchSize: number;
  /** 小睡模式：只跑这些步骤 */
  napSteps: string[];
  /** 主睡眠超时（分钟） */
  mainSleepTimeoutMin: number;
  /** 小睡超时（分钟） */
  napTimeoutMin: number;
}

export const DEFAULT_QUOTA: SleepQuota = {
  dailyPurgeLimit: 500,           // 验收标准：每日 purge 达 500 条自动停止
  maxFreshPerCycle: 10_000,       // 万级条目处理能力
  maxEpisodeSealPerCycle: 2_000,
  maxRawReevalPerCycle: 3_000,
  maxLLMSaliencePerCycle: 2_000,
  mergeBatchSize: 200,
  conflictBatchSize: 100,
  napSteps: ['scan', 'promote', 'tombstone_scan'],  // 小睡只跑轻量步骤
  mainSleepTimeoutMin: 30,        // 验收标准：主睡眠 ≤ 30 分钟
  napTimeoutMin: 5,               // 验收标准：小睡 ≤ 5 分钟
};
