/**
 * HippocampusRhythmCoordinator.ts — 天权海马体节律调度器 (V1.0)
 * ==============================================================
 * 将天权（在线推理）与海马体（离线巩固）统一到一个节律状态机下调度。
 *
 * 四重节律（仿人脑海马体的 θ / SWR / δ 波）：
 *
 *   THETA (θ)   — 活跃对话中       编码新记忆 + 经验检索        ~20% 算力
 *   SWR         — 用户沉寂 >30s     记忆回放 + 钙化重算 + 晋升    ~50% 算力
 *   DELTA (δ)   — 空闲 >2h / 每日   归纳 + 跨会话关联 + 归档     ~30% 算力
 *   SILENT      — 完全空闲          仅心跳检查，不执行任务           ~0%
 *
 * 使用:
 *   const hrc = new HippocampusRhythmCoordinator({ storage, m7, consolidationQueue, ... });
 *   hrc.start();  // 启动统一心跳（取代所有独立定时器）
 *
 *   // chat.ts 每轮调用:
 *   hrc.onUserMessage();       // 切 THETA，暂停离线任务
 *   // ... M1→M3→M4→M5 管线 ...
 *   hrc.afterResponse();       // 释放离线锁
 *
 * V1.0 策略：渐进式集成 — 不删除现有定时器，先加节律层并行运行。
 * V2.0 将逐步用 coordinator 的统一心跳替代独立 setInterval。
 */
import type { FusionStorageAdapter } from '../../../m2/FusionStorageAdapter.js';

// ─── 节律枚举 ───
export enum HippocampusRhythm {
  THETA  = 'theta',
  SWR    = 'swr',
  DELTA  = 'delta',
  SILENT = 'silent',
}

// ─── 组件接口 ───
export interface RhythmTask {
  name: string;
  /** 该任务在哪个节律下执行 */
  rhythm: HippocampusRhythm;
  /** 执行间隔（毫秒），0 表示每次心跳都跑 */
  intervalMs: number;
  /** 执行函数，返回实际执行了操作的数量 */
  execute: () => Promise<number>;
}

export interface RhythmComponent {
  name: string;
  tasks: RhythmTask[];
}

// ─── 调度报告 ───
export interface RhythmReport {
  currentRhythm: HippocampusRhythm;
  previousRhythm: HippocampusRhythm;
  secondsSinceLastMessage: number;
  activeTaskCount: number;
  totalTasksExecuted: number;
  lastTransitionAt: string;
}

export class HippocampusRhythmCoordinator {
  // ── 状态 ──
  private _rhythm: HippocampusRhythm = HippocampusRhythm.SILENT;
  private _prevRhythm: HippocampusRhythm = HippocampusRhythm.SILENT;
  private _lastUserMessage = Date.now();
  private _lastTransitionAt = new Date().toISOString();
  private _totalTasksExecuted = 0;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _started = false;

  // ── 注册的组件 ──
  private _components: RhythmComponent[] = [];

  // ── 离线锁：用户活跃时不跑后台 ──
  private _offlineLocked = false;

  // ── 任务防抖：记录上次执行时间 ──
  private _taskLastRun: Map<string, number> = new Map();

  // ── 心跳间隔 ──
  private readonly HEARTBEAT_MS = 10_000; // 10s
  private readonly SWR_THRESHOLD_MS = 30_000;   // 30s 沉寂 → SWR
  private readonly DELTA_THRESHOLD_MS = 2 * 3600_000; // 2h 空闲 → DELTA

  constructor(private storage: FusionStorageAdapter) {}

  // ═══════════════════════════════════════════════════════
  //  公开 API
  // ═══════════════════════════════════════════════════════

  get isStarted() { return this._started; }
  get currentRhythm() { return this._rhythm; }
  get offlineLocked() { return this._offlineLocked; }
  get secondsSinceLastMessage(): number {
    return Math.round((Date.now() - this._lastUserMessage) / 1000);
  }

  /**
   * 注册一个海马体组件
   */
  register(component: RhythmComponent): void {
    this._components.push(component);
    console.log(`[Hippocampus] 注册组件: ${component.name} (${component.tasks.length} 个任务)`);
  }

  /**
   * 启动统一心跳（替代独立定时器）
   * 在 server.ts initPipeline() 末尾调用
   */
  start(): void {
    if (this._started) return;
    this._started = true;
    this._lastUserMessage = Date.now();

    // 恢复上次活跃时间
    this._restoreLastActive();

    console.log(`[Hippocampus] 节律调度器启动 · 当前: ${this._rhythm} · 心跳: ${this.HEARTBEAT_MS}ms`);
    this._heartbeatTimer = setInterval(() => this._heartbeat(), this.HEARTBEAT_MS);
  }

  /** 停止调度器 */
  stop(): void {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    this._started = false;
    console.log('[Hippocampus] 调度器已停止');
  }

  // ═══════════════════════════════════════════════════════
  //  chat.ts 调用 — 在线管线入口
  // ═══════════════════════════════════════════════════════

  /**
   * 用户发消息时调用（chat.ts 流程开始）
   * → 立即切 THETA 节律
   * → 加离线锁，暂停所有后台巩固任务
   * → 持久化活跃时间戳
   */
  onUserMessage(): void {
    this._lastUserMessage = Date.now();
    this._offlineLocked = true;
    this._persistLastActive();
    this._transitionTo(HippocampusRhythm.THETA);
  }

  /**
   * 回复生成完成后调用（chat.ts 流程结束）
   * → 解除离线锁
   * → 按需切 SWR（如果已沉寂超过阈值）
   */
  afterResponse(): void {
    this._offlineLocked = false;
    this._evaluateRhythm();
  }

  /**
   * 记录活跃时间（兼容旧接口 — SleepTimeConsolidator.recordActivity）
   */
  recordActivity(): void {
    this._lastUserMessage = Date.now();
    this._persistLastActive();
  }

  // ═══════════════════════════════════════════════════════
  //  报告
  // ═══════════════════════════════════════════════════════

  getReport(): RhythmReport {
    return {
      currentRhythm: this._rhythm,
      previousRhythm: this._prevRhythm,
      secondsSinceLastMessage: this.secondsSinceLastMessage,
      activeTaskCount: this._getTasksForCurrentRhythm().length,
      totalTasksExecuted: this._totalTasksExecuted,
      lastTransitionAt: this._lastTransitionAt,
    };
  }

  /** 打印当前状态 */
  logStatus(): void {
    const r = this.getReport();
    const lockIcon = this._offlineLocked ? '🔒' : '🔓';
    console.log(`[Hippocampus] ${lockIcon} ${r.currentRhythm} | 距上次消息: ${r.secondsSinceLastMessage}s | 活跃任务: ${r.activeTaskCount} | 累计执行: ${r.totalTasksExecuted}`);
  }

  // ═══════════════════════════════════════════════════════
  //  内部 — 心跳循环
  // ═══════════════════════════════════════════════════════

  private async _heartbeat(): Promise<void> {
    if (!this._started) return;
    try {
      // 1. 评估是否需要切换节律
      this._evaluateRhythm();

      // 2. 离线锁检查：用户活跃时只跑 THETA，不跑后台
      if (this._offlineLocked && this._rhythm !== HippocampusRhythm.THETA) {
        return; // 锁未释放，跳过
      }

      // 3. 执行当前节律的任务
      const tasks = this._getTasksForCurrentRhythm();
      for (const task of tasks) {
        if (this._offlineLocked && task.rhythm !== HippocampusRhythm.THETA) continue; // 加锁后跳过离线任务

        // 防抖：检查间隔
        const lastRun = this._taskLastRun.get(task.name) || 0;
        if (task.intervalMs > 0 && Date.now() - lastRun < task.intervalMs) continue;

        try {
          const count = await task.execute();
          this._taskLastRun.set(task.name, Date.now());
          if (count > 0) {
            this._totalTasksExecuted++;
          }
        } catch (err) {
          // 单个任务失败不阻塞心跳
        }
      }
    } catch (err) {
      console.warn('[Hippocampus] 心跳异常:', err);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  节律切换
  // ═══════════════════════════════════════════════════════

  private _evaluateRhythm(): void {
    const idle = Date.now() - this._lastUserMessage;

    if (idle < this.SWR_THRESHOLD_MS) {
      this._transitionTo(HippocampusRhythm.THETA);
    } else if (idle < this.DELTA_THRESHOLD_MS) {
      this._transitionTo(HippocampusRhythm.SWR);
    } else {
      this._transitionTo(HippocampusRhythm.DELTA);
    }
  }

  private _transitionTo(newRhythm: HippocampusRhythm): void {
    if (this._rhythm === newRhythm) return;
    this._prevRhythm = this._rhythm;
    this._rhythm = newRhythm;
    this._lastTransitionAt = new Date().toISOString();

    const idleMin = Math.round((Date.now() - this._lastUserMessage) / 60000);
    console.log(`[Hippocampus] 节律切换: ${this._prevRhythm} → ${newRhythm} (空闲 ${idleMin}min)`);

    // 进入 THETA 时加锁，防止离线任务干扰
    if (newRhythm === HippocampusRhythm.THETA) {
      this._offlineLocked = true;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  任务匹配
  // ═══════════════════════════════════════════════════════

  private _getTasksForCurrentRhythm(): RhythmTask[] {
    const tasks: RhythmTask[] = [];
    for (const comp of this._components) {
      for (const task of comp.tasks) {
        if (task.rhythm === this._rhythm) {
          tasks.push(task);
        }
      }
    }
    return tasks;
  }

  // ═══════════════════════════════════════════════════════
  //  持久化
  // ═══════════════════════════════════════════════════════

  private _persistLastActive(): void {
    try {
      this.storage.getSQLite()?.writeRaw(
        "INSERT OR REPLACE INTO engine_store (key, value) VALUES ('last_active_time', ?)",
        [String(this._lastUserMessage)]
      );
    } catch (e) { console.warn(`[HippocampusRhythm] 操作失败`, (e as Error)?.message || e); }
  }

  private _restoreLastActive(): void {
    try {
      const rows = this.storage.getSQLite()?.queryAll(
        "SELECT value FROM engine_store WHERE key = 'last_active_time' LIMIT 1"
      );
      if (rows && rows.length > 0) {
        const ts = Number((rows[0] as any).value);
        if (ts > 0) this._lastUserMessage = ts;
      }
    } catch (e) { console.warn(`[HippocampusRhythm] 操作失败`, (e as Error)?.message || e); }
  }
}

// ═══════════════════════════════════════════════════════
//  单例
// ═══════════════════════════════════════════════════════

let _globalCoordinator: HippocampusRhythmCoordinator | null = null;

export function getHippocampusCoordinator(): HippocampusRhythmCoordinator | null {
  return _globalCoordinator;
}

export function initHippocampusCoordinator(storage: FusionStorageAdapter): HippocampusRhythmCoordinator {
  if (!_globalCoordinator) {
    _globalCoordinator = new HippocampusRhythmCoordinator(storage);
  }
  return _globalCoordinator;
}
