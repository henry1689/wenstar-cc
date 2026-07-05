/**
 * global-types.ts — Temporal 模块全局类型定义
 *
 * 统一合并 base 层和 celestial 层所有类型。
 * 各子目录 *-types.ts 改为从此文件 re-export。
 */

// ═══════════════════════════════════════════
// 时段与会话
// ═══════════════════════════════════════════

export type TimePeriod =
  | 'dawn' | 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' | 'midnight';

export type SessionState = 'active' | 'sealed' | 'emotional_anchor';
export type FarewellLevel = 'none' | 'short_pause' | 'session_end';
export type TimerTaskStatus = 'pending' | 'silent' | 'completed' | 'cancelled';
export type TimerTriggerType = 'delay_ms' | 'specific_time' | 'next_day';

export interface TemporalContextBlock {
  currentTime: string;
  periodLabel: string;
  dateLabel: string;
  weekdayLabel: string;
  sessionState: SessionState;
  hoursSinceLastChat: number;
  silentMessage?: string;
  farewellLevel: FarewellLevel;
}

export interface TimerTask {
  id: string;
  sessionId: string;
  triggerType: TimerTriggerType;
  triggerAt: number;
  contextSnapshot: string;
  snapshotTTL: number;
  status: TimerTaskStatus;
  createdAt: string;
  doNotDisturb: boolean;
}

export interface TemporalConfig {
  storage: IStorageProvider;
  newSessionThreshold?: number;
  userActiveOffset?: number;
  emotionalAnchorEnabled?: boolean;
  doNotDisturbStart?: number;
  doNotDisturbEnd?: number;
}

export interface FarewellRule {
  level: FarewellLevel;
  patterns: RegExp[];
}

import type { IStorageProvider } from '../types.js';

// ═══════════════════════════════════════════
// 月相
// ═══════════════════════════════════════════

export type MoonPhase =
  | 'new_moon'
  | 'waxing_crescent'
  | 'first_quarter'
  | 'waxing_gibbous'
  | 'full_moon'
  | 'waning_gibbous'
  | 'last_quarter'
  | 'waning_crescent';

export const MOON_PHASE_LABELS: Record<MoonPhase, string> = {
  new_moon: '新月',
  waxing_crescent: '蛾眉月',
  first_quarter: '上弦月',
  waxing_gibbous: '盈凸月',
  full_moon: '满月',
  waning_gibbous: '亏凸月',
  last_quarter: '下弦月',
  waning_crescent: '残月',
};

// ═══════════════════════════════════════════
// 二十四节气
// ═══════════════════════════════════════════

export type SolarTerm =
  | 'lichun' | 'yushui' | 'jingzhe' | 'chunfen' | 'qingming' | 'guyu'
  | 'lixia' | 'xiaoman' | 'mangzhong' | 'xiazhi' | 'xiaoshu' | 'dashu'
  | 'liqiu' | 'chushu' | 'bailu' | 'qiufen' | 'hanlu' | 'shuangjiang'
  | 'lidong' | 'xiaoxue' | 'daxue' | 'dongzhi' | 'xiaohan' | 'dahan';

export const SOLAR_TERM_LABELS: Record<SolarTerm, string> = {
  lichun:'立春', yushui:'雨水', jingzhe:'惊蛰', chunfen:'春分',
  qingming:'清明', guyu:'谷雨', lixia:'立夏', xiaoman:'小满',
  mangzhong:'芒种', xiazhi:'夏至', xiaoshu:'小暑', dashu:'大暑',
  liqiu:'立秋', chushu:'处暑', bailu:'白露', qiufen:'秋分',
  hanlu:'寒露', shuangjiang:'霜降', lidong:'立冬', xiaoxue:'小雪',
  daxue:'大雪', dongzhi:'冬至', xiaohan:'小寒', dahan:'大寒',
};

// ═══════════════════════════════════════════
// 季节
// ═══════════════════════════════════════════

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export const SEASON_LABELS: Record<Season, string> = {
  spring: '春', summer: '夏', autumn: '秋', winter: '冬',
};

export type SubSeason =
  | 'early_spring' | 'mid_spring' | 'late_spring'
  | 'early_summer' | 'mid_summer' | 'late_summer'
  | 'early_autumn' | 'mid_autumn' | 'late_autumn'
  | 'early_winter' | 'mid_winter' | 'late_winter';

export const SUB_SEASON_LABELS: Record<SubSeason, string> = {
  early_spring:'初春', mid_spring:'仲春', late_spring:'暮春',
  early_summer:'初夏', mid_summer:'仲夏', late_summer:'盛夏',
  early_autumn:'初秋', mid_autumn:'仲秋', late_autumn:'晚秋',
  early_winter:'初冬', mid_winter:'仲冬', late_winter:'深冬',
};

// ═══════════════════════════════════════════
// 天干地支
// ═══════════════════════════════════════════

export interface StemBranch {
  stem: string;
  branch: string;
  full: string;
}

// ═══════════════════════════════════════════
// 物候
// ═══════════════════════════════════════════

export interface PhenologyEntry {
  month: number;
  region: string;
  phenology: string[];
  flowers: string[];
  scenes: string[];
  foods?: string[];
}

// ═══════════════════════════════════════════
// 日出日落
// ═══════════════════════════════════════════

export interface SunCycle {
  sunriseHour: number;
  sunsetHour: number;
  dayLengthHours: number;
}

// ═══════════════════════════════════════════
// 完整天象上下文（聚合器输出）
// ═══════════════════════════════════════════

export interface CelestialContext {
  solarDate: string;
  weekday: string;
  dayOfYear: number;
  lunarDate: string;
  lunarYear: string;
  isLeapMonth: boolean;
  currentTerm: SolarTerm | null;
  currentTermLabel: string;
  nextTerm: SolarTerm | null;
  nextTermLabel: string;
  nextTermDate: string;
  moonPhase: MoonPhase;
  moonPhaseLabel: string;
  moonIllumination: number;
  season: Season;
  seasonLabel: string;
  subSeason: SubSeason;
  subSeasonLabel: string;
  sunCycle: SunCycle;
  phenology: string[];
  flowers: string[];
  scenes: string[];
}

// ═══════════════════════════════════════════
// 天象配置
// ═══════════════════════════════════════════

export interface CelestialConfig {
  storage: IStorageProvider;
  region?: string;
}

// ═══════════════════════════════════════════
// 统一时空上下文（聚合器最终输出）
// ═══════════════════════════════════════════

export interface UnifiedTemporalContext {
  promptBlock: string;
  celestial: CelestialContext;
  currentTime: string;
  compositeLabel: string;
}

// ═══════════════════════════════════════════
// 硬编码常量配置（T02 抽离目标）
// — 所有阈值、关键词、正则统一管理
// ═══════════════════════════════════════════

export interface IDurationConfig {
  /** 新会话判定间隔（毫秒），默认 2h */
  newSessionIntervalMs: number;
  /** 久别触发阈值（小时） */
  longAbsenceHours: number;
  /** 情绪锚点强度阈值 */
  emotionalAnchorThreshold: number;
  /** 情感强度归一化除数 */
  emotionNormalizer: number;
}

export interface IPeriodConfig {
  /** 时段边界表 [hour, period, label] */
  boundaries: Array<[number, TimePeriod, string]>;
  /** 免打扰开始小时 */
  dndStart: number;
  /** 免打扰结束小时 */
  dndEnd: number;
}

export interface IPromptConfig {
  /** 道别词正则数组 */
  farewellPatterns: FarewellRule[];
  /** 高强度情绪关键词 */
  highIntensityWords: string[];
  /** 月相雅称映射 */
  moonPoetic: Record<string, string>;
}
