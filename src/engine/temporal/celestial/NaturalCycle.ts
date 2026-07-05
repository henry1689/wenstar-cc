/**
 * NaturalCycle — 自然周期
 *
 * 日出日落、昼夜长短、二分二至、四季复合时段。
 *
 * 复用 TimeKeeper 的标准时间，提供：
 * - 日出日落近似计算（基于纬度和日期）
 * - 二分二至判定
 * - 寒暑时令区分（暮春/盛夏/晚秋/深冬）
 * - 昼夜长短变化趋势
 */
import type { SunCycle, Season, SubSeason, CelestialConfig } from '../global-types.js';
import { SEASON_LABELS, SUB_SEASON_LABELS } from '../global-types.js';
import { DEFAULT_LATITUDE } from '../TemporalConfig.js';
import { DailyCache } from './DailyCache.js';
import { TimeKeeper } from '../base/TimeKeeper.js';

export class NaturalCycle {
  private timeKeeper: TimeKeeper;
  private latitude: number;
  private cache = new DailyCache();

  constructor(config: CelestialConfig, timeKeeper: TimeKeeper) {
    this.timeKeeper = timeKeeper;
    this.latitude = config.region === 'shexian' ? 29.8 : DEFAULT_LATITUDE;
  }

  async init(): Promise<void> {}
  reset(): void {}
  destroy(): void {}

  /** 计算当日日出日落（带当日缓存） */
  getSunCycle(): SunCycle {
    return this.cache.getOrSet('sunCycle', () => this._calcSunCycle(), this.timeKeeper.now());
  }

  private _calcSunCycle(): SunCycle {
    const now = this.timeKeeper.now();
    const dayOfYear = this.dayOfYear(now);
    // 日出日落角近似计算
    const declination = 23.44 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81));
    const cosHourAngle = -Math.tan(this.latitude * Math.PI / 180) * Math.tan(declination * Math.PI / 180);
    const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosHourAngle)));
    const dayLength = 2 * hourAngle * 180 / Math.PI / 15; // 小时

    const sunrise = 12 - dayLength / 2;
    const sunset = 12 + dayLength / 2;

    return {
      sunriseHour: Math.round(sunrise * 100) / 100,
      sunsetHour: Math.round(sunset * 100) / 100,
      dayLengthHours: Math.round(dayLength * 100) / 100,
    };
  }

  /** 获取当前季节 */
  getSeason(): Season {
    const month = this.timeKeeper.now().getMonth() + 1;
    if (month >= 3 && month <= 5) return 'spring';
    if (month >= 6 && month <= 8) return 'summer';
    if (month >= 9 && month <= 11) return 'autumn';
    return 'winter';
  }

  /** 获取当前细分季节（带当日缓存） */
  getSubSeason(): SubSeason {
    return this.cache.getOrSet('subSeason', () => this._calcSubSeason(), this.timeKeeper.now());
  }

  private _calcSubSeason(): SubSeason {
    const month = this.timeKeeper.now().getMonth() + 1;
    const day = this.timeKeeper.now().getDate();

    // 以节气为划分：立春(2/4)立夏(5/6)立秋(8/7)立冬(11/7)为界
    if (month < 2 || (month === 2 && day < 4)) return 'early_winter';
    if (month === 2 || (month === 3 && day < 6)) return 'early_spring';
    if (month === 3 || month === 4) return 'mid_spring';
    if (month === 5 && day < 6) return 'late_spring';
    if (month === 5 || (month === 6 && day < 6)) return 'early_summer';
    if (month === 6 || month === 7) return 'mid_summer';
    if (month === 8 && day < 7) return 'late_summer';
    if (month === 8 || (month === 9 && day < 8)) return 'early_autumn';
    if (month === 9 || month === 10) return 'mid_autumn';
    if (month === 11 && day < 7) return 'late_autumn';
    if (month === 11 || month === 12) return 'early_winter';
    if (month === 1) return 'mid_winter';
    return 'mid_winter' as SubSeason;
  }

  /** 获取复合时段标签（含季节+时段双重信息） */
  getCompositeTimeLabel(): string {
    const subSeason = this.getSubSeason();
    const hour = this.timeKeeper.now().getHours();
    const timeOfDay = hour < 6 ? '凌晨' : hour < 9 ? '清晨' : hour < 12 ? '上午' :
                      hour < 14 ? '午间' : hour < 18 ? '下午' : hour < 20 ? '傍晚' : hour < 23 ? '夜晚' : '深夜';

    const seasonPart = SUB_SEASON_LABELS[subSeason];
    return `${seasonPart}·${timeOfDay}`;
  }

  /** 昼夜长短变化文案 */
  getDayLengthTrend(): string {
    const sun = this.getSunCycle();
    if (sun.dayLengthHours > 13) return '昼长夜短';
    if (sun.dayLengthHours > 12) return '昼渐长夜渐短';
    if (sun.dayLengthHours > 11) return '昼夜相近';
    if (sun.dayLengthHours > 10) return '夜渐长昼渐短';
    return '昼短夜长';
  }

  /** 今日是否为节气交替日附近的特殊时段 */
  isSolsticeOrEquinox(): string {
    const month = this.timeKeeper.now().getMonth() + 1;
    const day = this.timeKeeper.now().getDate();
    const near = (m: number, d: number, name: string, range: number) => {
      if (month === m && Math.abs(day - d) <= range) return name;
      return null;
    };

    return near(3, 21, '春分', 2) || near(6, 21, '夏至', 2) ||
           near(9, 23, '秋分', 2) || near(12, 22, '冬至', 2) || '';
  }

  /** 北京时间获取日出日落中文描述 */
  getSunDescription(): string {
    const sun = this.getSunCycle();
    const sunriseHour = Math.floor(sun.sunriseHour);
    const sunriseMin = Math.round((sun.sunriseHour - sunriseHour) * 60);
    const sunsetHour = Math.floor(sun.sunsetHour);
    const sunsetMin = Math.round((sun.sunsetHour - sunsetHour) * 60);
    return `日出约${sunriseHour}时${sunriseMin}分，日落约${sunsetHour}时${sunsetMin}分，${this.getDayLengthTrend()}`;
  }

  private dayOfYear(date: Date): number {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date.getTime() - start.getTime()) / 86400000);
  }
}
