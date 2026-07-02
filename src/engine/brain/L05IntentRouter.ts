/**
 * L05IntentRouter — 脑干反射层·意图路由
 *
 * 纯规则，零 LLM，毫秒级。
 * 读取 intentRules.ts 配置，遍历匹配。
 * 输出 subIntent + shouldBypassLLM 标记。
 */
import type { IEventBus, ILifecycle, IStorageProvider } from '../types.js';
import type { IntentClassifiedEvent } from '../bus/types.js';
import { INTENT_RULES, type IntentRule } from './intentRules.js';

export class L05IntentRouter implements ILifecycle {
  private bus: IEventBus | null = null;
  private _boundHandleIntent: ((event: any) => void) | null = null;

  async init(bus: IEventBus, _storage?: IStorageProvider): Promise<void> {
    this.bus = bus;
    this._boundHandleIntent = this.handleIntent.bind(this);
    bus.on('intent:classified', this._boundHandleIntent, 300);
  }

  reset(): void {}
  destroy(): void {
    if (this.bus && this._boundHandleIntent) {
      this.bus.off('intent:classified', this._boundHandleIntent);
    }
    this.bus = null;
    this._boundHandleIntent = null;
  }

  private handleIntent = async (event: IntentClassifiedEvent): Promise<void> => {
    const text = event.payload.rawInput;

    for (const rule of INTENT_RULES) {
      const matched = this.matchRule(text, rule);
      if (matched) {
        console.log(`[L05] 命中规则: ${rule.id} -> ${rule.intent}/${rule.subIntent ?? '-'} (bypass=${rule.bypassLLM})`);

        // 更新事件 payload（路由信息附加到原有事件）
        const updated: IntentClassifiedEvent = {
          ...event,
          payload: {
            ...event.payload,
            intent: rule.intent,
            subIntent: rule.subIntent,
            shouldBypassLLM: rule.bypassLLM ?? false,
          },
        };

        // 如果 shouldBypassLLM，设置短路标记
        if (rule.bypassLLM) {
          (this.handleIntent as any).skipRemaining = true;
        }

        this.bus?.emit(updated);
        return;
      }
    }

    // 无规则命中——保持原分类不变
  };

  private matchRule(text: string, rule: IntentRule): boolean {
    if (rule.pattern instanceof RegExp) {
      return rule.pattern.test(text);
    }
    if (Array.isArray(rule.pattern)) {
      return rule.pattern.some(p => p.test(text));
    }
    return false;
  }
}
