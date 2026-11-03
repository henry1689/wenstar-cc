/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / config/index
 *
 * 配置统一出口
 */

export type { FeatureFlags } from './flags.js';
export { loadFlags } from './flags.js';
export type { LLMBudget, LLMBudgetSnapshot } from './budget.js';
export { DEFAULT_BUDGET, BudgetTracker } from './budget.js';
export type { SleepQuota } from './quota.js';
export { DEFAULT_QUOTA } from './quota.js';

import { loadFlags, type FeatureFlags } from './flags.js';
import { DEFAULT_BUDGET, type LLMBudget } from './budget.js';
import { DEFAULT_QUOTA, type SleepQuota } from './quota.js';

export interface SleepConfig {
  flags: FeatureFlags;
  budget: LLMBudget;
  quota: SleepQuota;
  /** SQLite 数据库文件路径 */
  dbPath: string;
  /** namespace 隔离 */
  namespace: string;
}

export function loadSleepConfig(env: NodeJS.ProcessEnv = process.env): SleepConfig {
  return {
    flags: loadFlags(env),
    budget: { ...DEFAULT_BUDGET },
    quota: { ...DEFAULT_QUOTA },
    dbPath: env.MEMARCH_DB_PATH ?? './data/memarch-v2.db',
    namespace: env.MEMARCH_NAMESPACE ?? 'default',
  };
}
