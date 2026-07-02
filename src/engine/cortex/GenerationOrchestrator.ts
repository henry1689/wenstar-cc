/**
 * GenerationOrchestrator — 新皮层生成调度器
 *
 * 唯一接触 LLM 的模块。
 * 接收 heart:state_updated → 组装提示词 → 调用 M5 → 输出 generation:result
 * 不做任何状态修改（单向约束）。
 */
import type { IEventBus, ILifecycle, IStorageProvider } from '../types.js';
import type { GenerationResultEvent, HeartStateUpdatedEvent } from '../bus/types.js';
import { composeSystemPrompt, type ComposerInput } from './PromptComposer.js';

// M5 调用接口（避免直接依赖有副作用的模块）
interface M5Callable {
  orchestrate(m4ctx: any, history: any[], knowledge: string, userMsg: string): Promise<string>;
}

export class GenerationOrchestrator implements ILifecycle {
  private bus: IEventBus | null = null;
  private _boundOnHeartUpdated: ((event: any) => void) | null = null;
  private m5: M5Callable | null = null;
  /** 缓存最新的 heart 状态，非 LLM 轮次也可以读取 */
  private lastHeartPayload: HeartStateUpdatedEvent['payload'] | null = null;

  async init(bus: IEventBus, _storage?: IStorageProvider): Promise<void> {
    this.bus = bus;
    this._boundOnHeartUpdated = this.onHeartUpdated.bind(this);
    bus.on('heart:state_updated', this._boundOnHeartUpdated, 400);
  }

  /** 注入 M5 实例（由 orchestrator 在初始化时注入） */
  setM5(m5: M5Callable): void {
    this.m5 = m5;
  }

  reset(): void { this.lastHeartPayload = null; }
  destroy(): void {
    if (this.bus && this._boundOnHeartUpdated) {
      this.bus.off('heart:state_updated', this._boundOnHeartUpdated);
    }
    this.bus = null;
    this._boundOnHeartUpdated = null;
  }

  /** 获取组装好的系统提示词（供外部调用） */
  compose(input: Partial<ComposerInput>): string {
    const heart = this.lastHeartPayload;
    return composeSystemPrompt({
      emotionVector: heart?.emotionVector ?? input.emotionVector ?? defaultEmotion(),
      relationState: heart?.relationState ?? input.relationState ?? 'stranger',
      atmosphere: heart?.atmosphere ?? input.atmosphere ?? 'neutral',
      memoryPermission: heart?.memoryPermission ?? input.memoryPermission ?? 'sand',
      ...input,
    });
  }

  private onHeartUpdated = async (event: HeartStateUpdatedEvent): Promise<void> => {
    this.lastHeartPayload = event.payload;
    // S3: 后续在此处将组装好的提示词传递给 M5
    // 当前通过 LegacyAdapter 处理 LLM 调用
  };
}

function defaultEmotion() {
  return {
    joy: 30, sadness: 0, anger: 0, fear: 0,
    surprise: 10, disgust: 0, calm: 50, anxiety: 0,
    affection: 20, trust: 30, intimacy: 10, respect: 20,
    arousal: 10, fatigue: 10, excitement: 10, boredom: 0,
    dominance: 0, compliance: 10, warmth: 30, coldness: 0,
    nostalgia: 0, curiosity: 20, shyness: 0, jealousy: 0,
  };
}
