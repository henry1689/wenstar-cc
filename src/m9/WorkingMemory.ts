/**
 * M9 WorkingMemory — 工作记忆缓冲（唯一 M2 写入入口）
 *
 * v2:
 * - 修复 P0: calciumLevel ≥ 0.3 → calciumScore ≥ 0.3（毕业条件）
 * - 修复 P0: cycleCount 在 consolidation 中递增，支持 staged 毕业
 * - 修复 P1: primaryEmotion/secondaryEmotions 存入 WorkingEntry
 * - 修复 P1: 缓冲区丢弃时记录日志（数量+摘要）
 */
import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';
import type { Perception24D } from '../m3/types/perception.js';
import type { DNA } from '../m1/types/dna.js';
import type { WriteResult } from '../m2/types/index.js';
import { PerceptionAnalyzer } from '../m3/PerceptionAnalyzer.js';

interface WorkingEntry {
  dna: DNA;
  perception: Perception24D;
  calciumScore: number;
  calciumLevel: number;
  seqPos: number;
  cycleCount: number;
  hasMeaningfulEntity: boolean;
  createdAt: number;
  /** P2: M3 情绪标签 */
  primaryEmotion?: string;
  secondaryEmotions?: string[];
}

export class MemoryWriteBuffer {
  /** R6: 当前对话角色标签（用于记忆定向过滤） */
  static currentTag: string | null = null;

  private buffer: WorkingEntry[] = [];
  private maxSize: number;
  private storage: FusionStorageAdapter;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private _consolidating = false;
  private _pendingConsolidate = false;

  constructor(storage: FusionStorageAdapter, maxSize = 50) {
    this.storage = storage;
    this.maxSize = maxSize;
  }

  startFlushTimer(intervalMs = 60_000): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(async () => {
      if (this.buffer.length > 0) {
        await this.consolidateSafe();
      }
    }, intervalMs);
  }

  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async consolidateSafe(): Promise<void> {
    if (this._consolidating) {
      this._pendingConsolidate = true;
      return;
    }
    this._consolidating = true;
    try {
      const results = await this.consolidate();
      if (results.length > 0) {
        console.log(`[WM] 刷出: ${results.length} 条`);
      }
    } finally {
      this._consolidating = false;
      if (this._pendingConsolidate) {
        this._pendingConsolidate = false;
        await this.consolidateSafe();
      }
    }
  }

  /**
   * 推入一条新记录
   * @param seqPos 由 FusionStorageAdapter.reserveNextSeq() 预分配的位置
   */
  push(dna: DNA, perception: Perception24D, seqPos: number, primaryEmotion?: string, secondaryEmotions?: string[]): void {
    const calcium = PerceptionAnalyzer.recalculateCalcium(perception);
    const meaningful = dna.entity_genes.some(g =>
      g.type !== 'self' && g.name.length > 0
    );

    const entry: WorkingEntry = {
      dna,
      perception,
      calciumScore: calcium.score,
      calciumLevel: calcium.level,
      seqPos,
      cycleCount: 0,
      hasMeaningfulEntity: meaningful,
      createdAt: Date.now(),
      // P1: 存储情绪标签（供后续 writeEntry 使用）
      primaryEmotion,
      secondaryEmotions,
    };

    const tier = this.shouldGraduate(entry);
    if (tier === 'full') {
      entry.dna.seq_pos = entry.seqPos;
      this.storage.write(entry.dna, entry.perception, primaryEmotion, secondaryEmotions).then(() => {
        console.log('[WM] 即时毕业');
      }).catch((err) => {
        console.warn('[WM] 即时毕业失败，入buffer:', err);
        this.buffer.push(entry);
      });
    } else {
      this.buffer.push(entry);
    }

    if (this.buffer.length >= this.maxSize) {
      this.consolidateSafe().catch(() => {});
    }
  }

  /**
   * 毕业策略
   *  full: calciumScore ≥ 0.3 + 有实体 → 完整24D写入金库
   *  false: 无实体或钙化过低 → 丢弃（原始对话已在砂金库）
   */
  private shouldGraduate(entry: WorkingEntry): 'full' | false {
    if (!entry.hasMeaningfulEntity) return false;
    // P0: 使用 calciumScore（连续值0-1）而不是 calciumLevel（离散值0-3）
    // ⚠️ 阶梯阈值过渡: 0.15→0.3，观察3天逐步上调
    if (entry.calciumScore >= 0.15) return 'full';
    return false;
  }

  /** P0: 最大 cycleCount 阈值（超过此值即使低钙化也强制写入） */
  private readonly FORCE_GRADUATE_CYCLES = 6;

  async consolidate(): Promise<WriteResult[]> {
    const results: WriteResult[] = [];
    const snapshot: WorkingEntry[] = [...this.buffer];
    snapshot.sort((a, b) => a.createdAt - b.createdAt);
    let discarded = 0;
    let discardSample = '';

    for (const entry of snapshot) {
      // P0: 递增 cycleCount
      entry.cycleCount++;

      const tier = this.shouldGraduate(entry);
      if (tier === 'full') {
        const result = await this.writeEntry(entry);
        results.push(result);
      } else if (entry.cycleCount >= this.FORCE_GRADUATE_CYCLES) {
        // 超强制毕业：已在buffer中停留过久，强制写入
        const result = await this.writeEntry(entry);
        results.push(result);
      } else {
        // P1: 记录丢弃的条目
        discarded++;
        if (!discardSample && entry.dna.raw_input) {
          discardSample = entry.dna.raw_input.substring(0, 40);
        }
      }
    }

    this.buffer = [];

    if (results.length > 0) {
      console.log(`[WM] 巩固: ${results.length} 条进入金库`);
    }
    if (discarded > 0) {
      console.log(`[WM] 丢弃: ${discarded} 条 (低钙化无实体, 样本: "${discardSample}")`);
    }
    return results;
  }

  private async writeEntry(entry: WorkingEntry): Promise<WriteResult> {
    entry.dna.seq_pos = entry.seqPos;
    return this.storage.write(entry.dna, entry.perception, entry.primaryEmotion, entry.secondaryEmotions);
  }

  getStatus(): { size: number; maxSize: number; utilization: number; pendingGraduates: number } {
    const pending = this.buffer.filter(function(e) { return !!e.hasMeaningfulEntity; }).length;
    return {
      size: this.buffer.length,
      maxSize: this.maxSize,
      utilization: Math.round(this.buffer.length / this.maxSize * 100),
      pendingGraduates: pending,
    };
  }

  async flushAll(): Promise<WriteResult[]> {
    const results: WriteResult[] = [];
    const dropped: number[] = [];
    for (const entry of this.buffer) {
      try {
        const _tier = this.shouldGraduate(entry);
        if (!_tier) {
          dropped.push(entry.seqPos);
          continue;
        }
        entry.dna.seq_pos = entry.seqPos;
        results.push(await this.storage.write(entry.dna, entry.perception));
      } catch (err) {
        console.warn("[WM] 写入失败:", err);
        results.push({ success: false, real_ref: '', seq_pos: -1, error: 'flush failed' });
      }
    }
    this.buffer = [];
    if (results.length > 0) {
      console.log(`[WM] 刷出: ${results.length} 条进金库 (丢弃 ${dropped.length} 条)`);
    }
    return results;
  }
}

/** @deprecated 使用 MemoryWriteBuffer，避免与 prefrontal/WorkingMemory 混淆 */
export { MemoryWriteBuffer as WorkingMemory };
