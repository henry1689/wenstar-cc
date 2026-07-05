/**
 * GlobalSequenceCounter — 全局单日流水计数器
 *
 * 全系统唯一自增计数器出口，替代 L1Sequencer 实例计数器和 DNAEncoder._dailySeq。
 * 按自然日归零，数据持久化到文件，重启不丢失。
 *
 * 设计原则：
 * - 单例模式，全局唯一实例
 * - 文件持久化，重启后从断点续计
 * - 跨零点自动归零
 * - 线程安全（Node.js 单线程天然安全）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COUNTER_DIR = join(__dirname, '..', '..', 'data', 'system');
const COUNTER_PATH = join(COUNTER_DIR, 'sequence_counter.json');

interface CounterState {
  /** 当前日期 YYYYMMDD */
  date: string;
  /** 当日已分配的序号（从0开始，next()返回+1） */
  counter: number;
}

export class GlobalSequenceCounter {
  private static instance: GlobalSequenceCounter;
  private state: CounterState;
  private initialized = false;

  private constructor() {
    this.state = { date: '', counter: 0 };
  }

  static getInstance(): GlobalSequenceCounter {
    if (!GlobalSequenceCounter.instance) {
      GlobalSequenceCounter.instance = new GlobalSequenceCounter();
    }
    return GlobalSequenceCounter.instance;
  }

  /** 初始化：从持久化文件恢复状态 */
  init(): void {
    if (this.initialized) return;
    try {
      if (!existsSync(COUNTER_DIR)) {
        mkdirSync(COUNTER_DIR, { recursive: true });
      }
      if (existsSync(COUNTER_PATH)) {
        const raw = readFileSync(COUNTER_PATH, 'utf-8');
        this.state = JSON.parse(raw);
      }
    } catch (err) {
      console.warn('[GlobalSequenceCounter] 读取持久化失败，从0开始:', (err as Error).message);
    }
    this.initialized = true;
  }

  /**
   * 获取下一个序号
   * 跨零点自动重置计数器
   * @param now 可选时间（默认当前时间）
   * @returns 当日唯一递增序号（从1开始）
   */
  next(now?: Date): number {
    const d = now ?? new Date();
    const today = this.dateKey(d);

    if (this.state.date !== today) {
      this.state.date = today;
      this.state.counter = 0;
    }

    this.state.counter++;
    this.persist();
    return this.state.counter;
  }

  /**
   * 获取当前序号（不递增）
   */
  current(): number {
    return this.state.counter;
  }

  /** 获取当前日期键 */
  private dateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  private persist(): void {
    try {
      writeFileSync(COUNTER_PATH, JSON.stringify(this.state), 'utf-8');
    } catch (err) {
      console.warn('[GlobalSequenceCounter] 持久化失败:', (err as Error).message);
    }
  }
}
