/**
 * CommunicationModeRouter — 通信模式纯规则路由器
 *
 * 脑干反射层，订阅 user:input 事件。
 * 纯规则检测，零 LLM 调用，毫秒级。
 *
 * 优先级 180（介于 SafetyInterceptor 100 和 L0Classifier 200 之间）
 */
import type { IEventBus, ILifecycle, IStorageProvider } from '../types.js';
import type { UserInputEvent } from '../bus/types.js';
import { CommunicationModeStore } from './CommunicationModeStore.js';
import { EngineContext } from '../EngineContext.js';

export class CommunicationModeRouter implements ILifecycle {
  private bus: IEventBus | null = null;
  private _boundHandleInput: ((event: any) => void) | null = null;
  private store: CommunicationModeStore;

  constructor(store: CommunicationModeStore) {
    this.store = store;
  }

  async init(bus: IEventBus, _storage?: IStorageProvider): Promise<void> {
    this.bus = bus;
    await this.store.init(_storage);
    this._boundHandleInput = this.handleInput.bind(this);
    bus.on('user:input', this._boundHandleInput, 180);
  }

  reset(): void { this.store.reset(); }
  destroy(): void {
    if (this.bus && this._boundHandleInput) {
      this.bus.off('user:input', this._boundHandleInput);
    }
    this.bus = null;
    this._boundHandleInput = null;
  }

  /** 获取当前模式 */
  getMode(): string {
    return this.store.getMode();
  }

  getModeLabel(): string {
    return this.store.getModeLabel();
  }

  private handleInput = async (event: UserInputEvent): Promise<void> => {
    const mode = this.store.detect(event.payload.content);
    EngineContext.setCommMode(mode);
    if (mode !== 'face_to_face') {
      console.log(`[CommMode] ${this.store.getModeLabel()} (from: "${event.payload.content.substring(0, 30)}")`);
    }
  };
}
