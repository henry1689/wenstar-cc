/**
 * MemWen OS · gate-stats —— Wilson 区间 + 配对三态门禁（ADR-024 附录 v2 §7.2 唯一实现）
 *
 * 🔴 门禁立法（守卫14）：
 *   ① 报告口径用 Wilson 区间（n=10 时 80% 成功率的 95% 区间宽约 45pp —— 单点无信息）；
 *   ② 放行用**配对检验**（新旧版本跑同一批题，比不一致题对），
 *      不用「下界对下界」（n=50 时差值噪声约 8pp，delta=3pp 的单点比较=掷骰子）；
 *   ③ 三态决策：显著退化自动阻断 / 跨零且下界低于容忍转人工 / 下界达标放行；
 *   ④ 只有留出集参与放行（调参集不入 gate —— 由 MW-Bench 运营方保证）。
 */

/** 区间 [lo, hi]（比例域，0..1） */
export interface MwCI {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Wilson score 区间（正态近似 Wilson，z=1.96 即 95%）。
 * 公式：center = (p̂ + z²/2n) / (1 + z²/n)，half = z·√(p̂(1-p̂)/n + z²/4n²) / (1 + z²/n)
 */
export function wilsonCI(k: number, n: number, z = 1.96): MwCI {
  if (!Number.isInteger(n) || n <= 0) throw new TypeError(`wilsonCI: n 必须是正整数，收到 ${n}`);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new TypeError(`wilsonCI: k 必须 ∈[0,n]，收到 ${k}/${n}`);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** 配对样本：同一套题上新旧版本的不一致题对 */
export interface MwPaired {
  /** 新版对、旧版错（改善） */
  readonly improved: number;
  /** 新版错、旧版对（退化） */
  readonly regressed: number;
  /** 总题数 */
  readonly n: number;
}

/**
 * 配对差值 CI（正态近似）：
 *   d̂ = (b − c)/n，Var(d̂) = [(b + c) − (b − c)²/n] / n² （配对差值方差）
 */
export function pairedDiffCI(p: MwPaired, z = 1.96): MwCI {
  const { improved: b, regressed: c, n } = p;
  if (!Number.isInteger(n) || n <= 0) throw new TypeError(`pairedDiffCI: n 必须是正整数，收到 ${n}`);
  if (b < 0 || c < 0 || b + c > n) throw new TypeError(`pairedDiffCI: 非法题对 ${b}/${c}/${n}`);
  const d = (b - c) / n;
  const varD = (b + c - ((b - c) * (b - c)) / n) / (n * n);
  const half = z * Math.sqrt(Math.max(0, varD));
  return { lo: d - half, hi: d + half };
}

/** 三态门禁决策 */
export type MwGateVerdict = 'block' | 'review' | 'pass';

/**
 * 三态决策（附录 §7.2）：
 *   hi < 0            → block  （显著退化，自动阻断）
 *   lo < −delta       → review （跨零或下界低于容忍，转人工，不自动放行）
 *   lo ≥ −delta       → pass   （下界达标）
 */
export function gateDecision(p: MwPaired, delta = 0.03, z = 1.96): MwGateVerdict {
  const ci = pairedDiffCI(p, z);
  if (ci.hi < 0) return 'block';
  if (ci.lo < -delta) return 'review';
  return 'pass';
}
