/**
 * TemporalContext — 时空上下文构建器
 *
 * 收集 TimeKeeper + SessionTracker 的输出，组装为结构化数据块。
 *
 * v2: 改为输出纯数据块 `buildTimeBlock()`，Prompt 渲染由渲染器接管。
 */
import type { TemporalContextBlock, FarewellLevel, SessionState } from '../global-types.js';
import { TimeKeeper } from './TimeKeeper.js';
import { SessionTracker } from './SessionTracker.js';

export class TemporalContextBuilder {
  private timeKeeper: TimeKeeper;
  private sessionTracker: SessionTracker;

  constructor(timeKeeper: TimeKeeper, sessionTracker: SessionTracker) {
    this.timeKeeper = timeKeeper;
    this.sessionTracker = sessionTracker;
  }

  /** 构建结构化时空数据块（无渲染文案） */
  build(): TemporalContextBlock {
    const sessionState = this.sessionTracker.getSessionState();
    const hoursSinceLast = this.sessionTracker.getHoursSinceLastActive();
    const farewellLevel = this.sessionTracker.getState().lastFarewellLevel;

    return {
      currentTime: this.timeKeeper.fullDateTimeLabel(),
      periodLabel: this.timeKeeper.periodLabel(),
      dateLabel: this.timeKeeper.dateString(),
      weekdayLabel: this.timeKeeper.weekdayLabel(),
      sessionState,
      hoursSinceLastChat: Math.round(hoursSinceLast * 10) / 10,
      farewellLevel,
    };
  }

  /**
   * 构建基础时空数据块（供聚合器/渲染器使用，不含渲染文案）
   */
  buildTimeBlock(): string {
    const ctx = this.build();
    const parts: string[] = [];
    parts.push(`当前时间：${ctx.currentTime}`);

    if (ctx.sessionState === 'sealed' || ctx.hoursSinceLastChat > 2) {
      // 仅输出结构化信息，问候文案由渲染器处理
      parts.push(`【会话】新会话（距上次${ctx.hoursSinceLastChat}小时）`);
    }

    if (ctx.hoursSinceLastChat > 8) {
      parts.push(`【间隔】${ctx.hoursSinceLastChat}小时未对话`);
    }

    if (ctx.sessionState === 'sealed') {
      parts.push('【状态】已封存');
    } else if (ctx.sessionState === 'emotional_anchor') {
      parts.push('【状态】情绪锚点');
    }

    return parts.join('\n');
  }
}
