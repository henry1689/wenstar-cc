// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / degrade/timeout_breaker.ts
// 分层超时熔断：
//   - 每路召回独立 race 超时，失败/超时降级为空数组（不阻塞其他路）
//   - 重排整体超时（默认 200ms）：跳过 rerank，直接返回 RRF top-K
//   - 查询理解超时（默认 50ms）：用最小占位 QueryContext
// =====================================================================

/** 包装 Promise：超时返回 fallback，并记录是否触发 */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout?: (elapsed: number) => void
): Promise<{ value: T; timedOut: boolean; elapsed: number }> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | null = null;
  // 🔴 必须用「fallback 是否真的被采用」判定超时，不能用 `elapsed >= ms`。
  //   旧实现拿总耗时与阈值比大小：当任务恰好在阈值边界（比如 300.4ms）完成时，
  //   拿到的是**真实结果**，却被标记成「已超时降级」—— 实测首查 bm25/semantic
  //   明明返回了数据，指标里却记成 null、degraded_legs 还多两条。
  //   指标失真会让人误判「召回腿坏了」，而其实只是跑得慢一点。
  let usedFallback = false;
  try {
    const value = await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => { usedFallback = true; resolve(fallback); }, ms);
      }),
    ]);
    const elapsed = Date.now() - t0;
    if (usedFallback && onTimeout) onTimeout(elapsed);
    return { value, timedOut: usedFallback, elapsed };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 串行辅助：测量同步函数耗时 */
export function measureSync<T>(fn: () => T): { value: T; elapsed: number } {
  const t0 = Date.now();
  const value = fn();
  return { value, elapsed: Date.now() - t0 };
}
