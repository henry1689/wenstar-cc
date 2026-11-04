/**
 * MemArch-v2.0.0 / M5-Presentation / router.ts
 *
 * 概率分发器：输入 NormalizedEvidence[]，输出 p_A 与路由决策。
 *
 * 硬规则（验收用）：
 *   1. tombstone=true 直接丢弃，不可见。
 *   2. suppressed=true 一律压到 B-side，绝不进入 A-side。
 *   3. p_A 只由 A-side 证据计算；B-side 证据不参与 p_A 计算。
 */

import type {
  NormalizedEvidence,
  Pathway,
  RoutedPath,
} from './types.js';
import type { RouterConfig } from './config.js';

export interface RouterInput {
  evidences: NormalizedEvidence[];
  config: RouterConfig;
}

export interface RouterDecision {
  /** 通路 A 概率 ∈ [0,1] */
  p_A: number;
  routed_path: RoutedPath;
  /** 可进入 A-side 的证据（已过滤 tombstone/suppressed/B-pathway） */
  a_side: NormalizedEvidence[];
  /** 仅可走 B-side 的证据（suppressed 或 pathway=B） */
  b_side: NormalizedEvidence[];
  /** 被丢弃的（tombstone）uuid */
  dropped_tombstones: string[];
}

/**
 * 计算 p_A：A-side 证据的 score 平方加权平均。
 * 用 score² 做权重，让高分证据主导 p_A——这样单条强证据就能把 p_A 拉到高位，
 * 多条弱证据堆不出高 p_A（避免"数量错觉"导致误走 A_direct）。
 */
export function computePA(a_side: NormalizedEvidence[]): number {
  if (a_side.length === 0) return 0;
  let wsum = 0;
  let accum = 0;
  for (const ev of a_side) {
    const w = ev.score * ev.score; // score² 加权
    wsum += w;
    accum += w * ev.score;
  }
  if (wsum === 0) return 0;
  return accum / wsum;
}

export function decidePath(p_A: number, cfg: RouterConfig): RoutedPath {
  if (p_A >= cfg.p_A_high) return 'A_direct';
  if (p_A >= cfg.p_A_low) return 'hybrid';
  return 'B_only';
}

/**
 * 主入口：分桶 + 算 p_A + 路由。
 */
export function route(input: RouterInput): RouterDecision {
  const { evidences, config } = input;

  const a_side: NormalizedEvidence[] = [];
  const b_side: NormalizedEvidence[] = [];
  const dropped_tombstones: string[] = [];

  for (const ev of evidences) {
    // 规则 1：墓碑不可见
    if (ev.tombstone) {
      dropped_tombstones.push(ev.uuid);
      continue;
    }
    // 规则 2：suppressed 或 pathway=B → 强制 B-side
    if (ev.suppressed || ev.pathway === 'B') {
      b_side.push(ev);
      continue;
    }
    // 规则 3：其余进 A-side
    a_side.push(ev);
  }

  // A-side 内部按 score 降序，方便后续 top-k 取用
  a_side.sort((a, b) => b.score - a.score);
  b_side.sort((a, b) => b.score - a.score);

  const p_A = computePA(a_side);
  const routed_path = decidePath(p_A, config);

  return { p_A, routed_path, a_side, b_side, dropped_tombstones };
}

/** 仅用于测试/调试：把分桶结果打平成 Pathway 视图 */
export function bucketSummary(decision: RouterDecision): {
  a_count: number;
  b_count: number;
  tombstone_dropped: number;
  a_pathways: Pathway[];
} {
  return {
    a_count: decision.a_side.length,
    b_count: decision.b_side.length,
    tombstone_dropped: decision.dropped_tombstones.length,
    a_pathways: decision.a_side.map((e) => e.pathway),
  };
}
