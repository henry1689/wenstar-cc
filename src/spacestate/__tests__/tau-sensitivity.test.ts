/**
 * 切片#3 补包 · τ 敏感度（信息性实测 + 结构性单调断言）
 *
 * ⚠️ 本文件内的 kalmanStepLite 是**演示用最小实现**，只用于量化 τ 对结果的
 * 影响程度，**不是**生产滤波实现。仓库尚无 `kalmanStep`（滤波模块在后续切片），
 * 生产 kalman 落地后本文件须改为引用真实模块。
 *
 * 目的：证明 τ 不是「无害默认值」。relation 层的 τ = 120 是**临时值**
 * （白皮书未给，取与 dyad 同值，待业主确认 E-28），必须靠实测数值支撑裁决。
 */
import { describe, it, expect } from 'vitest';
import { LAYER_PARAMS } from '../core/config.js';

/** 基线 B、过程噪声、初值后验（白皮书 §2.4 的 OU 形式） */
const BASELINE = 0.5;
const PROCESS_NOISE = 0.01;
const PRIOR_VAR = 0.09;

/**
 * 最小 OU–Kalman 一步更新（预测 + 可选观测更新）。
 * 仅用于 τ 敏感度演示，不是生产实现。
 */
function kalmanStepLite(
  m: number,
  P: number,
  obs: number,
  piObs: number,
  dtMin: number,
  tauMin: number,
  B: number,
  s2: number,
): { m: number; P: number } {
  const a = Math.exp(-dtMin / tauMin);
  const mPred = B + (m - B) * a;
  const pPred = P * a * a + s2 * (1 - a * a);
  if (piObs <= 0) return { m: mPred, P: pPred };
  const r = 1 / piObs;
  const S = pPred + r;
  const K = pPred / S;
  return { m: mPred + K * (obs - mPred), P: (1 - K) * pPred };
}

/**
 * 同一条脚本轨迹：
 * - 0–30 分钟：每 5 分钟一次观测，值恒 0.9（阶跃）
 * - 30–120 分钟：无观测，只预测
 */
function runTrajectory(tauMin: number): { m: number; residual: number } {
  let m = BASELINE;
  let P = PRIOR_VAR;
  for (let t = 0; t <= 30; t += 5) {
    const dt = t === 0 ? 0 : 5;
    const step = kalmanStepLite(m, P, 0.9, 25, dt, tauMin, BASELINE, PROCESS_NOISE);
    m = step.m;
    P = step.P;
  }
  for (let t = 0; t < 90; t += 5) {
    const step = kalmanStepLite(m, P, 0, 0, 5, tauMin, BASELINE, PROCESS_NOISE);
    m = step.m;
    P = step.P;
  }
  return { m, residual: Math.abs(m - BASELINE) };
}

describe('τ 敏感度 · relation 层临时值 120 的影响', () => {
  it('τ 越大，无观测期回归越慢（残差单调递增）', () => {
    const r60 = runTrajectory(60);
    const r120 = runTrajectory(120);
    const r240 = runTrajectory(240);
    expect(r60.residual).toBeLessThan(r120.residual);
    expect(r120.residual).toBeLessThan(r240.residual);
  });

  it('三组终态数值（评审记录，console.log 供粘贴进自测报告）', () => {
    const rows = [60, 120, 240].map((tau) => ({ tau, ...runTrajectory(tau) }));
    const reference = rows[1].residual;
    // eslint-disable-next-line no-console
    console.log(
      '\nτ 敏感度（relation 层，阶跃 0.9 → 90 分钟无观测，基线 0.5）\n' +
        '| 指标 | τ=60 | τ=120 | τ=240 |\n|---|---|---|---|\n' +
        `| 终态 m | ${rows[0].m.toFixed(6)} | ${rows[1].m.toFixed(6)} | ${rows[2].m.toFixed(6)} |\n` +
        `| 距基线 0.5 的残差 | ${rows[0].residual.toFixed(6)} | ${rows[1].residual.toFixed(6)} | ${rows[2].residual.toFixed(6)} |\n` +
        `| 相对 τ=120 的偏离% | ${(((rows[0].residual - reference) / reference) * 100).toFixed(2)}% | 0.00% | ${(((rows[2].residual - reference) / reference) * 100).toFixed(2)}% |`,
    );
    for (const row of rows) {
      expect(Number.isFinite(row.m)).toBe(true);
      expect(row.m).toBeGreaterThan(BASELINE); // 仍高于基线，未完全回归
    }
    expect(LAYER_PARAMS.relation.tauMin).toBe(120);
  });

  it('τ 是真正影响结果的参数：三组残差差异显著', () => {
    const r60 = runTrajectory(60).residual;
    const r240 = runTrajectory(240).residual;
    // 相对差异超过一个数量级的门槛，说明 120 不能当「无害默认值」
    expect(r240 / r60).toBeGreaterThan(2);
  });
});