/**
 * PhenologyTimeline — 四季物候时间线
 *
 * v2: 物候数据已抽离到 phenology-data.ts，此文件仅保留业务逻辑。
 * 新增地域只需在 phenology-data.ts 添加数据。
 */
import type { CelestialConfig } from '../global-types.js';
import type { PhenologyEntry } from '../global-types.js';
import { PHENOLOGY_MAP } from './phenology-data.js';
import { TimeKeeper } from '../base/TimeKeeper.js';

export class PhenologyTimeline {
  private timeKeeper: TimeKeeper;
  private region: string;

  constructor(config: CelestialConfig, timeKeeper: TimeKeeper) {
    this.timeKeeper = timeKeeper;
    this.region = config.region ?? 'shenzhen';
  }

  async init(): Promise<void> {}
  reset(): void {}
  destroy(): void {}

  /** 切换地域 */
  setRegion(region: string): void { this.region = region; }

  /** 获取当月物候 */
  getCurrent(): PhenologyEntry {
    return this.getForMonth(this.timeKeeper.now().getMonth() + 1);
  }

  /** 获取指定月物候 */
  getForMonth(month: number): PhenologyEntry {
    const data = PHENOLOGY_MAP[this.region] ?? PHENOLOGY_MAP.shenzhen;
    return data.find(e => e.month === month) ?? data[0];
  }

  /** 获取当月花卉文案 */
  getFlowerText(): string {
    return this.getCurrent().flowers.join('、');
  }

  /** 获取当月场景氛围文案 */
  getSceneText(): string {
    return this.getCurrent().scenes.join('、');
  }

  /** 获取当月物候描述文案 */
  getPhenologyText(): string {
    return this.getCurrent().phenology.join('、');
  }
}
