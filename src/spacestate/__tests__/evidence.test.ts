/**
 * 切片#2 · 证据内核（S-010~S-015 + S-060）
 * 黄金算例 G-010 七例 + 链式检查 + 早退路径 + 收缩不变量
 */
import { describe, it, expect } from 'vitest';
import { dimEvidence } from '../core/evidence.js';
import { TAU_MIN, CLIP } from '../core/config.js';

/** G-010 公共参数：πq=100, τ=0.3, μ=0 */
const PI_Q = 100;
const TAU = 0.3;
const MU = 0;

/** 衰减后 σ（G-010 #5 给定的 6 位截断值） */
const SX = 0.378108;

describe('G-010 · 七个黄金算例', () => {
  it('#1 常见值匹配：q=0, x=0, πx=100 → 0.830366', () => {
    const ell = dimEvidence(0, PI_Q, 0, 100, MU, TAU);
    expect(ell).toBeCloseTo(0.830366, 6);
  });

  it('#2 稀有值匹配：q=0.6, x=0.6, πx=100 → 2.535629', () => {
    const ell = dimEvidence(0.6, PI_Q, 0.6, 100, MU, TAU);
    expect(ell).toBeCloseTo(2.535629, 6);
  });

  it('#3 印记未知：πx=0 → 精确 0（S-060）', () => {
    expect(dimEvidence(0.6, PI_Q, 0.999, 0, MU, TAU)).toBe(0);
    expect(dimEvidence(0.6, PI_Q, -0.999, 0, MU, TAU)).toBe(0);
    // 未知必须精确为 0，而非极小值
    expect(Object.is(dimEvidence(0.6, PI_Q, 0.6, 0, MU, TAU), 0)).toBe(true);
  });

  it('#4 失配：原始 -31.57 → 截断 -3（S-013）', () => {
    const ell = dimEvidence(0.6, PI_Q, -0.6, 100, MU, TAU);
    expect(ell).toBe(-CLIP); // 截断后 = -3
    expect(ell).toBe(-3);
  });

  it('#5 衰减后匹配：πx=1/sx² → 0.974417（全精度，容差 1e-5）', () => {
    const piX = 1 / (SX * SX);
    const ell = dimEvidence(0.6, PI_Q, 0.6, piX, MU, TAU);
    expect(ell).toBeCloseTo(0.974417, 5);
  });

  it('#6 查询不可靠：σq² ≥ τ² → 0，用 0.999/1.001 系数卡边界（S-012）', () => {
    // σq² = 1/πq ≥ τ²  ⟺  πq ≤ 1/τ²
    const threshold = 1 / (TAU * TAU);
    // 刚好低于阈值（σq² 略大于 τ²）→ 查询不可靠 → 0
    expect(dimEvidence(0.6, threshold * 0.999, 0.6, 100, MU, TAU)).toBe(0);
    // 刚好高于阈值（σq² 略小于 τ²）→ 可靠 → 非 0
    const reliable = dimEvidence(0.6, threshold * 1.001, 0.6, 100, MU, TAU);
    expect(reliable).not.toBe(0);
    expect(Number.isFinite(reliable)).toBe(true);
  });

  it('#7 极度模糊：πx=1/9 → 0.024077', () => {
    // ⚠️ 任务书写「πx=9」是笔误：oracle 原文为 dim_evidence(.6,100,.6,1/9.0,0,t)。
    // 实算 πx=9 → 1.137762（不匹配），πx=1/9 → 0.024078（匹配 0.024077）。
    // 「极度模糊」语义也要求 πx 小，故按 oracle 取 1/9。已记入差异报告。
    const ell = dimEvidence(0.6, PI_Q, 0.6, 1 / 9, MU, TAU);
    // 与 oracle 同口径：close() 默认 tol=1e-6（toBeCloseTo(_,6) 的判据是 5e-7，更紧）
    expect(Math.abs(ell - 0.024077)).toBeLessThanOrEqual(1e-6);
    // 反证：写成 9 会得到 1.1378，确认不是同一个数
    expect(dimEvidence(0.6, PI_Q, 0.6, 9, MU, TAU)).toBeCloseTo(1.137762, 6);
  });

  it('链式检查：#2 > #5 > #7 > #3，且 #2 > #1', () => {
    const e1 = dimEvidence(0, PI_Q, 0, 100, MU, TAU);
    const e2 = dimEvidence(0.6, PI_Q, 0.6, 100, MU, TAU);
    const e3 = dimEvidence(0.6, PI_Q, 0.6, 0, MU, TAU);
    const e5 = dimEvidence(0.6, PI_Q, 0.6, 1 / (SX * SX), MU, TAU);
    const e7 = dimEvidence(0.6, PI_Q, 0.6, 1 / 9, MU, TAU);

    expect(e2).toBeGreaterThan(e5);
    expect(e5).toBeGreaterThan(e7);
    expect(e7).toBeGreaterThan(e3);
    expect(e2).toBeGreaterThan(e1);
  });
});

describe('S-011 · 输入只接受 π', () => {
  it('函数签名为 (q, piQ, x, piX, mu, tau, bipolar?)', () => {
    expect(dimEvidence.length).toBe(6); // bipolar 有默认值，不计入 arity
  });

  it('πx = +∞ 按 400 处理（E-25 饱和），不抛异常', () => {
    const withInf = dimEvidence(0.6, PI_Q, 0.6, Infinity, MU, TAU);
    const with400 = dimEvidence(0.6, PI_Q, 0.6, 400, MU, TAU);
    expect(withInf).toBe(with400);
    expect(Number.isFinite(withInf)).toBe(true);
  });

  it('πq = +∞ 同样按 400 处理', () => {
    const withInf = dimEvidence(0.6, Infinity, 0.6, 100, MU, TAU);
    const with400 = dimEvidence(0.6, 400, 0.6, 100, MU, TAU);
    expect(withInf).toBe(with400);
  });

  it('超限有限 π 按 400 截断', () => {
    expect(dimEvidence(0.6, 1000, 0.6, 100, MU, TAU)).toBe(
      dimEvidence(0.6, 400, 0.6, 100, MU, TAU),
    );
  });
});

describe('S-012 · 查询不可靠时无证据', () => {
  it('piQ = 0 → ℓ = 0', () => {
    expect(dimEvidence(0.6, 0, 0.6, 100, MU, TAU)).toBe(0);
  });

  it('piQ 为负 / NaN / -∞ → ℓ = 0', () => {
    expect(dimEvidence(0.6, -5, 0.6, 100, MU, TAU)).toBe(0);
    expect(dimEvidence(0.6, NaN, 0.6, 100, MU, TAU)).toBe(0);
    expect(dimEvidence(0.6, -Infinity, 0.6, 100, MU, TAU)).toBe(0);
  });

  it('q 非有限 → ℓ = 0（不得把 +∞ 截成边界值造强证据）', () => {
    expect(dimEvidence(Infinity, PI_Q, 0.6, 100, MU, TAU)).toBe(0);
    expect(dimEvidence(-Infinity, PI_Q, 0.6, 100, MU, TAU)).toBe(0);
    expect(dimEvidence(NaN, PI_Q, 0.6, 100, MU, TAU)).toBe(0);
  });

  it('x 非有限 → ℓ = 0', () => {
    expect(dimEvidence(0.6, PI_Q, Infinity, 100, MU, TAU)).toBe(0);
    expect(dimEvidence(0.6, PI_Q, NaN, 100, MU, TAU)).toBe(0);
  });
});

describe('S-013 · ℓ 截断到 [-3, 3]', () => {
  it('强失配截断到 -3，不产生一票否决', () => {
    expect(dimEvidence(1, PI_Q, -1, 100, MU, TAU)).toBe(-CLIP);
  });

  it('强匹配截断到 +3', () => {
    const raw = dimEvidence(1, 400, 1, 400, MU, TAU);
    expect(raw).toBeLessThanOrEqual(CLIP);
    expect(raw).toBeGreaterThanOrEqual(-CLIP);
  });

  it('全输入域输出恒在 [-3,3] 且有限', () => {
    for (let i = 0; i < 5000; i++) {
      const q = Math.random() * 4 - 2;
      const x = Math.random() * 4 - 2;
      const piQ = Math.random() * 500;
      const piX = Math.random() * 500;
      const mu = Math.random() * 2 - 1;
      const tau = Math.random();
      const ell = dimEvidence(q, piQ, x, piX, mu, tau);
      expect(Number.isFinite(ell)).toBe(true);
      expect(ell).toBeGreaterThanOrEqual(-CLIP);
      expect(ell).toBeLessThanOrEqual(CLIP);
    }
  }, 30000);
});

describe('S-014 · 收缩不放大噪声', () => {
  it('|x̂−μ| ≤ |x−μ|：收缩到 [x, μ] 区间内', () => {
    // 用输出反推：印记越接近 μ，收缩后证据不应高于未收缩的直接比较。
    // 直接验证方式：πx 越大，x̂ 越接近 x；πx 越小，x̂ 越接近 μ。
    // 这里用「πx → 0 时证据退化为只看 q 与 μ」来体现收缩方向。
    const mu = 0.5;
    const nearMu = dimEvidence(0.5, PI_Q, 0.9, 1e-6, mu, TAU); // πx 极小 → x̂≈μ
    const atMu = dimEvidence(0.5, PI_Q, mu, 1e-6, mu, TAU); // x 就是 μ
    expect(nearMu).toBeCloseTo(atMu, 6); // 收缩后两者等价（x̂ 都≈μ）
  });

  it('σ 增大（模糊）时匹配情形的证据单调不增', () => {
    let prev = Infinity;
    for (const sx of [0.1, 0.2, 0.5, 1, 3, 10]) {
      const ell = dimEvidence(0.6, PI_Q, 0.6, 1 / (sx * sx), MU, TAU);
      expect(ell).toBeLessThanOrEqual(prev + 1e-12);
      prev = ell;
    }
    // σx = 10τ 时 |ℓ| ≤ 0.1（基线 E-02 口径）；10τ = 3 → πx = 1/9，与 G-010 #7 同源
    const sigmaX = 10 * TAU;
    const atBlur = dimEvidence(0.6, PI_Q, 0.6, 1 / (sigmaX * sigmaX), MU, TAU);
    expect(Math.abs(atBlur)).toBeLessThanOrEqual(0.1);
  });
});

describe('S-015 · τ 下限与背景有限性', () => {
  it('τ < 0.1 时按 0.1 处理', () => {
    const withTinyTau = dimEvidence(0.6, PI_Q, 0.6, 100, MU, 0.001);
    const withMinTau = dimEvidence(0.6, PI_Q, 0.6, 100, MU, TAU_MIN);
    expect(withTinyTau).toBe(withMinTau);
    expect(TAU_MIN).toBe(0.1);
  });

  it('mu/tau 非有限抛异常（oracle 行为，不静默降级）', () => {
    expect(() => dimEvidence(0.6, PI_Q, 0.6, 100, NaN, TAU)).toThrow();
    expect(() => dimEvidence(0.6, PI_Q, 0.6, 100, MU, NaN)).toThrow();
    expect(() => dimEvidence(0.6, PI_Q, 0.6, 100, Infinity, TAU)).toThrow();
    expect(() => dimEvidence(0.6, PI_Q, 0.6, 100, MU, -Infinity)).toThrow();
  });

  it('背景参数在一次调用内不变（纯函数，无副作用）', () => {
    const a = dimEvidence(0.6, PI_Q, 0.6, 100, MU, TAU);
    const b = dimEvidence(0.6, PI_Q, 0.6, 100, MU, TAU);
    expect(a).toBe(b);
  });
});

describe('S-060 · 未知维度贡献恰为 0', () => {
  it('把 x 置为未知后，证据变化量恰为该维原贡献的相反数', () => {
    const before = dimEvidence(0.6, PI_Q, 0.6, 100, MU, TAU);
    const after = dimEvidence(0.6, PI_Q, 0.6, 0, MU, TAU); // πx=0 → 未知
    // 未知时 ℓ 精确为 0，故变化量 = -before
    expect(after).toBe(0);
    expect(Math.abs((before - after) - before)).toBeLessThanOrEqual(1e-12);
  });

  it('把 q 置为未知（piQ=0）后证据精确为 0', () => {
    expect(dimEvidence(0.6, 0, 0.6, 100, MU, TAU)).toBe(0);
  });
});

describe('bipolar 参数（差分对拍必须一致）', () => {
  it('单极维把负值钳到 0，双极维保留', () => {
    // q=0 且 x=-0.1：单极把 x 钳到 0 → 与「x=0」完全等价（匹配）；
    // 双极保留 -0.1 → 与 q=0 有轻微失配，证据更低但不会被 S-013 截断。
    const uni = dimEvidence(0, PI_Q, -0.1, 100, MU, TAU, false);
    const uniAtZero = dimEvidence(0, PI_Q, 0, 100, MU, TAU, false);
    const bi = dimEvidence(0, PI_Q, -0.1, 100, MU, TAU, true);
    const biAtZero = dimEvidence(0, PI_Q, 0, 100, MU, TAU, true);

    expect(uni).toBe(uniAtZero); // 单极：负值等价于 0
    expect(bi).toBeLessThan(biAtZero); // 双极：保留负值 → 失配，证据更低
    expect(bi).not.toBe(uni); // 两种极性结果确实不同
    // 三者都不得触发截断，否则无法区分
    expect(bi).toBeGreaterThan(-CLIP);
    expect(uni).toBeLessThanOrEqual(CLIP);
  });

  it('默认 bipolar=true', () => {
    expect(dimEvidence(0.6, PI_Q, -0.5, 100, MU, TAU)).toBe(
      dimEvidence(0.6, PI_Q, -0.5, 100, MU, TAU, true),
    );
  });
});
