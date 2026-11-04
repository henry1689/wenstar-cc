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
  try {
    const value = await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
    const elapsed = Date.now() - t0;
    const timedOut = elapsed >= ms;
    if (timedOut && onTimeout) onTimeout(elapsed);
    return { value, timedOut, elapsed };
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
