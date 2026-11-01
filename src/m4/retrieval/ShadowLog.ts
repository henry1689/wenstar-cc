/**
 * ShadowLog — 检索架构 v11 影子日志 + 八项埋点（任务书 §S2 A7 / 蓝皮书 §8.1 / §8.4）
 * ============================================================
 * S2 双跑期的**唯一观测出口**。影子链路与旧链路并行跑，结果只写日志、不参与返回。
 *
 * 【落点】`data/retrieval-v11/shadow/YYYY-MM-DD.jsonl` —— 一行一次查询，按日期分文件。
 * 【红线】
 *   1. 🔴 **禁止打印 `raw_input` / `block_summary` 原文**（隐私，蓝皮书 §8.4）。
 *      只打 id 与计数。本文件的 `write()` 入口即为该红线的唯一把关点。
 *   2. 🔴 **append-only**：只追加，不覆盖、不重排、不平滑（S1.1 同源红线）。
 *   3. 🔴 **影子失败只记录，不抛出**（任务书 §S2 A 影子调用硬约束）：
 *      `write()` / `error()` 内部吞掉一切 IO 异常，绝不让观测层打断生产链路。
 *   4. 🔴 **统计前必须剔除 `< 2s` 的 run**（蓝皮书 §8.3 / S5-B3）：
 *      测试污染生产审计的已知坑。见 `isRealRun()`。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../../common/const/paths.js';

/** 影子日志根目录 */
export const SHADOW_DIR = join(DATA_DIR, 'retrieval-v11', 'shadow');
/** 八项埋点落点（计数器快照） */
export const METRICS_FILE = join(DATA_DIR, 'retrieval-v11', 'metrics.json');

// ══════════════════════════════════════════════════════════════════
// 一、日志条目（蓝皮书 §8.4 字段规范）
// ══════════════════════════════════════════════════════════════════

export interface ShadowEntry {
  /** 关联 id —— 由调用方生成（查询指纹，不含原文） */
  trace_id: string;
  /** ISO 时间戳 */
  ts: string;
  /** 参与围栏的域 */
  domains: string[];
  /** 围栏出口候选数 */
  candidates_in: number;
  /** 精排出口候选数 */
  candidates_out: number;
  /** 精排 top-5 的 id（**不是正文**） */
  top_ids: string[];
  /** 旧链路返回的 id 集合（用于 §8.3「召回覆盖率」逐查询比对） */
  old_ids: string[];
  /** 新链路候选 id 集合 */
  new_ids: string[];
  /** 两段耗时 */
  stage_ms: { enclosure: number; rerank: number };
  /** 观测标记 */
  flags: {
    gate_degraded: boolean;
    semantic_skipped: boolean;
    /** 围栏因无 UUID 白名单而 fail-closed（结构性，不是故障） */
    fence_skipped_no_uuid_scope: boolean;
  };
  /** 归因：旧链路每条结果是否都在新链路候选集里（§7.1 召回覆盖率） */
  coverage: { old_total: number; old_covered: number };
}

// ══════════════════════════════════════════════════════════════════
// 二、写入（唯一把关点：只打 id，不打正文）
// ══════════════════════════════════════════════════════════════════

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 本地日期 → YYYY-MM-DD（与 GapLedger 同一口径，避免跨模块日期漂移） */
export function shadowDateStr(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 追加一条影子记录。**永不抛出**（红线 3）。
 * @returns 是否写入成功；失败时仅告警。
 */
export function write(entry: ShadowEntry): boolean {
  try {
    ensureDir(SHADOW_DIR);
    const file = join(SHADOW_DIR, `${shadowDateStr()}.jsonl`);
    // id 截断保护：防止误传入正文时把隐私写盘（红线 1 的兜底）
    const safe: ShadowEntry = {
      ...entry,
      top_ids: (entry.top_ids ?? []).map((x) => String(x).slice(0, 64)).slice(0, 5),
      old_ids: (entry.old_ids ?? []).map((x) => String(x).slice(0, 64)),
      new_ids: (entry.new_ids ?? []).map((x) => String(x).slice(0, 64)),
    };
    appendFileSync(file, JSON.stringify(safe) + '\n', 'utf-8');
    console.log(
      `[RetrievalV11] trace=${safe.trace_id} in=${safe.candidates_in} out=${safe.candidates_out} ` +
      `enc=${safe.stage_ms.enclosure}ms rerank=${safe.stage_ms.rerank}ms ` +
      `cover=${safe.coverage.old_covered}/${safe.coverage.old_total}`,
    );
    return true;
  } catch (e) {
    console.warn('[RetrievalV11] 影子日志写入失败（不影响生产）:', (e as Error)?.message);
    return false;
  }
}

/** 影子链路自身抛错时的记录口。**永不抛出**（任务书 §S2 A 影子调用硬约束）。 */
export function error(e: unknown, traceId?: string): void {
  const msg = e instanceof Error ? e.message : String(e);
  try {
    ensureDir(SHADOW_DIR);
    const file = join(SHADOW_DIR, `${shadowDateStr()}.jsonl`);
    appendFileSync(
      file,
      JSON.stringify({ trace_id: traceId ?? '-', ts: new Date().toISOString(), error: msg.slice(0, 500) }) + '\n',
      'utf-8',
    );
  } catch { /* 观测层自身失败也不得打断生产 */ }
  console.warn(`[RetrievalV11] 影子链路异常（已隔离，不影响生产返回）trace=${traceId ?? '-'}:`, msg);
}

// ══════════════════════════════════════════════════════════════════
// 三、八项埋点（蓝皮书 §8.1）
// ══════════════════════════════════════════════════════════════════

export type CounterName =
  | 'v11_retrieval_total'
  | 'v11_candidates_in'
  | 'v11_candidates_out'
  | 'gate_failclosed_total'
  | 'gate_degraded_total'
  | 'semantic_skipped_total'
  | 'dialog_group_skipped_total'
  | 'gap_open_total'
  | 'gap_backfill_total'
  // ── v11 生产接管率（2026-10-28 新增，业主指令「补该补的观测」）──
  | 'v11_takeover_total'
  | 'v11_fallback_total'
  | 'v11_fallback_fence_total';

const COUNTER_NAMES: readonly CounterName[] = Object.freeze([
  'v11_retrieval_total',
  'v11_candidates_in',
  'v11_candidates_out',
  'gate_failclosed_total',
  'gate_degraded_total',
  'semantic_skipped_total',
  'dialog_group_skipped_total',
  'gap_open_total',
  'gap_backfill_total',
  'v11_takeover_total',
  'v11_fallback_total',
  'v11_fallback_fence_total',
]);

/**
 * 🔴 接管率三项的口径（与调用方判据逐字一致，防双口径）
 * ==============================================
 * `v11_takeover_total`        新链路**真的接管了**（返回非空 ⇒ 调用方 `return viaV11`）
 * `v11_fallback_total`        新链路未接管、落回旧路
 * `v11_fallback_fence_total`  上者的**子集**：围栏没给出候选（无 sqlite / 无 UUID / 零命中 / 回表失败）
 *
 * ⚠️ **`v11_retrieval_total` 不是生产计数**：它的唯一 `incr` 在 `_shadowRecall` 里，
 *    统计的是**影子跑了几轮**，与蓝皮书 §8.1「每次 recallByStructured」的定义不符（已记 F-35）。
 *    本次刻意**不改它的语义** —— 观察期中途改埋点语义会让历史序列不可比。
 *
 * 为什么要这三个：没有它们就无法回答「v11 实际接管了多少、落回旧路多少」，
 * 而 B3（§7.1）/ B4（性能）两个验收判据都以「知道接管了什么」为前提。
 * 生产 v11 路径原本**成功接管时零日志零计数**，只有失败路径才有日志。
 */

/** `v11_retrieval_ms` 直方图的采样上限（够算 P50/P95/P99，不无限增长） */
const LATENCY_RING = 2000;
/** 每累加多少次落一次盘（观测层写盘不能成为检索热点） */
const FLUSH_EVERY = 50;

const counters = new Map<CounterName, number>();
for (const n of COUNTER_NAMES) counters.set(n, 0);
const latencies: number[] = [];
let sinceFlush = 0;

/** 计数器 +1（红线：本函数永不抛出） */
export function incr(name: CounterName, n = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + n);
  if (++sinceFlush >= FLUSH_EVERY) {
    sinceFlush = 0;
    flush();
  }
}

/** 记录一次检索耗时（毫秒），进入环形采样 */
export function observeLatency(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  latencies.push(ms);
  if (latencies.length > LATENCY_RING) latencies.splice(0, latencies.length - LATENCY_RING);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** 当前快照（含 `v11_retrieval_ms` 的 P50/P95/P99） */
export function snapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of counters) out[k] = v;
  const sorted = [...latencies].sort((a, b) => a - b);
  out['v11_retrieval_ms_p50'] = percentile(sorted, 50);
  out['v11_retrieval_ms_p95'] = percentile(sorted, 95);
  out['v11_retrieval_ms_p99'] = percentile(sorted, 99);
  out['v11_retrieval_ms_samples'] = sorted.length;
  return out;
}

/** 落盘计数器快照。**永不抛出** */
export function flush(): void {
  try {
    ensureDir(DATA_DIR);
    ensureDir(join(DATA_DIR, 'retrieval-v11'));
    writeFileSync(METRICS_FILE, JSON.stringify({ ts: new Date().toISOString(), ...snapshot() }, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[RetrievalV11] 埋点落盘失败（不影响生产）:', (e as Error)?.message);
  }
}

/** 读回已落盘的快照（供巡检脚本对账；文件缺失返回 null） */
export function readFlushed(): Record<string, unknown> | null {
  if (!existsSync(METRICS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(METRICS_FILE, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
// 四、度量口径（蓝皮书 §8.3 / S5-B3）
// ══════════════════════════════════════════════════════════════════

/**
 * 是否算一次「真实 run」。
 *
 * 🔴 **统计前必须剔除 `< 2s` 的 run**（蓝皮书 §8.3）——
 * 测试污染生产审计的已知坑：自动化测试、压测脚本产生的 run 会把生产基线拉偏。
 * 该阈值是**度量口径**，不是过滤开关，不得为「好看」改动（任务书 §S5 D4）。
 */
export const REAL_RUN_MIN_MS = 2000;
export function isRealRun(runMs: number): boolean {
  return Number.isFinite(runMs) && runMs >= REAL_RUN_MIN_MS;
}

/** 召回覆盖率（§8.3）：旧链路每条结果 ∈ 新链路候选集的查询占比 */
export function coverageOf(oldIds: readonly string[], newIds: readonly string[]): { old_total: number; old_covered: number } {
  const set = new Set(newIds);
  const old_total = oldIds.length;
  let old_covered = 0;
  for (const id of oldIds) if (set.has(id)) old_covered++;
  return { old_total, old_covered };
}

/** 零串档审计（§8.3）：结果中出现 `belong ∉ visible` 的次数，**必须恒为 0** */
export function crossEntityLeakCount(
  results: ReadonlyArray<{ belongEntityUuid?: string | null }>,
  visibleUuids: ReadonlySet<string>,
): number {
  let n = 0;
  for (const r of results) {
    const u = r.belongEntityUuid;
    if (u && !visibleUuids.has(u)) n++;
  }
  return n;
}

/** 测试用：清空内存计数器（不触碰已落盘文件） */
export function resetForTest(): void {
  for (const n of COUNTER_NAMES) counters.set(n, 0);
  latencies.length = 0;
  sinceFlush = 0;
}
