/**
 * orchestrator — 全链路编排器
 *
 * 职责：
 * 1. EventBus 初始化 + 模块生命周期管理
 * 2. 双轨运行开关（legacy / hybrid）
 * 3. 提供 processUserMessage() 入口
 *
 * 不承载任何业务逻辑，只做事件流转和模块调度。
 */
import type { IEventBus, IStorageProvider, ILifecycle } from './types.js';
import type { EngineConfig, EngineMode } from './types.js';
import type { OutputFinalizedEvent, UserInputEvent } from './bus/types.js';
import { EventBus } from './bus/EventBus.js';
import { HeartStateStore } from './heart/HeartStateStore.js';
import { GenerationOrchestrator } from './cortex/GenerationOrchestrator.js';
import { L0Classifier } from './brain/L0Classifier.js';
import { L05IntentRouter } from './brain/L05IntentRouter.js';
import { SafetyInterceptor } from './brain/SafetyInterceptor.js';
import { OutputProcessor } from './cortex/OutputProcessor.js';
import { LegacyAdapter } from './legacy-adapter.js';
import { CommunicationModeStore } from './brain/CommunicationModeStore.js';
import { CommunicationModeRouter } from './brain/CommunicationModeRouter.js';
import { EngineContext } from './EngineContext.js';

/** 简单 traceId 生成（无需外部依赖） */
function generateTraceId(): string {
  return Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);
}

type ProcessChatFn = LegacyAdapter['setProcessChat'] extends (fn: infer F) => void ? F : never;

export class Orchestrator {
  private bus: EventBus;
  private config: EngineConfig;
  private mode: EngineMode = 'legacy';
  private modules: ILifecycle[] = [];

  // 内部模块引用
  private legacyAdapter: LegacyAdapter;
  private outputProcessor: OutputProcessor;
  private heartStore: HeartStateStore;
  private generationOrch: GenerationOrchestrator;
  private _temporalTimer: any = null;
  private _commModeRouter: CommunicationModeRouter | null = null;
  private _temporalModules: { timeKeeper?: any; calendar?: any; moonCalc?: any; phenology?: any; naturalCycle?: any; aggregator?: any; governor?: any; timerRegistry?: any } = {};

  /** 用于 legacy 模式的直接 processChat 引用 */
  private legacyProcessChat: ProcessChatFn | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
    this.bus = new EventBus({ disableTrace: !config.traceEnabled });
    this.mode = config.mode || 'hybrid';

    // 创建模块实例
    this.legacyAdapter = new LegacyAdapter();
    this.outputProcessor = new OutputProcessor();
    this.heartStore = new HeartStateStore();
    this.generationOrch = new GenerationOrchestrator();
  }

  /** 初始化所有模块 */
  async init(): Promise<void> {
    const storage = this.config.storage ?? null;

    // 注册模块（按优先级）
    const commStore = new CommunicationModeStore();
    this._commModeRouter = new CommunicationModeRouter(commStore);

    const modules: ILifecycle[] = [
      new SafetyInterceptor(),
      new L0Classifier(),
      new L05IntentRouter(),
      this._commModeRouter,
      this.heartStore,
      this.legacyAdapter,
      this.generationOrch,
      this.outputProcessor,
    ];

    for (const mod of modules) {
      await mod.init(this.bus, storage);
    }

    this.modules = modules;

    // 如果双轨是 hybrid，设置 LegacyAdapter 的 processChat
    if (this.mode === 'hybrid' && this.legacyProcessChat) {
      this.legacyAdapter.setProcessChat(this.legacyProcessChat);
    }

    console.log(`[Orchestrator] 初始化完成 | mode=${this.mode} | modules=${modules.length} | handlers=${this.bus.handlerCount()}`);

    // 时空感知层初始化
    this.initTemporalScheduler();
  }

  /** 注入 processChat（由 server.ts 在初始化时传入） */
  setProcessChat(fn: ProcessChatFn): void {
    this.legacyProcessChat = fn;
    // hybrid 模式下需要立即设置
    if (this.mode === 'hybrid' && this.modules.length > 0) {
      this.legacyAdapter.setProcessChat(fn);
    }
  }

  /** 切换运行模式 */
  setMode(mode: EngineMode): void {
    this.mode = mode;
    if (mode === 'hybrid' && this.legacyProcessChat) {
      this.legacyAdapter.setProcessChat(this.legacyProcessChat);
    }
    console.log(`[Orchestrator] 切换模式: ${mode}`);
  }

  /** 处理用户消息 */
  async processUserMessage(message: string, sessionId?: string, clientMsgId?: string, testMode?: boolean): Promise<string> {
    // legacy 模式：直接走旧链路
    if (this.mode === 'legacy') {
      if (!this.legacyProcessChat) {
        return '系统未就绪';
      }
      try {
        const result = await this.legacyProcessChat(message, clientMsgId, testMode);
        return result.reply;
      } catch {
        return '抱歉，请求处理失败。';
      }
    }

    // hybrid 模式：走 EventBus 新链路
    // 先刷新时空上下文（让 Governor 注入季节/时辰/久别感知到 EngineContext）
    if (this._temporalModules.governor) {
      this._temporalModules.governor.buildTemporalContext();
    }
    const traceId = generateTraceId();
    const inputEvent: UserInputEvent = {
      type: 'user:input',
      traceId,
      timestamp: Date.now(),
      sessionId: sessionId ?? 'default',
      payload: { content: message, channel: this._commModeRouter?.getMode() === 'phone' ? 'phone' : 'text', clientMsgId, testMode },
    };

    // 等待输出事件
    const result = await this.waitForOutput(inputEvent);
    return result ?? '抱歉，系统未能生成回复。';
  }

  /** 等待 output:finalized 事件 */
  private waitForOutput(event: UserInputEvent): Promise<string | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.bus.off('output:finalized', handler);
        resolve(null);
      }, 30000);

      const handler = async (output: OutputFinalizedEvent): Promise<void> => {
        if (output.traceId === event.traceId) {
          clearTimeout(timeout);
          this.bus.off('output:finalized', handler);
          // 标记 trace 完成
          this.bus.getRecorder()?.complete(event.traceId);
          resolve(output.payload.content);
        }
      };

      this.bus.on('output:finalized', handler);
      this.bus.emit(event);
    });
  }

  /** 重置所有模块 */
  async reset(): Promise<void> {
    for (const mod of this.modules) {
      await mod.reset();
    }
  }

  /** 销毁所有模块 */
  async destroy(): Promise<void> {
    if (this._temporalTimer) { clearInterval(this._temporalTimer); this._temporalTimer = null; }
    for (const mod of this.modules.reverse()) {
      await mod.destroy();
    }
    this.modules = [];
  }

  /** 获取 EventBus 实例（用于外部接入） */
  getBus(): EventBus {
    return this.bus;
  }

  /** 获取 HeartStateStore（用于调试） */
  getHeartStore(): HeartStateStore {
    return this.heartStore;
  }

  /** 组装系统提示词（用于调试/验证） */
  composePrompt(): string {
    const state = this.heartStore.getState();
    return this.generationOrch.compose({
      currentTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
      desireHints: this.heartStore.getDesireHints(),
      emergenceHint: this.heartStore.getEmergenceHint(),
      temporalBlock: EngineContext.getTemporalBlock(),
      communicationMode: EngineContext.getCommMode(),
    });
  }

  /** 获取当前模式 */
  getMode(): EngineMode {
    return this.mode;
  }

  /** 初始化时空感知层（30分钟刷新一次） */
  private async initTemporalScheduler(): Promise<void> {
    try {
      const storage = this.config.storage;
      if (!storage) return;
      const { TimeKeeper, SessionTracker, TimerRegistry, CalendarEngine, LunarPhaseCalc, PhenologyTimeline, NaturalCycle, TemporalContextAggregator } = await import('./temporal/index.js');

      const timeKeeper = new TimeKeeper({ storage, newSessionThreshold: 7200000 });
      await timeKeeper.init();
      this._temporalModules.timeKeeper = timeKeeper;

      const sessionTracker = new SessionTracker({ storage, newSessionThreshold: 7200000 });
      await sessionTracker.init();

      this._temporalModules.calendar = new CalendarEngine({ storage, region: 'shenzhen' }, timeKeeper);
      this._temporalModules.moonCalc = new LunarPhaseCalc(timeKeeper);
      this._temporalModules.phenology = new PhenologyTimeline({ storage: storage, region: 'shenzhen' }, timeKeeper);
      this._temporalModules.naturalCycle = new NaturalCycle({ storage: storage, region: 'shenzhen' }, timeKeeper);
      this._temporalModules.aggregator = new TemporalContextAggregator(
        timeKeeper, sessionTracker,
        this._temporalModules.calendar, this._temporalModules.moonCalc,
        this._temporalModules.phenology, this._temporalModules.naturalCycle,
      );

      const { TemporalGovernor } = await import('./temporal/TemporalGovernor.js');
      this._temporalModules.timerRegistry = new TimerRegistry({ storage, newSessionThreshold: 7200000 }, timeKeeper);
      this._temporalModules.timerRegistry.setBus(this.bus);
      await this._temporalModules.timerRegistry.init();
      const governor = new TemporalGovernor(timeKeeper, sessionTracker, this._temporalModules.aggregator, this._temporalModules.timerRegistry);
      governor.setBus(this.bus);
      await governor.init(storage);
      this._temporalModules.governor = governor;

      this.refreshTemporalContext();

      // 每30分钟刷新一次
      this._temporalTimer = setInterval(() => this.refreshTemporalContext(), 1800000);
      console.log('[Temporal] 时空感知层已启动（30分钟刷新）');
    } catch (err) {
      console.warn('[Temporal] 初始化失败（不影响主流程）:', (err as Error).message);
    }
  }

  /** 刷新时空上下文 */
  private refreshTemporalContext(): void {
    try {
      if (this._temporalModules.aggregator) {
        const ctx = this._temporalModules.aggregator.getFullContext();
        EngineContext.setTemporalBlock(ctx.promptBlock);
      }
    } catch (e: any) { console.error('[Orchestrator] error:', e?.message); }
  }
}
