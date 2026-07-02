/**
 * Hooks — 数据上报队列
 *
 * S3.2 批量异步推送 + 本地文件兜底
 * - 触发条件：满 50 条或 5 秒时间窗口，任一满足即推
 * - 后台不可用时写本地 backlog 文件
 * - 启动时自动补发 backlog
 */
import type { HookEvent } from './types.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const HOOKS_API = 'http://localhost:3000/_hooks/ingest';
const BATCH_SIZE = 50;
const FLUSH_INTERVAL = 5000;
// 改造④：不在模块级读 process.env，使用函数运行时获取
function getBacklogDir(): string {
  const dataDir = process.env.DATA_DIR || '';
  return dataDir
    ? join(dataDir, 'hooks', 'backlog')
    : join(process.cwd(), 'data', 'webui', 'hooks', 'backlog');
}

class HookQueue {
  private buffer: HookEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  /** 推入一条事件 */
  async push(event: HookEvent): Promise<void> {
    this.buffer.push(event);

    if (this.buffer.length >= BATCH_SIZE) {
      await this.flush();
    } else if (!this.timer) {
      // 首次 push 时启动定时器
      this.timer = setInterval(() => {
        if (this.buffer.length > 0) this.flush();
      }, FLUSH_INTERVAL);
    }
  }

  /** 强制刷出缓冲区 */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    const batch = this.buffer.splice(0, BATCH_SIZE);
    try {
      const res = await fetch(HOOKS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // 后台不可用 → 本地落盘兜底
      await this.writeBacklog(batch);
    }

    if (this.buffer.length >= BATCH_SIZE) {
      this.flushing = false;
      await this.flush();
    } else {
      this.flushing = false;
    }
  }

  /** 本地落盘 */
  private async writeBacklog(events: HookEvent[]): Promise<void> {
    try {
      if (!existsSync(getBacklogDir())) mkdirSync(getBacklogDir(), { recursive: true });
      const filePath = join(getBacklogDir(), `hook_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jsonl`);
      const lines = events.map(e => JSON.stringify(e)).join('\n');
      appendFileSync(filePath, lines + '\n');
    } catch (e: any) { console.error('[HooksQueue] error:', e?.message); }
  }

  /** 启动时补发 backlog */
  async replayBacklog(): Promise<void> {
    try {
      if (!existsSync(getBacklogDir())) return;
      const files = readdirSync(getBacklogDir()).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        try {
          const data = readFileSync(join(getBacklogDir(), f), 'utf-8');
          const events = data.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
          const res = await fetch(HOOKS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(events),
          });
          if (res.ok) unlinkSync(join(getBacklogDir(), f));
        } catch { /* 补发失败下次再试 */ }
      }
    } catch (e: any) { console.error('[HooksQueue] error:', e?.message); }
  }

  /** 获取缓冲区大小 */
  size(): number { return this.buffer.length; }
}

let _instance: HookQueue | null = null;

export function getQueue(): HookQueue {
  if (!_instance) _instance = new HookQueue();
  return _instance;
}
