/**
 * TimeKeeper — 全局时钟 · 时间基准
 *
 * 🔴 铁律：所有行程、订票、日期计算逻辑强制依赖此模块输出的标准日期对象，
 *    禁止各业务模块自行调用 Date.now() 或 new Date()，规避跨零点日期判断不一致 bug。
 */
import type { IStorageProvider } from '../../types.js';
import type { TimePeriod, TemporalConfig } from './base-types.js';

const STORAGE_KEY = 'temporal_timekeeper';

interface TimeKeeperSnapshot {
  lastDate: string;
  lastTimestamp: number;
  timeJumpCount: number;
}

export class TimeKeeper {
  private storage: IStorageProvider;
  private snapshot: TimeKeeperSnapshot;
  private userOffset: number;
  private dndStart: number;
  private dndEnd: number;
  private initialized = false;

  private static readonly PERIOD_BOUNDARIES: [number, TimePeriod, string][] = [
    [0,  'dawn',     '凌晨'],
    [6,  'morning',  '早晨'],
    [9,  'midday',   '上午'],
    [12, 'afternoon','下午'],
    [18, 'evening',  '傍晚'],
    [20, 'night',    '晚上'],
    [23, 'midnight', '深夜'],
  ];

  private static readonly WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  constructor(config: TemporalConfig) {
    this.storage = config.storage;
    this.userOffset = config.userActiveOffset ?? 0;
    this.dndStart = config.doNotDisturbStart ?? 23;
    this.dndEnd = config.doNotDisturbEnd ?? 7;
    this.snapshot = { lastDate: '', lastTimestamp: 0, timeJumpCount: 0 };
  }

  async init(): Promise<void> {
    try {
      const saved = await this.storage.get<TimeKeeperSnapshot>(STORAGE_KEY);
      if (saved) {
        this.snapshot = saved;
        const jump = Date.now() - this.snapshot.lastTimestamp;
        if (Math.abs(jump) > 3000) {
          this.snapshot.timeJumpCount++;
          console.warn(`[TimeKeeper] 检测到系统时间跳变: ${Math.abs(jump)}ms`);
        }
      }
    } catch (e: any) { console.error('[TimeKeeper] error:', e?.message); }
    this.initialized = true;
    this.persist();
  }

  reset(): void {
    this.snapshot = { lastDate: '', lastTimestamp: 0, timeJumpCount: 0 };
  }

  destroy(): void {
    this.persist();
  }

  /** 获取当前时间戳（全系统唯一允许的时间获取） */
  now(): Date {
    return new Date();
  }

  timestamp(): number {
    return Date.now();
  }

  /** 获取当前标准日期 YYYY-MM-DD（基于上海时区） */
  dateString(): string {
    const d = this.now();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 获取当前时段 */
  period(): TimePeriod {
    const hour = this.now().getHours();
    for (let i = TimeKeeper.PERIOD_BOUNDARIES.length - 1; i >= 0; i--) {
      if (hour >= TimeKeeper.PERIOD_BOUNDARIES[i][0]) {
        return TimeKeeper.PERIOD_BOUNDARIES[i][1];
      }
    }
    return 'dawn';
  }

  /** 获取时段中文标签 */
  periodLabel(): string {
    const hour = this.now().getHours();
    for (let i = TimeKeeper.PERIOD_BOUNDARIES.length - 1; i >= 0; i--) {
      if (hour >= TimeKeeper.PERIOD_BOUNDARIES[i][0]) {
        return TimeKeeper.PERIOD_BOUNDARIES[i][2];
      }
    }
    return '凌晨';
  }

  /** 星期标签（基于本地日期） */
  weekdayLabel(): string {
    return TimeKeeper.WEEKDAYS[this.now().getDay()];
  }

  /** 完整时间字符串（含日期时间） */
  fullDateTimeLabel(): string {
    const d = this.now();
    const Y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const D = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const w = TimeKeeper.WEEKDAYS[d.getDay()];
    return `${Y}-${M}-${D} ${w} ${h}:${m}:${s}`;
  }

  /** 检测是否跨零点（日期变更） */
  didCrossMidnight(): boolean {
    const today = this.dateString();
    if (this.snapshot.lastDate && this.snapshot.lastDate !== today) {
      this.snapshot.lastDate = today;
      this.persist();
      return true;
    }
    if (!this.snapshot.lastDate) {
      this.snapshot.lastDate = today;
      this.persist();
    }
    return false;
  }

  /** 当前是否为免打扰时段 */
  isDoNotDisturb(): boolean {
    const hour = this.now().getHours();
    if (this.dndStart <= this.dndEnd) {
      return hour >= this.dndStart && hour < this.dndEnd;
    }
    return hour >= this.dndStart || hour < this.dndEnd;
  }

  /** 计算距指定时间（24小时制）的剩余毫秒 */
  msUntil(targetHour: number, targetMinute: number): number {
    const now = this.now();
    const target = new Date(now);
    target.setHours(targetHour, targetMinute, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime() - now.getTime();
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.set(STORAGE_KEY, this.snapshot);
    } catch (e: any) { console.error('[TimeKeeper] error:', e?.message); }
  }
}
