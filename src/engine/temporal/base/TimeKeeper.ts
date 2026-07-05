/**
 * TimeKeeper — 全局时钟 · 时间基准
 *
 * 🔴 铁律：全系统唯一允许的 Date.now() / new Date() 调用点。
 *    禁止各业务模块自行调用，规避跨零点日期判断不一致 bug。
 *
 * v2: 移除所有硬编码，从 TemporalConfig 读取时段边界。
 */
import type { IStorageProvider } from '../../types.js';
import type { TimePeriod, TemporalConfig } from '../global-types.js';
import { PERIOD_CONFIG, WEEKDAY_LABELS } from '../TemporalConfig.js';

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

  constructor(config: TemporalConfig) {
    this.storage = config.storage;
    this.userOffset = config.userActiveOffset ?? 0;
    this.dndStart = config.doNotDisturbStart ?? PERIOD_CONFIG.dndStart;
    this.dndEnd = config.doNotDisturbEnd ?? PERIOD_CONFIG.dndEnd;
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

  /** 获取当前时间戳 */
  now(): Date {
    return new Date();
  }

  timestamp(): number {
    return Date.now();
  }

  /** 获取当前标准日期 YYYY-MM-DD */
  dateString(): string {
    const d = this.now();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 获取当前时段（纯数据，无文案） */
  period(): TimePeriod {
    const hour = this.now().getHours();
    const { boundaries } = PERIOD_CONFIG;
    for (let i = boundaries.length - 1; i >= 0; i--) {
      if (hour >= boundaries[i][0]) {
        return boundaries[i][1];
      }
    }
    return 'dawn';
  }

  /** 获取时段中文标签（纯数据，供渲染层使用） */
  periodLabel(): string {
    const hour = this.now().getHours();
    const { boundaries } = PERIOD_CONFIG;
    for (let i = boundaries.length - 1; i >= 0; i--) {
      if (hour >= boundaries[i][0]) {
        return boundaries[i][2];
      }
    }
    return '凌晨';
  }

  /** 星期标签 */
  weekdayLabel(): string {
    return WEEKDAY_LABELS[this.now().getDay()];
  }

  /** 完整时间字符串 */
  fullDateTimeLabel(): string {
    const d = this.now();
    const Y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const D = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const w = WEEKDAY_LABELS[d.getDay()];
    return `${Y}-${M}-${D} ${w} ${h}:${m}:${s}`;
  }

  /** 检测是否跨零点 */
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
