/**
 * TimerRegistry — 定时任务队列
 *
 * 持久化定时任务，重启智脑不丢失待回访任务。
 * 支持三种触发类型：延迟毫秒、指定时间、次日指定时间。
 *
 * 冲突规则：
 * - 计时期间用户主动发消息 → 取消当前定时
 * - 免打扰时段 → 转为静默消息
 * - 快照 TTL 衰减：长间隔任务触发时，上下文做降级处理
 */
import type { IStorageProvider, IEventBus } from '../../types.js';
import type { TimerTask, TimerTriggerType, TimerTaskStatus, TemporalConfig } from './base-types.js';
import { TimeKeeper } from './TimeKeeper.js';

const STORAGE_PREFIX = 'timer_registry_';

export class TimerRegistry {
  private storage: IStorageProvider;
  private bus: IEventBus | null = null;
  private timeKeeper: TimeKeeper;
  private activeTimers = new Map<string, NodeJS.Timeout>();
  private initialized = false;

  constructor(config: TemporalConfig, timeKeeper: TimeKeeper) {
    this.storage = config.storage;
    this.timeKeeper = timeKeeper;
  }

  setBus(bus: IEventBus): void {
    this.bus = bus;
  }

  async init(): Promise<void> {
    this.initialized = true;
    // 启动时扫描未完成的任务并重新注册
    const tasks = await this.loadAllTasks();
    let restored = 0;
    for (const task of tasks) {
      if (task.status === 'pending' && task.triggerAt > Date.now()) {
        this.registerTimer(task);
        restored++;
      } else if (task.status === 'pending') {
        // 已过期的任务直接标记完成
        task.status = 'completed';
        await this.saveTask(task);
      }
    }
    console.log(`[TimerRegistry] 初始化完成 (恢复${restored}个定时任务)`);
  }

  reset(): void {
    // 清除所有活跃定时器
    for (const [id, timer] of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
  }

  destroy(): void {
    this.reset();
  }

  /**
   * 创建定时任务
   */
  async createTask(params: {
    /** 延迟毫秒 / 指定时间 / 次日指定 */
    triggerType: TimerTriggerType;
    /** triggerType=delay_ms 时使用 */
    delayMs?: number;
    /** triggerType=specific_time 或 next_day 时使用 */
    hour?: number;
    minute?: number;
    /** 上下文快照 */
    contextSnapshot: string;
    sessionId: string;
  }): Promise<string> {
    let triggerAt: number;
    const now = Date.now();

    switch (params.triggerType) {
      case 'delay_ms':
        triggerAt = now + (params.delayMs ?? 60000);
        break;
      case 'specific_time':
        triggerAt = now + this.timeKeeper.msUntil(params.hour ?? 0, params.minute ?? 0);
        break;
      case 'next_day':
        triggerAt = now + this.timeKeeper.msUntil(params.hour ?? 8, params.minute ?? 0) + 86400000;
        break;
      default:
        triggerAt = now + 60000;
    }

    // 快照 TTL：超过 1 小时的定时任务，上下文降级
    const delayHours = (triggerAt - now) / 3600000;
    const snapshotTTL = delayHours > 1 ? Math.min(delayHours * 30, 100) : 100; // 百分比保留

    const id = `timer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const task: TimerTask = {
      id,
      sessionId: params.sessionId,
      triggerType: params.triggerType,
      triggerAt,
      contextSnapshot: params.contextSnapshot,
      snapshotTTL,
      status: 'pending',
      createdAt: new Date().toISOString(),
      doNotDisturb: this.timeKeeper.isDoNotDisturb(),
    };

    await this.saveTask(task);
    this.registerTimer(task);
    return id;
  }

  /**
   * 取消定时任务
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = await this.loadTask(taskId);
    if (!task) return false;

    task.status = 'cancelled';
    await this.saveTask(task);

    const timer = this.activeTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(taskId);
    }
    return true;
  }

  /**
   * 取消当前会话的所有定时任务（由 EventBus 监听 user:input 触发）
   */
  async cancelSessionTasks(sessionId: string): Promise<number> {
    const tasks = await this.loadAllTasks();
    let cancelled = 0;
    for (const task of tasks) {
      if (task.sessionId === sessionId && task.status === 'pending') {
        await this.cancelTask(task.id);
        cancelled++;
      }
    }
    return cancelled;
  }

  /**
   * 获取当前会话待处理任务
   */
  async getPendingTasks(sessionId: string): Promise<TimerTask[]> {
    const all = await this.loadAllTasks();
    return all.filter(t => t.sessionId === sessionId && t.status === 'pending');
  }

  // ── 内部方法 ──

  private registerTimer(task: TimerTask): void {
    const delay = Math.max(0, task.triggerAt - Date.now());
    const timer = setTimeout(async () => {
      this.activeTimers.delete(task.id);

      // 免打扰检查
      if (this.timeKeeper.isDoNotDisturb()) {
        task.status = 'silent';
        console.log(`[TimerRegistry] 免打扰时段，转为静默: ${task.id}`);
      } else {
        task.status = 'completed';
        // 发出定时到期事件（由 orchestrator 处理主动推送）
        this.bus?.emit({
          type: 'timer:expired',
          traceId: `timer_${task.id}`,
          timestamp: Date.now(),
          sessionId: task.sessionId,
          payload: {
            taskId: task.id,
            contextSnapshot: task.contextSnapshot,
            snapshotTTL: task.snapshotTTL,
          },
        } as any);
      }
      await this.saveTask(task);
    }, delay);

    this.activeTimers.set(task.id, timer);
  }

  private async saveTask(task: TimerTask): Promise<void> {
    try {
      await this.storage.set(`${STORAGE_PREFIX}${task.id}`, task);
    } catch (e: any) { console.error('[TimerRegistry] error:', e?.message); }
  }

  private async loadTask(id: string): Promise<TimerTask | null> {
    try {
      return await this.storage.get<TimerTask>(`${STORAGE_PREFIX}${id}`);
    } catch { return null; }
  }

  private async loadAllTasks(): Promise<TimerTask[]> {
    try {
      const rows = await this.storage.query<{ value: string }>(
        "SELECT value FROM engine_store WHERE key LIKE 'timer_registry_%'"
      );
      return rows.map(r => JSON.parse(r.value)).filter(Boolean);
    } catch { return []; }
  }
}
