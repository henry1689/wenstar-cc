/**
 * SafetyInterceptor — 脑干反射层·安全拦截器
 *
 * 最高优先级拦截器，在输入进入分类系统之前拦截。
 * 违禁内容、身份攻击、极端内容 → 直接短路，不进入上层
 */
import type { IEventBus, ILifecycle, IStorageProvider } from '../types.js';
import type { OutputFinalizedEvent, UserInputEvent } from '../bus/types.js';

const BLOCKED_PATTERNS = [
  /自杀|自残|我要死|不想活了|杀了我|nmsl|畜生|操你妈|操你祖宗/i,
  /fuck you mother|kill myself|i want to die|self.?harm/i,
];

const EXTREME_REDLINE = [
  /去死|跳楼|割腕|上吊|跳海|弄死你|你.*去死/i,
];

export class SafetyInterceptor implements ILifecycle {
  private bus: IEventBus | null = null;
  private _boundHandleInput: ((event: any) => void) | null = null;

  async init(bus: IEventBus, _storage?: IStorageProvider): Promise<void> {
    this.bus = bus;
    // 最高优先级：100（必须最先执行）
    this._boundHandleInput = this.handleInput.bind(this);
    bus.on('user:input', this._boundHandleInput, 100);
  }

  reset(): void {}
  destroy(): void {
    if (this.bus && this._boundHandleInput) {
      this.bus.off('user:input', this._boundHandleInput);
    }
    this.bus = null;
    this._boundHandleInput = null;
  }

  private handleInput = async (event: UserInputEvent): Promise<void> => {
    const text = event.payload.content;

    // 红线拦截 — 直接短路
    for (const pattern of EXTREME_REDLINE) {
      if (pattern.test(text)) {
        console.log(`[Safety] 🔴 红线拦截: traceId=${event.traceId}`);
        this.emitBlocked(event, '极端内容已拦截，如需帮助请联系专业人员');
        return;
      }
    }

    // 违禁内容拦截
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(text)) {
        console.log(`[Safety] 🟡 违禁拦截: traceId=${event.traceId}`);
        this.emitBlocked(event, '内容包含违禁词汇，请文明交流');
        return;
      }
    }
  };

  private emitBlocked(event: UserInputEvent, message: string): void {
    const output: OutputFinalizedEvent = {
      type: 'output:finalized',
      traceId: event.traceId,
      timestamp: Date.now(),
      sessionId: event.sessionId,
      payload: {
        content: message,
        renderType: 'text',
        shouldPersist: false,
      },
    };
    // 设置短路标记——后续 handler 不再执行
    (this.handleInput as any).skipRemaining = true;
    this.bus?.emit(output);
  }
}
