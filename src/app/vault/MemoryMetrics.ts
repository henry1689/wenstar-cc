/**
 * MemoryMetrics — 三库记忆系统运行时指标
 *
 * 覆盖写入、检索、晋升、衰减、压缩全链路的性能与健康数据。
 * 所有指标可通过 GET /api/vault/metrics 获取。
 *
 * P2-2: 新增全链路指标埋点，与 KnowledgeMonitor 互补
 * （KnowledgeMonitor 负责知识库健康，此模块负责记忆系统运行时指标）
 */
export class MemoryMetrics {
  // ── 写入 ──
  writeCount = 0;
  writeErrorCount = 0;
  writeTotalLatencyMs = 0;

  // ── 检索 ──
  retrievalCount = 0;
  retrievalHitCount = 0;
  retrievalEmptyCount = 0;
  retrievalTotalLatencyMs = 0;

  // ── 晋升 ──
  sandToGoldCount = 0;
  sandToGoldErrorCount = 0;
  goldToDiamondCount = 0;
  goldToDiamondErrorCount = 0;

  // ── 衰减 ──
  decayRunCount = 0;
  decayErrorCount = 0;
  lastDecayAt: string | null = null;

  // ── 压缩 ──
  compactionCount = 0;
  compactionErrorCount = 0;

  // ── 异常 ──
  lastError: { time: string; message: string } | null = null;

  private startTimes = new Map<string, number>();

  /** 开始计时 */
  startTimer(label: string): void {
    this.startTimes.set(label, Date.now());
  }

  /** 结束计时，返回耗时(ms) */
  endTimer(label: string): number {
    const start = this.startTimes.get(label);
    if (!start) return 0;
    const elapsed = Date.now() - start;
    this.startTimes.delete(label);
    return elapsed;
  }

  // ── 写入指标 ──
  recordWrite(latencyMs: number, success: boolean): void {
    this.writeCount++;
    this.writeTotalLatencyMs += latencyMs;
    if (!success) this.writeErrorCount++;
  }

  // ── 检索指标 ──
  recordRetrieval(latencyMs: number, hitCount: number): void {
    this.retrievalCount++;
    this.retrievalTotalLatencyMs += latencyMs;
    if (hitCount > 0) this.retrievalHitCount++;
    else this.retrievalEmptyCount++;
  }

  // ── 晋升指标 ──
  recordSandToGold(count: number, errors: number): void {
    this.sandToGoldCount += count;
    this.sandToGoldErrorCount += errors;
  }

  recordGoldToDiamond(count: number, errors: number): void {
    this.goldToDiamondCount += count;
    this.goldToDiamondErrorCount += errors;
  }

  // ── 衰减指标 ──
  recordDecay(success: boolean): void {
    this.decayRunCount++;
    this.lastDecayAt = new Date().toISOString();
    if (!success) this.decayErrorCount++;
  }

  // ── 压缩指标 ──
  recordCompaction(count: number, errors: number): void {
    this.compactionCount += count;
    this.compactionErrorCount += errors;
  }

  // ── 异常 ──
  recordError(message: string): void {
    this.lastError = { time: new Date().toISOString(), message };
  }

  /** 获取当前快照 */
  snapshot(): Record<string, any> {
    const avgWriteLatency = this.writeCount > 0
      ? Math.round(this.writeTotalLatencyMs / this.writeCount) : 0;
    const avgRetrievalLatency = this.retrievalCount > 0
      ? Math.round(this.retrievalTotalLatencyMs / this.retrievalCount) : 0;
    const hitRate = this.retrievalCount > 0
      ? Math.round(this.retrievalHitCount / this.retrievalCount * 100) : 0;

    return {
      write: {
        total: this.writeCount,
        errors: this.writeErrorCount,
        avgLatencyMs: avgWriteLatency,
      },
      retrieval: {
        total: this.retrievalCount,
        hits: this.retrievalHitCount,
        empty: this.retrievalEmptyCount,
        hitRate: hitRate + '%',
        avgLatencyMs: avgRetrievalLatency,
      },
      promotion: {
        sandToGold: this.sandToGoldCount,
        sandToGoldErrors: this.sandToGoldErrorCount,
        goldToDiamond: this.goldToDiamondCount,
        goldToDiamondErrors: this.goldToDiamondErrorCount,
      },
      decay: {
        runs: this.decayRunCount,
        errors: this.decayErrorCount,
        lastRun: this.lastDecayAt,
      },
      compaction: {
        runs: this.compactionCount,
        errors: this.compactionErrorCount,
      },
      lastError: this.lastError,
    };
  }
}

/** 全局单例 */
export const memoryMetrics = new MemoryMetrics();
