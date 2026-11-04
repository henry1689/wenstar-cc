/**
 * 单维证据打分内核（S-010 ~ S-015）
 *
 * 严格按 oracle v3 `dim_evidence` 实现，供切片#3 的加权求和使用。
 * 本文件只输出**截断后**的 ℓ——权重 w_i 的乘法在切片#3（S-016/S-017）做，
 * 这里先截断再交出去正是 S-013 的「先截断，再乘权重」。
 *
 * 公式（基线 S-010）：
 *   ℓ = ½·ln(b²/s²) + (q−μ)²/(2b²) − (q−x̂)²/(2s²)
 *   s² = σq² + v̂      b² = σq² + τ²
 *   x̂ = (πx·x + (1/τ²)·μ) / (πx + 1/τ²)      （精度加权收缩）
 *   v̂ = 1 / (πx + 1/τ²)                       （收缩后验方差）
 *   σq² = 1/πq
 */

import { CLIP, TAU_MIN } from './config.js';
import { sanitizeValue } from './types.js';
import { clampPi } from './coding.js';

/**
 * 后验方差 v̂ = 1 / (πx + 1/τ²)（S-014 收缩、S-018 覆盖率共用）。
 *
 * 导出为独立函数是为了让 `dimEvidence` 与 `coverage` **共用同一份公式**，
 * 否则两处各写一遍必然漂移（这正是切片#1 整改「不要自己写清洗逻辑」的教训）。
 *
 * - τ 按 S-015 钳到 ≥ TAU_MIN
 * - πx 按 E-25 清洗：NaN/负/−∞ → 0（未知），+∞ → 400（饱和）
 *
 * G-018 校验：τ=0.3、πx=100 → v̂=0.009；πx=0 → v̂=0.09（此时 cov 恰为 0）
 */
export function posteriorVariance(piX: number, tau: number): number {
  const tauEff = Math.max(tau, TAU_MIN);
  const p0 = 1 / (tauEff * tauEff);
  return 1 / (clampPi(piX) + p0);
}

/**
 * 单维对数似然比证据（S-010）
 *
 * @param q     查询值（已归一化到维度值域）
 * @param piQ   查询精度 π（1/方差），0 = 未知
 * @param x     印记值
 * @param piX   印记精度 π，0 = 未知
 * @param mu    背景均值
 * @param tau   背景离散度，内部按 S-015 钳到 ≥ 0.1
 * @param bipolar 该维是否双极（差分对拍时必须与 oracle 的 bipolar 一致）
 * @returns 截断到 [-3, 3] 的 ℓ
 *
 * 早退路径（全部返回精确 0，对应 S-012 / S-060）：
 * - mu/tau 非有限 → **抛异常**（oracle 行为，背景坏了必须炸出来而非静默给 0）
 * - πq ≤ 0 → 0（查询未知，S-012）
 * - σq² ≥ τ² → 0（查询噪声已盖过背景，S-012「查询不可靠」）
 * - πx ≤ 0 → 0（印记未知，S-060「未知恰为 0」）
 */
export function dimEvidence(
  q: number,
  piQ: number,
  x: number,
  piX: number,
  mu: number,
  tau: number,
  bipolar = true,
): number {
  // S-015 / oracle：背景参数非有限直接抛，不静默降级
  if (!Number.isFinite(mu) || !Number.isFinite(tau)) {
    throw new Error('dimEvidence: background (mu, tau) must be finite');
  }

  // S-015：τ 下限 0.1（常量在 config，不写字面量）
  const tauEff = Math.max(tau, TAU_MIN);

  // S-011：输入只接受 π；q/piQ 与 x/piX 都过同一套清洗
  const qr = sanitizeValue(q, piQ, bipolar);
  if (qr.pi <= 0) return 0; // S-012：查询未知

  const sigmaQ2 = 1 / qr.pi;
  if (sigmaQ2 >= tauEff * tauEff) return 0; // S-012：查询不可靠

  const xr = sanitizeValue(x, piX, bipolar);
  if (xr.pi <= 0) return 0; // S-060：印记未知，贡献恰为 0

  // 背景精度 p0 = 1/τ²
  const p0 = 1 / (tauEff * tauEff);

  // 精度加权收缩（S-014：|x̂−μ| ≤ |x−μ|，收缩不会放大噪声）
  const xh = (xr.pi * xr.v + p0 * mu) / (xr.pi + p0);
  const vHat = posteriorVariance(xr.pi, tauEff); // 与 S-018 覆盖率共用同一公式

  const s2 = sigmaQ2 + vHat;
  const b2 = sigmaQ2 + tauEff * tauEff;

  const ell =
    0.5 * Math.log(b2 / s2) +
    (qr.v - mu) ** 2 / (2 * b2) -
    (qr.v - xh) ** 2 / (2 * s2);

  // S-013：先截断到 [-3,3]，截断后再乘权重（权重在切片#3）
  return Math.min(Math.max(ell, -CLIP), CLIP);
}
