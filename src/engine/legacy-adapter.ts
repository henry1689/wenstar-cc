/**
 * LegacyAdapter — 现有 processChat 适配器
 *
 * 把现有 processChat 包一层，跑在 EventBus 上。
 * 订阅 user:input → 调用原 processChat → 发布 output:finalized
 * 保证现有功能完全不受影响。
 */
import type { IEventBus, ILifecycle, IStorageProvider } from './types.js';
import type { OutputFinalizedEvent, UserInputEvent } from './bus/types.js';

interface ProcessChatFn {
  (message: string, clientMsgId?: string, testMode?: boolean): Promise<{
    reply: string;
    audio_url?: string;
    usage?: { prompt: number; completion: number };
    client_msg_id?: string;
  }>;
}

export class LegacyAdapter implements ILifecycle {
  private bus: IEventBus | null = null;
  private _boundHandleInput: ((event: any) => void) | null = null;
  private processChat: ProcessChatFn | null = null;

  async init(bus: IEventBus, _storage?: IStorageProvider): Promise<void> {
    this.bus = bus;
    this._boundHandleInput = this.handleInput.bind(this);
    bus.on('user:input', this._boundHandleInput, 500);
  }

  /** 注入 processChat 函数（从 server.ts 传入） */
  setProcessChat(fn: ProcessChatFn): void {
    this.processChat = fn;
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
    if (!this.processChat) return;

    try {
      const result = await this.processChat(event.payload.content, event.payload.clientMsgId, event.payload.testMode);

      const output: OutputFinalizedEvent = {
        type: 'output:finalized',
        traceId: event.traceId,
        timestamp: Date.now(),
        sessionId: event.sessionId,
        payload: {
          content: result.reply,
          renderType: 'text',
          shouldPersist: true,
        },
      };
      this.bus?.emit(output);
    } catch (err) {
      console.error(`[LegacyAdapter] processChat 失败:`, err);
      const errorOutput: OutputFinalizedEvent = {
        type: 'output:finalized',
        traceId: event.traceId,
        timestamp: Date.now(),
        sessionId: event.sessionId,
        payload: {
          content: '抱歉，我暂时无法处理你的请求。',
          renderType: 'text',
          shouldPersist: false,
        },
      };
      this.bus?.emit(errorOutput);
    }
  };
}
