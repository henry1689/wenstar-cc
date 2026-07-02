/**
 * TemporalGovernor — 时空管理制度
 *
 * 职责：
 * 1. 监听 timer:expired 事件 → 生成主动回访消息（问题3）
 * 2. 跨会话时长感知 → 注入久时标签（问题4）
 * 3. 季节时辰应景 → 强制注入 Prompt，不会被 LLM 无视（问题5）
 * 4. 会话隔离强制执行 → 已封存会话不自动唤起（问题2+4）
 * 5. 免打扰 → 静默消息累积，下次对话自然带出
 */
import type { IEventBus, IStorageProvider } from '../types.js';
import type { TimerExpiredEvent } from '../bus/types.js';
import { EngineContext } from '../EngineContext.js';
import { TimeKeeper } from './base/TimeKeeper.js';
import { SessionTracker } from './base/SessionTracker.js';
import { TemporalContextAggregator } from './TemporalContextAggregator.js';
import { TimerRegistry } from './base/TimerRegistry.js';

const STORAGE_KEY_SILENT = 'temporal_silent_messages';

export class TemporalGovernor {
  private bus: IEventBus | null = null;
  private storage: IStorageProvider | null = null;
  private timeKeeper: TimeKeeper;
  private sessionTracker: SessionTracker;
  private aggregator: TemporalContextAggregator;
  private timerRegistry: TimerRegistry;
  private silentMessages: string[] = [];

  constructor(
    timeKeeper: TimeKeeper,
    sessionTracker: SessionTracker,
    aggregator: TemporalContextAggregator,
    timerRegistry: TimerRegistry,
  ) {
    this.timeKeeper = timeKeeper;
    this.sessionTracker = sessionTracker;
    this.aggregator = aggregator;
    this.timerRegistry = timerRegistry;
  }

  setBus(bus: IEventBus): void {
    this.bus = bus;
  }

  async init(storage: IStorageProvider): Promise<void> {
    this.storage = storage;
    try {
      const saved = await storage.get<string[]>(STORAGE_KEY_SILENT);
      if (saved) this.silentMessages = saved;
    } catch (e: any) { console.error('[TemporalGov] error:', e?.message); }

    // 订阅定时到期事件（问题3修复）
    this.bus?.on('timer:expired', this.handleTimerExpired, 250);

    console.log('[TemporalGovernor] 时空管理制度已启动');
  }

  reset(): void {
    this.silentMessages = [];
  }

  destroy(): void {
    this.silentMessages = [];
    this.storage = null;
  }

  /**
   * 每轮对话前调用 —— 构建完整的时空感知上下文
   * 这是问题2/4/5的统一入口
   */
  buildTemporalContext(): string {
    const ctx = this.aggregator.getFullContext();
    const parts: string[] = [];

    // 2. 时空感知块（核心）
    parts.push(ctx.promptBlock);

    // 4. 跨会话时长感知
    const hours = this.sessionTracker.getHoursSinceLastActive();
    const isNew = this.sessionTracker.isNewSession(Date.now());

    if (hours > 8 && hours <= 24) {
      parts.push('【久别感知】距离上次对话大约 ' + Math.round(hours) + ' 小时。语气中带一点自然而然的想念，但不要刻意说"好久不见"。');
    } else if (hours > 24) {
      const days = Math.round(hours / 24);
      parts.push('【久别感知】距离上次对话已经过去 ' + days + ' 天了。语气中可以流露出几分思念，但自然一点，不要突然煽情。');
    } else if (isNew && hours > 2) {
      parts.push('【时空感知】隔了一段时间了，语气像刚见面一样自然，不用提具体隔了多久。');
    }

    // 5. 季节时辰应景（强制注入，不依赖LLM自觉）
    const sun = ctx.celestial.sunCycle;
    const subSeason = ctx.celestial.subSeasonLabel;
    const flowers = ctx.celestial.flowers.length ? '，' + ctx.celestial.flowers.join('、') + '正盛' : '';
    parts.push('【季节】' + subSeason + flowers + '。应景回应——如果用户在聊日常话题，可以自然地融入季节氛围。');

    // 5b. 时段体感（⚠️ 强制约束，LLM 必须遵守时间场景）
    const hour = this.timeKeeper.now().getHours();
    if (hour >= 6 && hour < 8) {
      parts.push('【时段·清晨】刚天亮不久。语气清爽温暖。场景应该是晨间的事，不要描写昨晚或白天的工作。');
    } else if (hour >= 8 && hour < 12) {
      parts.push('【时段·上午】白天工作时间。语气清爽有精神。');
    } else if (hour >= 12 && hour < 14) {
      parts.push('【时段·午间】中午了。如果适合可以自然地问一句吃饭了没有。');
    } else if (hour >= 14 && hour < 18) {
      parts.push('【时段·下午】下午时段。语气平稳有力。');
    } else if (hour >= 18 && hour < 20) {
      parts.push('【时段·傍晚】日落后了。语气柔和放松。不要在傍晚还描写白天办公室的工作场景——这个点应该已经下班了。');
    } else if (hour >= 20 && hour < 23) {
      parts.push('【时段·夜晚】晚上八点多了。语气放松。⚠️ 不要在晚上描写办公室、车间、公司场景——这个点已经下班了。场景应该是家里、住处或休闲场所。');
    } else if (hour >= 23 || hour < 6) {
      parts.push('【时段·深夜】夜深人静。语气温柔轻柔。⚠️ 深夜不要描写工作场景，不要谈工作内容。场景应该是休息、居家、睡前。');
    }

    // 携帯静默消息
    if (this.silentMessages.length > 0) {
      parts.push('【待传达】' + this.silentMessages.join('；'));
      this.silentMessages = [];
      this.persistSilent();
    }

    const result = parts.join('\n');
    // 写入 EngineContext 供 chat.ts 注入
    EngineContext.setTemporalBlock(result);
    return result;
  }

  /**
   * 3. 定时到期 → 生成主动回访消息（不推送，等下次对话带出）
   */
  private handleTimerExpired = async (event: TimerExpiredEvent): Promise<void> => {
    const ctx = this.aggregator.getFullContext();
    const hours = ctx.celestial.sunCycle.dayLengthHours;

    // 根据快照TTL决定消息的详细程度
    const snapshot = event.payload.contextSnapshot;
    const ttl = event.payload.snapshotTTL;
    const msg = ttl > 50
      ? '你之前说"' + snapshot.substring(0, 30) + '"，现在时间到了，诗雨记着呢。'
      : '时间到了，诗雨没忘。';

    // 免打扰 → 存静默
    if (this.timeKeeper.isDoNotDisturb()) {
      this.silentMessages.push(msg);
      await this.persistSilent();
      console.log('[TemporalGovernor] 定时到期，免打扰→静默: ' + event.payload.taskId);
    } else {
      this.silentMessages.push(msg);
      await this.persistSilent();
      console.log('[TemporalGovernor] 定时到期，待下次对话传达: ' + event.payload.taskId);
    }
  };

  private async persistSilent(): Promise<void> {
    try {
      await this.storage?.set(STORAGE_KEY_SILENT, this.silentMessages);
    } catch (e: any) { console.error('[TemporalGov] error:', e?.message); }
  }
}
