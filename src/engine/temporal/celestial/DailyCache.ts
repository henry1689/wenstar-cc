/**
 * DailyCache — 天象计算当日缓存
 *
 * 以自然日为单位的缓存层，跨零点自动失效。
 * 适用于农历换算、月相、日出日落等每日只需计算一次的耗时运算。
 *
 * 用法：
 *   const cache = new DailyCache();
 *   const result = cache.getOrSet('lunar', () => expensiveCalc());
 */
export class DailyCache {
  private cache = new Map<string, { dateKey: string; value: any }>();

  /** 获取或计算缓存 */
  getOrSet<T>(key: string, compute: () => T, now?: Date): T {
    const dateKey = this.dateKey(now ?? new Date());
    const existing = this.cache.get(key);
    if (existing && existing.dateKey === dateKey) {
      return existing.value as T;
    }
    const value = compute();
    this.cache.set(key, { dateKey, value });
    return value;
  }

  /** 检查指定 key 是否命中当日缓存 */
  has(key: string, now?: Date): boolean {
    const dateKey = this.dateKey(now ?? new Date());
    const existing = this.cache.get(key);
    return !!existing && existing.dateKey === dateKey;
  }

  /** 清除指定 key 的缓存 */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** 清除所有缓存 */
  clear(): void {
    this.cache.clear();
  }

  private dateKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }
}
