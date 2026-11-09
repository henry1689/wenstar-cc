/**
 * proactive-stage — 主动回忆接线阶段（MEM-UNIFY-V1 批4）
 * ====================================================
 * 职责边界：
 *   · `m4/recall/proactive-trigger.ts` = 纯规则信号（零依赖、零文案）；
 *   · 本文件 = 数据供给 + 开关过滤 + **文案组装**（只从 MEMORY-LAW-V1 法源取文本）。
 *
 * 节日真源：`CalendarEngine.getFestivals`（全系统唯一传统节日表）。
 *   本文件只负责持有一个**只读、无持久化**的日历实例（不调用 init/destroy），
 *   按自然日缓存结果 —— 不另建节日表，不复制农历数据。
 *
 * 失败语义：日历不可用 / 配置关闭 / 检测异常 → 返回空信号，主动回忆静默跳过，
 *   绝不阻塞召回主链（与 retrieval-stage 的 fail-open 约定一致）。
 */

import { getRetrievalFusionConfig } from '../../config/retrieval-fusion-config.js';
import {
  detectProactiveTriggers,
  filterTriggers,
  type ProactiveResult,
  type ProactiveSqlSource,
} from '../../m4/recall/proactive-trigger.js';
import {
  MEMORY_LAW_DUTY,
  MEMORY_LAW_TRIO,
  MEMORY_LAW_FUTURE,
} from '../../m5/prompts/memory-expression-law.js';
import { TimeKeeper } from '../../engine/temporal/base/TimeKeeper.js';
import { CalendarEngine } from '../../engine/temporal/celestial/CalendarEngine.js';
import type { IStorageProvider } from '../../engine/types.js';

/**
 * 日历只读实例的存储占位：
 * `CalendarEngine.getFestivals` 只用纯历法换算，`TimeKeeper` 也未调用 init/persist，
 * 因此这里不需要任何真实持久化能力（也不得借此写盘）。
 */
const NOOP_STORAGE: IStorageProvider = {
  get<T>(_key: string): Promise<T | null> { return Promise.resolve(null); },
  set<T>(_key: string, _value: T): Promise<void> { return Promise.resolve(); },
  query<T>(_sql: string, _params?: unknown[]): Promise<T[]> { return Promise.resolve([]); },
  transaction<T>(fn: () => Promise<T>): Promise<T> { return fn(); },
};

let _calendar: CalendarEngine | null = null;
let _festivalKey = '';
let _festivalCache: string[] = [];

function getCalendar(): CalendarEngine {
  if (!_calendar) {
    const timeKeeper = new TimeKeeper({ storage: NOOP_STORAGE });
    _calendar = new CalendarEngine({ storage: NOOP_STORAGE, region: 'shenzhen' }, timeKeeper);
  }
  return _calendar;
}

/** 当日节日（按自然日缓存；失败返回空数组，不抛出） */
export function getTodayFestivals(now: Date = new Date()): string[] {
  const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (key === _festivalKey) return _festivalCache;
  try {
    const list = getCalendar().getFestivals(now.getFullYear(), now.getMonth() + 1, now.getDate()) || [];
    _festivalCache = list.map(String).filter(Boolean);
    _festivalKey = key;
    return _festivalCache;
  } catch (e) {
    console.warn('[Proactive] 节日检测失败（跳过）:', (e as Error)?.message || e);
    return [];
  }
}

export interface ProactiveStageOptions {
  sqlite?: ProactiveSqlSource | null;
  entityUuid?: string | null;
  /** 注入 now（确定性测试） */
  now?: Date;
}

/**
 * 按配置执行主动触发检测：逐类开关 → 权重阈值 → 返回结构化信号。
 * 配置关闭（`proactive.enabled=false`）时恒返回空。
 */
export function detectProactive(message: string, opts: ProactiveStageOptions = {}): ProactiveResult {
  const empty: ProactiveResult = { active: false, triggers: [] };
  let cfg: ReturnType<typeof getRetrievalFusionConfig>['proactive'];
  try {
    cfg = getRetrievalFusionConfig().proactive;
  } catch (e) {
    console.warn('[Proactive] 配置读取失败（跳过）:', (e as Error)?.message || e);
    return empty;
  }
  if (!cfg || cfg.enabled === false) return empty;

  const now = opts.now ?? new Date();
  const festivals = cfg.festival === false ? [] : getTodayFestivals(now);
  const raw = detectProactiveTriggers(String(message || ''), {
    now,
    festivals,
    sqlite: opts.sqlite,
    entityUuid: opts.entityUuid,
    anniversary: cfg.anniversary !== false,
    anniversaryMinCalcium: cfg.anniversary_min_calcium,
  });

  const allowed = new Set<string>();
  if (cfg.festival !== false) allowed.add('festival');
  if (cfg.anniversary !== false) allowed.add('anniversary');
  if (cfg.emotion !== false) allowed.add('emotion');
  if (cfg.routine !== false) allowed.add('routine');
  if (cfg.topic !== false) allowed.add('topic');
  const kept = raw.triggers.filter(t => allowed.has(t.type));
  return filterTriggers({ active: kept.length > 0, triggers: kept }, Number(cfg.min_weight) || 0);
}

/**
 * 主动回忆指令（文案单源：MEMORY-LAW-V1）。
 * 无信号时返回空串 —— 调用方不得注入空块。
 */
export function buildProactiveDirective(result: ProactiveResult): string {
  if (!result?.active || !result.triggers?.length) return '';
  const reasons = result.triggers.map(t => t.reason).join('；');
  return '\n【主动回忆 · MemSym】本轮检测到主动回忆信号：' + reasons + '。\n'
    + MEMORY_LAW_DUTY + '\n'
    + MEMORY_LAW_TRIO + '\n'
    + MEMORY_LAW_FUTURE + '\n'
    + '主动义务不是可选项：先用记忆里的真实元素回应此刻的场景/情绪，再按三重奏回味→叠加→憧憬；'
    + '没有记忆元素时邀对方给由头，不要用"不记得"终止话题。';
}
