/**
 * TemporalGovernor — 时空管理制度
 *
 * 职责协调器，不再包含 Prompt 字符串拼接。
 * 所有渲染文案交由 TemporalPromptRenderer 统一处理。
 *
 * v2:
 * - Prompt 渲染全部委托给 TemporalPromptRenderer
 * - 实现 G02 双输出接口：文本 + 结构化元数据
 */
import type { IEventBus, IStorageProvider } from '../types.js';
import type { TimerExpiredEvent } from '../bus/types.js';
import type { UnifiedTemporalContext } from './global-types.js';
import { EngineContext } from '../EngineContext.js';
import { TimeKeeper } from './base/TimeKeeper.js';
import { SessionTracker } from './base/SessionTracker.js';
import { TemporalContextAggregator } from './TemporalContextAggregator.js';
import { TemporalPromptRenderer } from './TemporalPromptRenderer.js';
import { TimerRegistry } from './base/TimerRegistry.js';

const STORAGE_KEY_SILENT = 'temporal_silent_messages';

export interface TemporalContextOutput {
  /** Prompt 文本块（向下兼容） */
  promptBlock: string;
  /** 完整结构化元数据 */
  meta: UnifiedTemporalContext;
}

export class TemporalGovernor {
  private bus: IEventBus | null = null;
  private storage: IStorageProvider | null = null;
  private timeKeeper: TimeKeeper;
  private sessionTracker: SessionTracker;
  private aggregator: TemporalContextAggregator;
  private renderer: TemporalPromptRenderer;
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
    this.renderer = new TemporalPromptRenderer(sessionTracker, timeKeeper);
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
   * 每轮对话前调用 — 双输出接口
   * @returns {promptBlock, meta} 文本+结构化元数据
   */
  buildTemporalContext(): TemporalContextOutput {
    const ctx = this.aggregator.getFullContext();

    // 由渲染器统一生成 Prompt 文本
    const rendered = this.renderer.render(ctx);
    const parts: string[] = [rendered];

    // 附加静默消息
    if (this.silentMessages.length > 0) {
      parts.push('【待传达】' + this.silentMessages.join('；'));
      this.silentMessages = [];
      this.persistSilent();
    }

    const promptBlock = parts.join('\n');

    // 写入 EngineContext（兼容旧版）
    EngineContext.setTemporalBlock(promptBlock);

    return { promptBlock, meta: ctx };
  }

  private handleTimerExpired = async (event: TimerExpiredEvent): Promise<void> => {
    const snapshot = event.payload.contextSnapshot;
    const ttl = event.payload.snapshotTTL;
    const msg = ttl > 50
      ? '你之前说"' + snapshot.substring(0, 30) + '"，现在时间到了，诗雨记着呢。'
      : '时间到了，诗雨没忘。';

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
