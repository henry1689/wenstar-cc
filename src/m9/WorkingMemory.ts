/**
 * M9 WorkingMemory — 工作记忆缓冲（唯一 M2 写入入口）
 *
 * v2:
 * - 修复 P0: calciumLevel ≥ 0.3 → calciumScore ≥ 0.3（毕业条件）
 * - 修复 P0: cycleCount 在 consolidation 中递增，支持 staged 毕业
 * - 修复 P1: primaryEmotion/secondaryEmotions 存入 WorkingEntry
 * - 修复 P1: 周期巩固时保留未毕业条目，显式排空时记录丢弃
 */
import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';
import type { Perception24D } from '../m3/types/perception.js';
import type { DNA } from '../m1/types/dna.js';
import type { WriteResult } from '../m2/types/index.js';
import { PerceptionAnalyzer } from '../m3/PerceptionAnalyzer.js';
import { M3_CONFIG } from '../config/M3Config.js';

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
   *  false: 无实体或钙化过低 → 周期巩固继续保留；显式 flushAll 才丢弃
   */
  private shouldGraduate(entry: WorkingEntry): 'full' | false {
    if (!entry.hasMeaningfulEntity) return false;
    // P0: 使用 calciumScore（连续值0-1）而不是 calciumLevel（离散值0-3）
    // P2-6: 毕业阈值统一引用 M3_CONFIG.calcium.level0Threshold（0.25），不再独立硬编码
    if (entry.calciumScore >= M3_CONFIG.calcium.level0Threshold) return 'full';
    return false;
  }

  /** P0: 最大 cycleCount 阈值（超过此值即使低钙化也强制写入） */
  private readonly FORCE_GRADUATE_CYCLES = 6;

  async consolidate(): Promise<WriteResult[]> {
    const results: WriteResult[] = [];
    const snapshot: WorkingEntry[] = [...this.buffer];
    const retainedEntries = new Set<WorkingEntry>();
    snapshot.sort((a, b) => a.createdAt - b.createdAt);
    let retained = 0;
    let retainedSample = '';

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
        // 尚未达到毕业条件或强制轮次，保留在 buffer 进入下一轮。
        retainedEntries.add(entry);
        retained++;
        if (!retainedSample && entry.dna.raw_input) {
          retainedSample = entry.dna.raw_input.substring(0, 40);
        }
      }
    }

    // 只移除本轮已毕业的快照条目；未毕业条目与巩固期间新 push 的条目继续保留。
    const snapshotEntries = new Set(snapshot);
    this.buffer = this.buffer.filter(entry => !snapshotEntries.has(entry) || retainedEntries.has(entry));
    if (results.length > 0) {
      console.log(`[WM] 巩固: ${results.length} 条进入金库`);
    }
    if (retained > 0) {
      console.log(`[WM] 保留: ${retained} 条等待下一轮 (样本: "${retainedSample}")`);
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

  /**
   * 显式排空：立即写入当前已满足毕业条件的条目，并丢弃其余条目。
   * 与周期性 consolidate 不同，本方法用于关闭/切换阶段，不保留到下一轮。
   */
  async flushAll(): Promise<WriteResult[]> {
    const results: WriteResult[] = [];
    const dropped: number[] = [];
    // 🆕 V10.0 P0-4: 快照当前 buffer，避免迭代中新 push 的条目被误清
    const _snapshot = [...this.buffer];
    for (const entry of _snapshot) {
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
    // 🆕 V10.0 P0-4: 只移除已处理的条目
    const _snapIds2 = new Set(_snapshot.map(e => e.seqPos));
    this.buffer = this.buffer.filter(e => !_snapIds2.has(e.seqPos));
    if (results.length > 0) {
      console.log(`[WM] 刷出: ${results.length} 条进金库 (丢弃 ${dropped.length} 条)`);
    }
    return results;
  }
}

/** @deprecated 使用 MemoryWriteBuffer，避免与 prefrontal/WorkingMemory 混淆 */
export { MemoryWriteBuffer as WorkingMemory };
