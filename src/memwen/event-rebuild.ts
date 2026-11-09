/**
 * MemWen OS · event-rebuild —— 事件流折叠重建 + 对账（ADR-024 附录 v2 §6.2 唯一实现）
 *
 * 🔴 确定性三前提（守卫9 的数学基础）：
 *   ① apply 必须是纯函数：不读墙钟（时间在事件载荷里）、无 I/O、无随机；
 *   ② LLM 产物（mem_class、dream 摘要等）必须作为**事件载荷**记录，
 *      重放时不得再次调用 LLM（否则 fold 不可复现）；
 *   ③ 对账比较**记录集（key 集合 + 字段校验和）**，不比 HNSW 图结构
 *      （图依赖插入顺序，同集合不同序不同形，比图必然假报警）。
 *
 * 不变量：Δ_rebuild = d(Index(S_T), Index_live) = 0 —— 非零即告警。
 */

/** 事件（ts 属载荷、由写入方盖章；apply 不得读墙钟） */
export interface MwEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  /** 写入方盖章时间（入载荷，仅供审计；apply 不得用它做时间判断） */
  readonly ts?: string;
}

/** 折叠函数（必须纯 —— 同输入永远同输出） */
export type MwApply<S> = (state: S, ev: MwEvent) => S;

/**
 * fold：S_T = fold(apply, S_0, {e_1..e_T})。
 * 纯顺序消费，不做任何隐式去重/排序 —— 事件顺序即语义。
 */
export function foldApply<S>(init: S, events: readonly MwEvent[], apply: MwApply<S>): S {
  let state = init;
  for (const ev of events) state = apply(state, ev);
  return state;
}

/** 索引快照：key → 关键字段校验和（比较用，不存图结构） */
export type MwIndexSnapshot = ReadonlyMap<string, string>;

/** 对账结果 */
export interface MwReconcileResult {
  /** Δ_rebuild：对称差大小 +（校验和不等 ? 1 : 0）—— 非零即告警 */
  readonly delta: number;
  readonly onlyBuilt: readonly string[];
  readonly onlyLive: readonly string[];
  readonly checksumMismatch: readonly string[];
}

function sortedDiff(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const k of a) if (!b.has(k)) out.push(k);
  return out.sort();
}

/**
 * 对账：Δ = |对称差| + 校验和差计数。
 * Δ = 0 ⇔ 重建索引与实况完全一致（可重建性的可检验等式）。
 */
export function reconcileIndex(built: MwIndexSnapshot, live: MwIndexSnapshot): MwReconcileResult {
  const onlyBuilt = sortedDiff(new Set(built.keys()), new Set(live.keys()));
  const onlyLive = sortedDiff(new Set(live.keys()), new Set(built.keys()));
  const checksumMismatch: string[] = [];
  for (const [k, v] of built) {
    const lv = live.get(k);
    if (lv !== undefined && lv !== v) checksumMismatch.push(k);
  }
  checksumMismatch.sort();
  const delta = onlyBuilt.length + onlyLive.length + (checksumMismatch.length > 0 ? 1 : 0);
  return { delta, onlyBuilt, onlyLive, checksumMismatch };
}

/** 告警判定：Δ ≠ 0 即告警（调用方接观测，不静默） */
export function shouldAlert(r: MwReconcileResult): boolean {
  return r.delta !== 0;
}
