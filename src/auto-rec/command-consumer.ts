/**
 * AutoRec — 指令消费者
 *
 * S4.4 轮询 hooks_commands 中的 pending 指令 → 执行 → 回写
 * 启动后每 10 秒拉取一次
 */
import type { SQLiteAdapter } from '../m2/SQLiteAdapter.js';
import { getPendingCommands, updateCommandStatus } from '../hooks/backend.js';
import type { Command } from '../hooks/backend.js';

export class CommandConsumer {
  private sqlite: SQLiteAdapter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
  }

  /** 启动轮询（每 10 秒） */
  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), intervalMs);
    // 首次立即执行
    this.poll();
    console.log('[CommandConsumer] 已启动 (10s轮询)');
  }

  /** 停止轮询 */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 轮询一次：取 pending 指令并执行 */
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cmds = getPendingCommands(this.sqlite);
      for (const cmd of cmds) {
        await this.execute(cmd);
      }
    } catch (err) {
      console.warn('[CommandConsumer] 轮询失败:', err);
    } finally {
      this.running = false;
    }
  }

  /** 执行单条指令 */
  async execute(cmd: Command): Promise<void> {
    console.log(`[CommandConsumer] 执行: ${cmd.command_type} | ${cmd.target_dna || ''}`);
    updateCommandStatus(this.sqlite, cmd.id, 'dispatched');

    try {
      switch (cmd.command_type) {
        case 'promote':
          await this.execPromote(cmd);
          break;
        case 'clean':
          await this.execClean(cmd);
          break;
        case 'reindex':
          await this.execReindex(cmd);
          break;
        default:
          console.warn(`[CommandConsumer] 未知指令类型: ${cmd.command_type}`);
      }
      updateCommandStatus(this.sqlite, cmd.id, 'done');
    } catch (err) {
      console.warn(`[CommandConsumer] 执行失败 ${cmd.id}:`, err);
      updateCommandStatus(this.sqlite, cmd.id, 'failed');
    }
  }

  private async execPromote(cmd: Command): Promise<void> {
    const { promoteToBlackDiamond } = await import('../app/vault/VaultManager.js');
    if (!cmd.target_dna) return;
    promoteToBlackDiamond(this.sqlite, cmd.target_dna);
  }

  private async execClean(cmd: Command): Promise<void> {
    const ids = cmd.payload?.memoryIds as string[] | undefined;
    if (!ids || ids.length === 0) return;
    for (const id of ids) {
      this.sqlite.writeRaw("DELETE FROM memories WHERE id = ? AND promoted_to_diamond IS NULL", id);
    }
    console.log(`[CommandConsumer] 清理完成: ${ids.length} 条`);
  }

  private async execReindex(_cmd: Command): Promise<void> {
    console.log('[CommandConsumer] 重索引指令已收到，等待调度');
    // 实际重索引逻辑由 AutoRec 的 vector-align 模块负责
  }
}
