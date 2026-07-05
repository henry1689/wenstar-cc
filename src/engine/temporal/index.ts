/**
 * 时空感知层 - 统一导出入口
 *
 * 外部只需：
 *   import { TimeKeeper, CalendarEngine, TemporalGovernor } from '../temporal/index.js';
 *
 * v2: 新增 createTemporalSystem() 工厂函数统一实例化所有子模块。
 */
// ── 子模块 ──
export { TimeKeeper } from './base/TimeKeeper.js';
export { TimerRegistry } from './base/TimerRegistry.js';
export { SessionTracker } from './base/SessionTracker.js';
export { TemporalContextBuilder } from './base/TemporalContext.js';
export { CalendarEngine } from './celestial/CalendarEngine.js';
export { LunarPhaseCalc } from './celestial/LunarPhaseCalc.js';
export { PhenologyTimeline } from './celestial/PhenologyTimeline.js';
export { NaturalCycle } from './celestial/NaturalCycle.js';
export { TemporalPromptRenderer } from './TemporalPromptRenderer.js';
export { TemporalContextAggregator } from './TemporalContextAggregator.js';
export { TemporalGovernor } from './TemporalGovernor.js';
export type { TemporalContextOutput } from './TemporalGovernor.js';

// ── 配置 ──
export * from './TemporalConfig.js';

// ── 类型 ──
export type {
  TimePeriod, SessionState, FarewellLevel,
  TimerTaskStatus, TimerTriggerType,
  TemporalContextBlock, TimerTask, TemporalConfig, FarewellRule,
  MoonPhase, SolarTerm, Season, SubSeason,
  StemBranch, PhenologyEntry, SunCycle,
  CelestialContext, CelestialConfig,
  UnifiedTemporalContext,
} from './global-types.js';

export {
  MOON_PHASE_LABELS, SOLAR_TERM_LABELS,
  SEASON_LABELS, SUB_SEASON_LABELS,
} from './global-types.js';

// ── 工厂函数 ──
import type { TemporalConfig as TTemporalConfig, CelestialConfig as TCelestialConfig } from './global-types.js';
import { TimeKeeper as TTimeKeeper } from './base/TimeKeeper.js';
import { SessionTracker as TSessionTracker } from './base/SessionTracker.js';
import { TimerRegistry as TTimerRegistry } from './base/TimerRegistry.js';
import { TemporalContextAggregator as TTemporalContextAggregator } from './TemporalContextAggregator.js';
import { TemporalGovernor as TTemporalGovernor } from './TemporalGovernor.js';
import { CalendarEngine as TCalendarEngine } from './celestial/CalendarEngine.js';
import { LunarPhaseCalc as TLunarPhaseCalc } from './celestial/LunarPhaseCalc.js';
import { PhenologyTimeline as TPhenologyTimeline } from './celestial/PhenologyTimeline.js';
import { NaturalCycle as TNaturalCycle } from './celestial/NaturalCycle.js';

/** 一键创建完整 Temporal 系统 */
export function createTemporalSystem(
  temporalConfig: TTemporalConfig,
  celestialConfig?: TCelestialConfig,
): {
  timeKeeper: TTimeKeeper;
  sessionTracker: TSessionTracker;
  timerRegistry: TTimerRegistry;
  calendarEngine: TCalendarEngine;
  lunarPhaseCalc: TLunarPhaseCalc;
  phenologyTimeline: TPhenologyTimeline;
  naturalCycle: TNaturalCycle;
  aggregator: TTemporalContextAggregator;
  governor: TTemporalGovernor;
} {
  const timeKeeper = new TTimeKeeper(temporalConfig);
  const sessionTracker = new TSessionTracker(temporalConfig);
  const timerRegistry = new TTimerRegistry(temporalConfig, timeKeeper);
  const calendarEngine = new TCalendarEngine(celestialConfig ?? { storage: temporalConfig.storage }, timeKeeper);
  const lunarPhaseCalc = new TLunarPhaseCalc(timeKeeper);
  const phenologyTimeline = new TPhenologyTimeline(celestialConfig ?? { storage: temporalConfig.storage }, timeKeeper);
  const naturalCycle = new TNaturalCycle(celestialConfig ?? { storage: temporalConfig.storage }, timeKeeper);
  const aggregator = new TTemporalContextAggregator(
    timeKeeper, sessionTracker,
    calendarEngine, lunarPhaseCalc,
    phenologyTimeline, naturalCycle,
  );
  const governor = new TTemporalGovernor(timeKeeper, sessionTracker, aggregator, timerRegistry);

  return {
    timeKeeper, sessionTracker, timerRegistry,
    calendarEngine, lunarPhaseCalc, phenologyTimeline, naturalCycle,
    aggregator, governor,
  };
}
