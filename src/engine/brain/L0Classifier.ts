/**
 * L0Classifier — 脑干反射层·输入分类器
 *
 * 从 M1 L0Router 迁移，保持现有规则不变。
 * 订阅 user:input → 输出 IntentClassifiedEvent
 * 纯规则，零 LLM，毫秒级
 */
import type { IEventBus, ILifecycle, IStorageProvider } from '../types.js';
import type { IntentClassifiedEvent, UserInputEvent } from '../bus/types.js';
import { routeL0 } from '../../m1/L0Router.js';

export class L0Classifier implements ILifecycle {
  private bus: IEventBus | null = null;
  private _boundHandleInput: ((event: any) => void) | null = null;

  async init(bus: IEventBus, _storage?: IStorageProvider): Promise<void> {
    this.bus = bus;
    this._boundHandleInput = this.handleInput.bind(this);
    bus.on('user:input', this._boundHandleInput, 200);
  }

  reset(): void {
    // L0Classifier 无状态，无需 reset
  }

  destroy(): void {
    if (this.bus && this._boundHandleInput) {
      this.bus.off('user:input', this._boundHandleInput);
    }
    this.bus = null;
    this._boundHandleInput = null;
  }

  private handleInput = async (event: UserInputEvent): Promise<void> => {
    const text = event.payload.content;
    if (!text || !text.trim()) return;

    // 调用现有 L0 路由
    const l0Result = routeL0(text);

    // 构建分类事件
    const classified: IntentClassifiedEvent = {
      type: 'intent:classified',
      traceId: event.traceId,
      timestamp: Date.now(),
      sessionId: event.sessionId,
      payload: {
        rawInput: text,
        intent: this.mapL0ToIntent(l0Result.locus_path),
        confidence: 1.0,
        source: 'rule',
        shouldBypassLLM: false,
      },
    };
    this.bus?.emit(classified);
  };

  /** 将 L0 locus_path 映射到顶层意图 */
  private mapL0ToIntent(locusPath: string): IntentClassifiedEvent['payload']['intent'] {
    if (locusPath.startsWith('user.family') || locusPath.startsWith('user.work')) {
      return 'casual_chat';
    }
    if (locusPath.startsWith('user.emotion')) {
      return 'casual_chat';
    }
    return 'casual_chat';
  }
}
