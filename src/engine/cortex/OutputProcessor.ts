/**
 * OutputProcessor — 输出处理器
 *
 * 接收 generation:result → 格式化 → 发布 output:finalized
 * 异步副作用队列：记忆写入/状态持久化/埋点统一入队，不阻塞主响应
 */
import type { IEventBus, ILifecycle, IStorageProvider } from '../types.js';
import type { GenerationResultEvent, OutputFinalizedEvent } from '../bus/types.js';

interface AsyncTask {
  id: string;
  fn: () => Promise<void>;
  retries: number;
  maxRetries: number;
}

export class OutputProcessor implements ILifecycle {
  private bus: IEventBus | null = null;
  private _boundOnGenerationResult: ((event: any) => void) | null = null;
  private storage: IStorageProvider | null = null;
  private taskQueue: AsyncTask[] = [];
  private processing = false;

  async init(bus: IEventBus, storage?: IStorageProvider): Promise<void> {
    this.bus = bus;
    this.storage = storage ?? null;
    this._boundOnGenerationResult = this.onGenerationResult.bind(this);
    bus.on('generation:result', this._boundOnGenerationResult, 500);
  }

  reset(): void {
    this.taskQueue = [];
  }

  destroy(): void {
    if (this.bus && this._boundOnGenerationResult) {
      this.bus.off('generation:result', this._boundOnGenerationResult);
    }
    this.bus = null;
    this.storage = null;
    this._boundOnGenerationResult = null;
  }

  private onGenerationResult = async (event: GenerationResultEvent): Promise<void> => {
    const output: OutputFinalizedEvent = {
      type: 'output:finalized',
      traceId: event.traceId,
      timestamp: Date.now(),
      sessionId: event.sessionId,
      payload: {
        content: event.payload.content,
        renderType: 'text',
        shouldPersist: true,
      },
    };

    // 主响应——先发出
    this.bus?.emit(output);

    // 异步副作用——入队不阻塞
    this.enqueue({
      id: `persist-${event.traceId}`,
      fn: async () => {
        if (this.storage) {
          // S2: 调用记忆写入 + 状态持久化
        }
      },
      retries: 0,
      maxRetries: 3,
    });
  };

  /** 入队异步任务 */
  enqueue(task: AsyncTask): void {
    this.taskQueue.push(task);
    this.processQueue();
  }

  /** 处理队列（失败自动重试 3 次） */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift()!;
      try {
        await task.fn();
      } catch (err) {
        if (task.retries < task.maxRetries) {
          task.retries++;
          // 指数退避
          await new Promise(r => setTimeout(r, 100 * Math.pow(2, task.retries)));
          this.taskQueue.unshift(task);
        } else {
          console.error(`[OutputProcessor] 任务失败, 已达最大重试: ${task.id}`, err);
        }
      }
    }

    this.processing = false;
  }
}
