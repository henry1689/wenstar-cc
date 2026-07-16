/**
 * L1Sequencer — 分支路由码生成器
 *
 * v2: 计数器统一委托 GlobalSequenceCounter，移除实例级自增逻辑。
 * seq_pos 为会话内严格单调递增序列（由调用方在 resetSession 时维护）。
 *
 * branch_id 格式：evt_YYYYMMDD_N{3,4}（全局序列号，跨零点重置）
 * seq_pos 由调用方每轮对话传入。
 */
import type { L1SequenceResult } from './types/dna.js';
import { GlobalSequenceCounter } from './GlobalSequenceCounter.js';

export class L1Sequencer {
  private currentDate: string;
  private sessionSeq = 0;

  constructor() {
    this.currentDate = this.getDateString();
  }

  /**
   * 生成下一个序列值
   * counter 来自 GlobalSequenceCounter（全局唯一，持久化，跨日期自动重置）
   * seq_pos 严格按当日消息到达顺序递增
   */
  next(): L1SequenceResult {
    const today = this.getDateString();
    if (today !== this.currentDate) {
      this.currentDate = today;
    }

    // 全局计数器：按日递增，跨零点自动重置，重启不丢失
    const globalSeq = GlobalSequenceCounter.getInstance().next();
    this.sessionSeq++;
    const branchId = `evt_${today}_${String(globalSeq).padStart(3, '0')}`;

    return {
      branch_id: branchId,
      seq_pos: this.sessionSeq,
    };
  }

  /**
   * 重置序列（调用前请确认是否真正需要）
   * 注意：不会重置全局计数器（全局计数器仅跨零点重置）
   */
  reset(): void {
    this.currentDate = this.getDateString();
    this.sessionSeq = 0;
  }

  getCurrentCount(): number {
    return GlobalSequenceCounter.getInstance().current();
  }

  private getDateString(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
}
