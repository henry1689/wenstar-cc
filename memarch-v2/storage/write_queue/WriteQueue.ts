/**
 * MemArch-v2.0.0 / M1-Storage / WriteQueue
 * SQLite 单写者统一队列
 *
 * 规则（任务书 §3.3）：
 *   - 所有写操作必须经过本队列，禁止业务代码直接 db.run()
 *   - 在线写入（priority=high）优先于批量迁移（priority=low）
 *   - 睡眠流水线按 ≤200 行小事务分批提交
 *   - 对外接口严格遵循主文档第十六章 16.2 节：
 *       writeConversation(entry): number
 *       writeTrace(row): string
 *       pushWorkingBuffer(payload): number
 */

import type Database from 'better-sqlite3';

export type WritePriority = 'high' | 'normal' | 'low';

interface WriteTask {
  priority: WritePriority;
  fn: (db: Database.Database) => unknown;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  enqueuedAt: number;
}

const BATCH_THRESHOLD = 200; // 任务书硬性要求：睡眠流水线小事务 ≤200 行

export class WriteQueue {
  private queue: WriteTask[] = [];
  private running = false;
  private batchSize = 0;

  constructor(private readonly db: Database.Database) {
    // 开启 WAL（在连接层已设，此处幂等兜底）
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
  }

  /** 入队一个写任务 */
  enqueue<T>(fn: (db: Database.Database) => T, priority: WritePriority = 'normal'): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        priority,
        fn: fn as WriteTask['fn'],
        resolve: resolve as WriteTask['resolve'],
        reject,
        enqueuedAt: Date.now(),
      });
      // 延迟到微任务调度 drain：让同一次同步调用里连续 enqueue 的多个任务
      // 先全部入队，再按优先级统一出队，避免"入队即执行"导致优先级失效
      queueMicrotask(() => this.drain());
    }) as Promise<T>;
  }

  /** 按优先级出队：high > normal > low；同级 FIFO */
  private pop(): WriteTask | undefined {
    const order: WritePriority[] = ['high', 'normal', 'low'];
    for (const p of order) {
      const idx = this.queue.findIndex((t) => t.priority === p);
      if (idx >= 0) return this.queue.splice(idx, 1)[0];
    }
    return undefined;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const task = this.pop()!;
        try {
          // 小事务批量阈值控制：high/normal 单条立即提交；
          // low（批量迁移/睡眠）由调用方在 fn 内部自行 BEGIN/COMMIT ≤200 行
          const result = task.fn(this.db);
          task.resolve(result);
        } catch (err) {
          task.reject(err as Error);
        }
      }
    } finally {
      this.running = false;
      this.batchSize = 0;
    }
  }

  // ===== 第十六章 16.2 节冻结接口（M1 → M2 数据访问接口） =====

  /** 写入 conversations，返回 rowid */
  writeConversation(entry: {
    message_id: string;
    namespace?: string;
    roleplay_char?: string;
    role: string;
    content: string;
    ts_utc: number;
    episode_id?: string;
    sensitivity?: number;
  }): Promise<number> {
    return this.enqueue((db) => {
      const stmt = db.prepare(`
        INSERT INTO conversations
          (message_id, namespace, roleplay_char, role, content, ts_utc, episode_id, sensitivity, created_at)
        VALUES
          (@message_id, @namespace, @roleplay_char, @role, @content, @ts_utc, @episode_id, @sensitivity, @ts_utc)
      `);
      const info = stmt.run({
        message_id: entry.message_id,
        namespace: entry.namespace ?? 'default',
        roleplay_char: entry.roleplay_char ?? null,
        role: entry.role,
        content: entry.content,
        ts_utc: entry.ts_utc,
        episode_id: entry.episode_id ?? null,
        sensitivity: entry.sensitivity ?? 0,
      });
      return Number(info.lastInsertRowid);
    }, 'high');
  }

  /** 写入 memories（L3 痕迹），返回 trace_id */
  writeTrace(row: {
    id: string;
    namespace?: string;
    raw_input?: string;
    summary?: string;
    episode_id?: string;
    sensitivity?: number;
    created_at: number;
  }): Promise<string> {
    return this.enqueue((db) => {
      db.prepare(`
        INSERT INTO memories (id, namespace, raw_input, summary, episode_id, sensitivity, created_at)
        VALUES (@id, @namespace, @raw_input, @summary, @episode_id, @sensitivity, @created_at)
      `).run({
        id: row.id,
        namespace: row.namespace ?? 'default',
        raw_input: row.raw_input ?? null,
        summary: row.summary ?? null,
        episode_id: row.episode_id ?? null,
        sensitivity: row.sensitivity ?? 0,
        created_at: row.created_at,
      });
      return row.id;
    }, 'high');
  }

  /** 写入 wm_buffer，返回 buffer_id */
  pushWorkingBuffer(payload: string): Promise<number> {
    return this.enqueue((db) => {
      const info = db.prepare(`
        INSERT INTO wm_buffer (payload, status, ts_utc)
        VALUES (?, 'pending', ?)
      `).run(payload, Date.now());
      return Number(info.lastInsertRowid);
    }, 'high');
  }

  /**
   * 批量执行（睡眠/迁移专用，priority=low）
   * 自动按 ≤200 行分批 COMMIT
   */
  batch<T>(rows: T[], handler: (db: Database.Database, chunk: T[]) => void): Promise<void> {
    return this.enqueue((db) => {
      for (let i = 0; i < rows.length; i += BATCH_THRESHOLD) {
        const chunk = rows.slice(i, i + BATCH_THRESHOLD);
        db.transaction(() => handler(db, chunk))();
      }
    }, 'low');
  }

  /** 队列深度（Harness 监管指标） */
  depth(): number {
    return this.queue.length;
  }
}
