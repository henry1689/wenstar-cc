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

  /**
   * P0-2: 将 L0 locus_path 映射到 15 种刺激类型的标准意图
   * 4位L0编码与刺激类型一一对应，替代硬编码默认值
   */
  private mapL0ToIntent(locusPath: string): IntentClassifiedEvent['payload']['intent'] {
    if (locusPath === 'user.emotion.romantic') return 'casual_chat';
    if (locusPath === 'user.emotion.miss_family') return 'casual_chat';
    if (locusPath === 'user.emotion.positive') return 'casual_chat';
    if (locusPath === 'user.emotion.negative') return 'casual_chat';
    if (locusPath === 'user.emotion.suppressed') return 'casual_chat';
    if (locusPath === 'user.family.conflict') return 'casual_chat';
    if (locusPath === 'user.family.care') return 'casual_chat';
    if (locusPath.startsWith('user.work.burnout')) return 'knowledge_query';
    if (locusPath.startsWith('user.work.stress')) return 'knowledge_query';
    if (locusPath.startsWith('user.work')) return 'knowledge_query';
    if (locusPath.startsWith('user.health')) return 'casual_chat';
    if (locusPath.startsWith('user.daily')) return 'casual_chat';
    if (locusPath === 'user.misc.default') return 'casual_chat';
    return 'casual_chat';
  }
}
