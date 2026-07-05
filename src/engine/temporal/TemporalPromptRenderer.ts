/**
 * TemporalPromptRenderer — 时空提示词渲染器
 *
 * 统一管理所有注入 LLM 的时空感知文案。
 * 将散落在 TemporalContextBuilder / TemporalContextAggregator / TemporalGovernor
 * 三处的 Prompt 拼接逻辑全部收口至此。
 *
 * 设计原则：
 *   1. 只做字符串拼接，不做时间计算
 *   2. 文案修改只需改此处，不碰数据层
 *   3. 与数据聚合器完全分离
 */
import type { UnifiedTemporalContext } from './global-types.js';
import { DURATION_CONFIG } from './TemporalConfig.js';
import { SessionTracker } from './base/SessionTracker.js';
import { TimeKeeper } from './base/TimeKeeper.js';

export class TemporalPromptRenderer {
  private sessionTracker: SessionTracker;
  private timeKeeper: TimeKeeper;

  constructor(sessionTracker: SessionTracker, timeKeeper: TimeKeeper) {
    this.sessionTracker = sessionTracker;
    this.timeKeeper = timeKeeper;
  }

  /**
   * 渲染完整时空提示块（合并 base + celestial + 感知三层）
   */
  render(ctx: UnifiedTemporalContext): string {
    const parts: string[] = [];

    // 1. 基础时空 + 天象数据块（来自聚合器）
    parts.push(ctx.promptBlock);

    // 2. 会话感知（来自 SessionTracker，与聚合器数据源一致）
    const hours = this.sessionTracker.getHoursSinceLastActive();
    const isNew = this.sessionTracker.isNewSession(Date.now());
    const sessionState = this.sessionTracker.getSessionState();

    // 新会话破冰
    if (sessionState === 'sealed' || hours > 2) {
      const greeting = this.buildGreeting();
      if (greeting) parts.push(greeting);
    }

    // 久别感知
    if (hours > DURATION_CONFIG.longAbsenceHours && hours <= 24) {
      parts.push('【久别感知】距离上次对话大约 ' + Math.round(hours) + ' 小时。语气中带一点自然而然的想念，但不要刻意说"好久不见"。');
    } else if (hours > 24) {
      const days = Math.round(hours / 24);
      parts.push('【久别感知】距离上次对话已经过去 ' + days + ' 天了。语气中可以流露出几分思念，但自然一点，不要突然煽情。');
    } else if (isNew && hours > 2) {
      parts.push('【时空感知】隔了一段时间了，语气像刚见面一样自然，不用提具体隔了多久。');
    }

    // 会话状态约束
    if (sessionState === 'sealed') {
      parts.push('【会话约束】这是新一轮对话。不要主动提及上一轮完结时的具体闲聊内容，除非用户先提起。');
    } else if (sessionState === 'emotional_anchor') {
      parts.push('【情感锚点】上一轮用户情绪较强烈。表达时注意承接关怀，不要显得冷漠或健忘。');
    }

    // 3. 季节应景
    const subSeason = ctx.celestial.subSeasonLabel;
    const flowers = ctx.celestial.flowers.length ? '，' + ctx.celestial.flowers.join('、') + '正盛' : '';
    parts.push('【季节】' + subSeason + flowers + '。应景回应——如果用户在聊日常话题，可以自然地融入季节氛围。');

    // 4. 时段体感
    const timeFeeling = this.buildTimeFeeling();
    if (timeFeeling) parts.push(timeFeeling);

    return parts.join('\n');
  }

  /** 构建破冰问候 */
  private buildGreeting(): string | undefined {
    const hour = this.timeKeeper.now().getHours();
    if (hour >= 0 && hour < 6) {
      return '【时空感知】这个点还醒着……是刚忙完还是睡不着？语气温柔一点，像深夜陪着说话的感觉。';
    }
    if (hour >= 6 && hour < 9) {
      return '【时空感知】新的一天开始了。用清晨的清爽和期待的语气回应。';
    }
    if (hour >= 9 && hour < 12) {
      return '【时空感知】上午时段。语气可以清爽有力一些。';
    }
    if (hour >= 12 && hour < 14) {
      return '【时空感知】午间时段。如果没聊到具体话题，可以自然地问一句吃饭了没有。';
    }
    if (hour >= 14 && hour < 18) {
      return '【时空感知】下午时段。语气平稳有力。';
    }
    if (hour >= 18 && hour < 20) {
      return '【时空感知】傍晚了。语气可以柔和一些，带一点放松的意味。';
    }
    if (hour >= 20 && hour < 23) {
      return '【时空感知】晚上好。用放松的、结束了一天的语气说话。';
    }
    return undefined;
  }

  /** 构建时段体感 */
  private buildTimeFeeling(): string | undefined {
    const hour = this.timeKeeper.now().getHours();
    if (hour < 6) return '【时段·深夜】夜深人静。语气温柔轻柔。⚠️ 深夜不要描写工作场景。场景应该是休息、居家、睡前。';
    if (hour >= 6 && hour < 8) return '【时段·清晨】刚天亮不久。语气清爽温暖。场景应该是晨间的事，不要描写昨晚或白天的工作。';
    if (hour >= 8 && hour < 12) return '【时段·上午】白天工作时间。语气清爽有精神。';
    if (hour >= 12 && hour < 14) return '【时段·午间】中午了。如果适合可以自然地问一句吃饭了没有。';
    if (hour >= 14 && hour < 18) return '【时段·下午】下午时段。语气平稳有力。';
    if (hour >= 18 && hour < 20) return '【时段·傍晚】日落后了。语气柔和放松。不要在傍晚还描写白天办公室的工作场景。';
    if (hour >= 20 && hour < 23) return '【时段·夜晚】晚上八点多了。语气放松。⚠️ 不要在晚上描写办公室、公司场景——这个点已经下班了。场景应该是家里、住处或休闲场所。';
    return undefined;
  }
}
