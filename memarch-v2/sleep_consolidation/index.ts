/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / index
 *
 * 对外统一出口
 */

export { SleepOrchestrator } from './pipeline/index.js';
export { CheckpointStore } from './checkpoint/CheckpointStore.js';
export { LifecycleStateMachine, PromotionEvaluator } from './lifecycle/index.js';
export { loadSleepConfig, type SleepConfig } from './config/index.js';
export type {
  SleepStepName,
  StepContext,
  StepResult,
  HarnessMetrics,
  SleepMode,
  LLMClient,
  RawOnlyTrace,
} from './types.js';

export { SLEEP_STEPS } from './types.js';
