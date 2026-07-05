/**
 * types.ts — Temporal 模块统一导出入口
 *
 * 所有类型已合并到 global-types.ts，此文件仅做 re-export。
 */
export type {
  TimePeriod, SessionState, FarewellLevel,
  TimerTaskStatus, TimerTriggerType,
  TemporalContextBlock, TimerTask, TemporalConfig, FarewellRule,
  MoonPhase, SolarTerm, Season, SubSeason,
  StemBranch, PhenologyEntry, SunCycle,
  CelestialContext, CelestialConfig,
  UnifiedTemporalContext,
  IDurationConfig, IPeriodConfig, IPromptConfig,
} from './global-types.js';

export {
  MOON_PHASE_LABELS, SOLAR_TERM_LABELS,
  SEASON_LABELS, SUB_SEASON_LABELS,
} from './global-types.js';
