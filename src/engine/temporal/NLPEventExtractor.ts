/**
 * NLPEventExtractor — 自然语言时序&气象语义提取器
 *
 * 从用户口语中提取：时序事件、气象设定、定位修改、模式切换、出行标记
 * 规则驱动，零LLM
 */
import { EVENT_COMMON_SENSE, OUTDOOR_KEYWORDS, setWorldRuleMode } from './TemporalConfig.js';

export interface ExtractedEvent {
  type: 'temporal_event' | 'weather_setting' | 'location_change' | 'mode_switch' | 'event_query' | 'event_cancel' | 'outdoor_activity' | 'weather_query' | 'location_switch_weather';
  entityId: string;
  content: string;
  params: Record<string, any>;
  hasOutdoorActivity: boolean;
}

export type TemporalExtractedEvent = ExtractedEvent;

const BASE_MAP: Record<string, { days: number; desc: string }> = {
  '怀孕': { days: EVENT_COMMON_SENSE.pregnancyDays, desc: '妊娠期' },
  '生孩子': { days: EVENT_COMMON_SENSE.pregnancyDays, desc: '妊娠期' },
  '生宝宝': { days: EVENT_COMMON_SENSE.pregnancyDays, desc: '妊娠期' },
  '分娩': { days: EVENT_COMMON_SENSE.pregnancyDays, desc: '妊娠期' },
  '感冒': { days: EVENT_COMMON_SENSE.coldRecoveryDays, desc: '感冒恢复' },
  '发烧': { days: EVENT_COMMON_SENSE.coldRecoveryDays, desc: '发烧恢复' },
  '恢复': { days: EVENT_COMMON_SENSE.coldRecoveryDays, desc: '恢复期' },
};

class NLPEventExtractorImpl {
  extract(text: string, defaultEntityId: string = '鸿艺'): ExtractedEvent | null {
    if (!text || text.length < 2) return null;
    const hasOutdoor = OUTDOOR_KEYWORDS.some(k => text.includes(k));

    const modeResult = this.detectModeSwitch(text);
    if (modeResult) return modeResult;

    // 天气查询优先检测（在时序事件之前，因为"下周去上海天气如何"既是天气查询也是行程）
    const weatherQueryResult = this.detectWeatherQuery(text);
    if (weatherQueryResult) return weatherQueryResult;

    // 行程+天气组合："下周去上海" → 查询上海预报
    const tripWeatherResult = this.detectTripWeather(text, defaultEntityId);
    if (tripWeatherResult) return tripWeatherResult;

    const queryResult = this.detectEventQuery(text);
    if (queryResult) return queryResult;
    const cancelResult = this.detectEventCancel(text);
    if (cancelResult) return cancelResult;

    const weatherResult = this.detectWeatherSetting(text);
    if (weatherResult) return weatherResult;

    const locationResult = this.detectLocationChange(text);
    if (locationResult) return locationResult;

    const eventResult = this.detectTemporalEvent(text, defaultEntityId);
    if (eventResult) return eventResult;

    if (hasOutdoor) {
      return { type: 'outdoor_activity', entityId: defaultEntityId, content: text, params: {}, hasOutdoorActivity: true };
    }

    return null;
  }

  /** 用户主动询问天气 */
  private detectWeatherQuery(text: string): ExtractedEvent | null {
    // "天气怎么样""天气如何""查一下天气""下周天气"等
    if (!/天气|气象|气温|下雨|下雪|降温|升温|台风|暴雨/.test(text)) return null;
    // 提取目标城市（如果有）
    const cityMatch = text.match(/([一-龥]{2,4})(?:的|那边)?(?:天气|气象|气温)/);
    const targetCity = cityMatch?.[1] || null;
    // 检测是否问远期
    const isFuture = /下周|下星期|未来|预报|之后/.test(text);

    return {
      type: 'weather_query',
      entityId: '',
      content: text,
      params: {
        targetCity,
        isFutureQuery: isFuture,
      },
      hasOutdoorActivity: false,
    };
  }

  /** "下周去上海" → 查上海天气预报 */
  private detectTripWeather(text: string, entityId: string): ExtractedEvent | null {
    // "去XX出差""下周去XX""要去XX"等
    const tripMatch = text.match(/(?:去|到|出差去|要去|去一趟)([一-龥]{2,4})(?:出差|旅行|玩|开会)?(?:[，。]|$)/);
    if (!tripMatch) return null;
    const city = tripMatch[1].trim();
    // 排除模糊词
    if (/那边|那里|哪里|外地|公司|上班|楼下/.test(city)) return null;
    // 同时问天气
    const asksWeather = /天气|气温|带什么衣服|穿什么|冷不冷|热不热|下雨|带伞/.test(text);

    return {
      type: 'location_switch_weather',
      entityId,
      content: text,
      params: {
        city,
        asksWeather: asksWeather || true, // 去外地默认关心天气
      },
      hasOutdoorActivity: true,
    };
  }

  private detectModeSwitch(text: string): ExtractedEvent | null {
    const enableMatch = text.match(/开启(自由)?(角色扮演)?豁免(模式)?|忽略客观规律|自由演绎|架空剧情/);
    if (enableMatch) {
      setWorldRuleMode('roleplay_exempt');
      return { type: 'mode_switch', entityId: '', content: enableMatch[0], params: { mode: 'roleplay_exempt' }, hasOutdoorActivity: false };
    }
    const disableMatch = text.match(/关闭(自由)?(角色扮演)?豁免(模式)?|恢复真实|关闭.*模式|恢复规则/);
    if (disableMatch) {
      setWorldRuleMode('realistic');
      return { type: 'mode_switch', entityId: '', content: disableMatch[0], params: { mode: 'realistic' }, hasOutdoorActivity: false };
    }
    return null;
  }

  private detectEventQuery(text: string): ExtractedEvent | null {
    if (/还有多久|什么时候.*[到好完]|还剩.*时间|查询.*事件|当前.*事件|正在.*事件/.test(text)) {
      return { type: 'event_query', entityId: '', content: text, params: {}, hasOutdoorActivity: false };
    }
    return null;
  }

  private detectEventCancel(text: string): ExtractedEvent | null {
    const m = text.match(/取消(.*?)(事件|行程|计划)/);
    if (m) {
      return { type: 'event_cancel', entityId: '', content: m[1]?.trim() || '', params: { target: m[1]?.trim() }, hasOutdoorActivity: false };
    }
    return null;
  }

  private detectWeatherSetting(text: string): ExtractedEvent | null {
    const m = text.match(/(?:天气|气象|天)(?:变成|改为|设定为|是)(.+?)(?:[，。]|$)/);
    if (m) {
      return {
        type: 'weather_setting',
        entityId: '',
        content: m[1].trim(),
        params: { weatherDesc: m[1].trim() },
        hasOutdoorActivity: OUTDOOR_KEYWORDS.some(k => text.includes(k)),
      };
    }
    return null;
  }

  private detectLocationChange(text: string): ExtractedEvent | null {
    const m = text.match(/(?:切换到?|定位到?|位置(?:改为?|切到?)|去)(.+?)(?:[，。]|$)/);
    if (m && !/上班|公司|出差|哪里/.test(m[1])) {
      return {
        type: 'location_change',
        entityId: '',
        content: m[1].trim(),
        params: { area: m[1].trim() },
        hasOutdoorActivity: true,
      };
    }
    return null;
  }

  private detectTemporalEvent(text: string, entityId: string): ExtractedEvent | null {
    const durationMatch = text.match(/(\d+)\s*(小时|天|周|个月)/);
    const destMatch = text.match(/去(?:了)?(.+?)(?:[，。]|$)/);
    let eventType: string = 'custom';
    let baseDays = 0;

    for (const [keyword, info] of Object.entries(BASE_MAP)) {
      if (text.includes(keyword)) {
        eventType = keyword;
        baseDays = info.days;
        break;
      }
    }
    // 生理周期事件：baseDays 语义 = 周期间隔(下次到临)。单一源 EVENT_COMMON_SENSE.menstruationCycleDays。
    if (/例假|生理期|月经/.test(text)) {
      eventType = 'phys_cycle';
      baseDays = EVENT_COMMON_SENSE.menstruationCycleDays;
    }

    const durationMs = durationMatch ? this.parseDuration(durationMatch[1], durationMatch[2]) : null;
    if (durationMs || baseDays > 0) {
      const totalMs = durationMs ?? (baseDays * 86400000);
      const now = Date.now();
      return {
        type: 'temporal_event',
        entityId,
        content: text.substring(0, 100),
        params: {
          eventType,
          startTs: now,
          endTs: now + totalMs,
          // cycleMs = 周期间隔(与 durationMs/endTs 语义一致 = 下次到临);从 baseDays 单一源派生,避免字面量重复与单位漂移。
          cycleMs: eventType === 'phys_cycle' ? baseDays * 86400000 : 0,
          durationMs: totalMs,
          durationText: durationMatch ? durationMatch[0] : `${baseDays}天`,
          destination: destMatch?.[1] || null,
        },
        hasOutdoorActivity: OUTDOOR_KEYWORDS.some(k => text.includes(k)),
      };
    }

    const nestMatch = text.match(/(?:前|先)(\d+)(小时|分钟)(.+?)(?:剩下|其余|后|之后)(.+?)(?:[。]|$)/);
    if (nestMatch) {
      const firstDur = this.parseDuration(nestMatch[1], nestMatch[2]);
      const now = Date.now();
      return {
        type: 'temporal_event',
        entityId,
        content: text.substring(0, 100),
        params: {
          eventType: 'trip',
          startTs: now,
          endTs: now + firstDur + 8 * 3600000,
          subEvents: [
            { content: nestMatch[3].trim(), durationMs: firstDur },
            { content: nestMatch[4].trim(), durationMs: 8 * 3600000 },
          ],
        },
        hasOutdoorActivity: true,
      };
    }

    return null;
  }

  private parseDuration(amount: string, unit: string): number {
    const n = parseInt(amount, 10) || 0;
    if (unit === '小时') return n * 3600000;
    if (unit === '天') return n * 86400000;
    if (unit === '周') return n * 7 * 86400000;
    if (unit === '个月') return n * 30 * 86400000;
    return n * 3600000;
  }
}

export const NLPEventExtractor = new NLPEventExtractorImpl();
