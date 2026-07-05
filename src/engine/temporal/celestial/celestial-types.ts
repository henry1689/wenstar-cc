/**
 * celestial-types.ts — 天象层类型
 *
 * 所有类型已合并到 global-types.ts，此文件仅做 re-export。
 */
export type {
  MoonPhase, SolarTerm, Season, SubSeason,
  StemBranch, PhenologyEntry, SunCycle,
  CelestialContext, CelestialConfig,
} from '../global-types.js';

export {
  MOON_PHASE_LABELS, SOLAR_TERM_LABELS,
  SEASON_LABELS, SUB_SEASON_LABELS,
} from '../global-types.js';
