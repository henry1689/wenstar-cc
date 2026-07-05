/**
 * LunarPhaseCalc — 月相计算器
 *
 * 基于天文算法，输入时间戳输出月相状态。
 * 月球朔望周期（synodic month）≈ 29.530587 天。
 *
 * v2: 天文常数从 TemporalConfig 读取。
 */
import type { MoonPhase } from '../global-types.js';
import { MOON_PHASE_LABELS } from '../global-types.js';
import { ASTRONOMY } from '../TemporalConfig.js';
import { DailyCache } from './DailyCache.js';
import { TimeKeeper } from '../base/TimeKeeper.js';

export class LunarPhaseCalc {
  private timeKeeper: TimeKeeper;
  private cache = new DailyCache();

  constructor(timeKeeper: TimeKeeper) {
    this.timeKeeper = timeKeeper;
  }

  async init(): Promise<void> {}
  reset(): void {}
  destroy(): void {}

  /** 计算当前月相（带当日缓存） */
  compute(): { phase: MoonPhase; label: string; illumination: number; fullMoonStart?: Date; fullMoonEnd?: Date } {
    return this.cache.getOrSet('moonPhase', () => {
      return this.computeForDate(this.timeKeeper.now());
    }, this.timeKeeper.now());
  }

  /** 计算指定日期的月相 */
  computeForDate(date: Date): { phase: MoonPhase; label: string; illumination: number; fullMoonStart?: Date; fullMoonEnd?: Date } {
    const jde = this.gregorianToJDE(date);
    const daysSinceNewMoon = jde - ASTRONOMY.KNOWN_NEW_MOON_JDE;
    const cycles = daysSinceNewMoon / ASTRONOMY.SYNODIC_MONTH;
    const phase = cycles - Math.floor(cycles);

    return this.phaseToResult(phase, date);
  }

  /** 获取当前月相中文雅称 */
  getPoeticName(): string {
    const { phase } = this.compute();
    switch (phase) {
      case 'new_moon': return '朔月·不见月';
      case 'waxing_crescent': return '蛾眉·初月如钩';
      case 'first_quarter': return '上弦·半月悬空';
      case 'waxing_gibbous': return '盈凸·月渐丰盈';
      case 'full_moon': return '满月·月华如水';
      case 'waning_gibbous': return '亏凸·月始消瘦';
      case 'last_quarter': return '下弦·残月西沉';
      case 'waning_crescent': return '残月·一弯寒钩';
    }
  }

  /** 是否为满月周期 */
  isFullMoonWindow(): boolean {
    return this.compute().phase === 'full_moon';
  }

  // ── 内部方法 ──

  private gregorianToJDE(date: Date): number {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate() +
      date.getUTCHours() / 24 +
      date.getUTCMinutes() / 1440 +
      date.getUTCSeconds() / 86400;
    let year = y;
    let month = m;
    if (month <= 2) { year--; month += 12; }
    const A = Math.floor(year / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + d + B - 1524.5;
  }

  private phaseToResult(phase: number, date: Date): {
    phase: MoonPhase; label: string; illumination: number;
    fullMoonStart?: Date; fullMoonEnd?: Date;
  } {
    let moonPhase: MoonPhase;
    let illumination: number;

    if (phase < 0.03 || phase >= 0.97) {
      moonPhase = 'new_moon'; illumination = 0;
    } else if (phase < 0.15) {
      moonPhase = 'waxing_crescent'; illumination = (phase - 0.03) / 0.12;
    } else if (phase < 0.28) {
      moonPhase = 'first_quarter'; illumination = 0.25 + (phase - 0.15) * 1.5;
    } else if (phase < 0.4) {
      moonPhase = 'waxing_gibbous'; illumination = 0.45 + (phase - 0.28) * 2;
    } else if (phase < 0.53) {
      moonPhase = 'full_moon'; illumination = 0.85 + (1 - Math.abs(phase - 0.5) * 10);
      if (illumination > 1) illumination = 1;
    } else if (phase < 0.65) {
      moonPhase = 'waning_gibbous'; illumination = 0.85 - (phase - 0.53) * 2;
    } else if (phase < 0.78) {
      moonPhase = 'last_quarter'; illumination = 0.55 - (phase - 0.65) * 1.5;
    } else {
      moonPhase = 'waning_crescent'; illumination = 0.25 * (1 - (phase - 0.78) / 0.19);
    }

    const result: any = {
      phase: moonPhase,
      label: MOON_PHASE_LABELS[moonPhase],
      illumination: Math.round(Math.max(0, Math.min(1, illumination)) * 100) / 100,
    };

    if (moonPhase === 'full_moon') {
      const jde = this.gregorianToJDE(date);
      const nearestNewMoon = Math.round((jde - ASTRONOMY.KNOWN_NEW_MOON_JDE) / ASTRONOMY.SYNODIC_MONTH);
      const fullMoonJDE = ASTRONOMY.KNOWN_NEW_MOON_JDE + (nearestNewMoon + 0.5) * ASTRONOMY.SYNODIC_MONTH;
      const fullMoonDate = this.jdeToGregorian(fullMoonJDE);
      result.fullMoonStart = new Date(fullMoonDate.getTime() - 12 * 3600000);
      result.fullMoonEnd = new Date(fullMoonDate.getTime() + 12 * 3600000);
    }

    return result;
  }

  private jdeToGregorian(jde: number): Date {
    const timeMs = (jde - 2440588) * 86400000;
    return new Date(timeMs);
  }
}
