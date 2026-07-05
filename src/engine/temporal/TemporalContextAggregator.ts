/**
 * TemporalContextAggregator — 时空上下文聚合器
 *
 * v2: 仅输出结构化数据（UnifiedTemporalContext），不拼接 Prompt 文案。
 * Prompt 渲染已移至 TemporalPromptRenderer。
 */
import type { CelestialContext, UnifiedTemporalContext } from './global-types.js';
import { MOON_POETIC_MAP } from './TemporalConfig.js';
import { TemporalContextBuilder } from './base/TemporalContext.js';
import { CalendarEngine } from './celestial/CalendarEngine.js';
import { LunarPhaseCalc } from './celestial/LunarPhaseCalc.js';
import { PhenologyTimeline } from './celestial/PhenologyTimeline.js';
import { NaturalCycle } from './celestial/NaturalCycle.js';
import { TimeKeeper } from './base/TimeKeeper.js';
import { SessionTracker } from './base/SessionTracker.js';
import { SOLAR_TERM_LABELS } from './global-types.js';

export class TemporalContextAggregator {
  private baseContext: TemporalContextBuilder;
  private calendar: CalendarEngine;
  private moonCalc: LunarPhaseCalc;
  private phenology: PhenologyTimeline;
  private naturalCycle: NaturalCycle;
  private timeKeeper: TimeKeeper;
  private sessionTracker: SessionTracker;

  constructor(
    timeKeeper: TimeKeeper,
    sessionTracker: SessionTracker,
    calendar: CalendarEngine,
    moonCalc: LunarPhaseCalc,
    phenology: PhenologyTimeline,
    naturalCycle: NaturalCycle,
  ) {
    this.timeKeeper = timeKeeper;
    this.sessionTracker = sessionTracker;
    this.baseContext = new TemporalContextBuilder(timeKeeper, sessionTracker);
    this.calendar = calendar;
    this.moonCalc = moonCalc;
    this.phenology = phenology;
    this.naturalCycle = naturalCycle;
  }

  /**
   * 获取完整结构化时空上下文（纯数据，不含 Prompt 文案）
   */
  getFullContext(): UnifiedTemporalContext {
    const now = this.timeKeeper.now();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const d = now.getDate();

    const moonResult = this.moonCalc.compute();
    const lunar = this.calendar.getCurrentLunar();
    const term = this.calendar.getCurrentTerm();
    const sun = this.naturalCycle.getSunCycle();
    const season = this.naturalCycle.getSeason();
    const subSeason = this.naturalCycle.getSubSeason();
    const phenologyEntry = this.phenology.getCurrent();
    const festivals = this.calendar.getFestivals(y, m, d);

    const celestial: CelestialContext = {
      solarDate: this.timeKeeper.dateString(),
      weekday: this.timeKeeper.weekdayLabel(),
      dayOfYear: this.dayOfYear(now),
      lunarDate: `${lunar.monthName}${lunar.dayName}`,
      lunarYear: lunar.yearName,
      isLeapMonth: lunar.isLeap,
      currentTerm: term.current,
      currentTermLabel: term.currentLabel,
      nextTerm: term.next,
      nextTermLabel: term.nextLabel,
      nextTermDate: term.nextDate,
      moonPhase: moonResult.phase,
      moonPhaseLabel: moonResult.label,
      moonIllumination: moonResult.illumination,
      season,
      seasonLabel: this.seasonToLabel(season),
      subSeason,
      subSeasonLabel: this.subSeasonToLabel(subSeason),
      sunCycle: sun,
      phenology: phenologyEntry.phenology,
      flowers: phenologyEntry.flowers,
      scenes: phenologyEntry.scenes,
    };

    // 只生成纯数据 promptBlock（基础时空+天象，由渲染器接管完整Prompt组装）
    const baseBlock = this.baseContext.buildTimeBlock();
    const celestialBlock = this.buildCelestialDataBlock(celestial, festivals);
    const promptBlock = baseBlock + '\n' + celestialBlock;

    return {
      promptBlock,
      celestial,
      currentTime: this.timeKeeper.fullDateTimeLabel(),
      compositeLabel: this.naturalCycle.getCompositeTimeLabel(),
    };
  }

  /** 生成天象数据块（仅结构化描述，无渲染文案） */
  private buildCelestialDataBlock(ctx: CelestialContext, festivals: string[]): string {
    const parts: string[] = ['【天象】'];
    parts.push(`农历${ctx.lunarYear} ${ctx.lunarDate}`);
    if (ctx.currentTermLabel) {
      parts.push(`节气：${ctx.currentTermLabel}（下一个：${ctx.nextTermLabel} ${ctx.nextTermDate}）`);
    }
    const moonPoetic = this.getMoonPoetic(ctx.moonPhase);
    parts.push(`月相：${ctx.moonPhaseLabel} ${moonPoetic}`);
    parts.push(`天时：${this.naturalCycle.getSunDescription()}`);
    parts.push(`物候：${ctx.phenology.join('，')}`);
    if (ctx.flowers.length) parts.push(`当季：${ctx.flowers.join('、')}正盛`);
    parts.push(`氛围：${this.naturalCycle.getCompositeTimeLabel()}`);
    if (festivals.length) parts.push(`节日：${festivals.join('、')}`);
    return parts.join(' | ');
  }

  private getMoonPoetic(phase: string): string {
    return MOON_POETIC_MAP[phase] || '';
  }

  private seasonToLabel(s: string): string {
    const map: Record<string, string> = { spring:'春季', summer:'夏季', autumn:'秋季', winter:'冬季' };
    return map[s] ?? '';
  }

  private subSeasonToLabel(s: string): string {
    const map: Record<string, string> = {
      early_spring:'初春', mid_spring:'仲春', late_spring:'暮春',
      early_summer:'初夏', mid_summer:'仲夏', late_summer:'盛夏',
      early_autumn:'初秋', mid_autumn:'仲秋', late_autumn:'晚秋',
      early_winter:'初冬', mid_winter:'仲冬', late_winter:'深冬',
    };
    return map[s] ?? '';
  }

  private dayOfYear(date: Date): number {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date.getTime() - start.getTime()) / 86400000);
  }
}
