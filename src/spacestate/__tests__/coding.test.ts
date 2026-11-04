/**
 * S-004 / S-005 / S-006 —— int8 量化、精度对数编码、σ 下限与 ICC 上限
 * 黄金算例 G-004 / G-005 / G-006
 */
import { describe, it, expect } from 'vitest';
import {
  quantizeInt8,
  dequantizeInt8,
  encodePi,
  decodePi,
  clampPi,
  iccPrecisionCap,
} from '../core/coding.js';
import { PI_MAX } from '../core/config.js';

describe('G-004 · int8 量化（S-004）', () => {
  it('量化黄金值全部命中', () => {
    expect(quantizeInt8(0.5)).toBe(64);
    expect(quantizeInt8(-0.5)).toBe(-64);
    expect(quantizeInt8(0.3)).toBe(38);
    expect(quantizeInt8(1.0)).toBe(127);
    expect(quantizeInt8(-1.2)).toBe(-127);
    expect(quantizeInt8(0.0039)).toBe(0);
    expect(quantizeInt8(0.00394)).toBe(1);
  });

  it('反量化 64 → 0.503937（容差 1e-6）', () => {
    expect(Math.abs(dequantizeInt8(64) - 0.503937)).toBeLessThanOrEqual(1e-6);
  });

  it('对称舍入：正负两侧一致（Math.round 的 -63.5 坑不会出现）', () => {
    for (const x of [0.5, 0.3, 0.7, 0.00394, 0.999]) {
      expect(quantizeInt8(-x)).toBe(-quantizeInt8(x));
    }
    // Math.round(-63.5) = -63，而本实现必须给出对称结果
    expect(quantizeInt8(-0.5)).toBe(-quantizeInt8(0.5));
  });

  it('值域截断到 [-127, 127]', () => {
    expect(quantizeInt8(100)).toBe(127);
    expect(quantizeInt8(-100)).toBe(-127);
    expect(quantizeInt8(1.0001)).toBe(127);
    expect(quantizeInt8(-1.0001)).toBe(-127);
  });

  it('-0 归一为 0（避免 Object.is 判等失败）', () => {
    const q = quantizeInt8(-0);
    expect(q).toBe(0);
    expect(Object.is(q, -0)).toBe(false);
    // 极小负值量化到 0 时同样不得留下 -0
    const tiny = quantizeInt8(-0.0001);
    expect(tiny).toBe(0);
    expect(Object.is(tiny, -0)).toBe(false);
  });

  it('量化结果恒为整数且落在 int8 对称值域内', () => {
    for (let i = 0; i < 20000; i++) {
      const x = Math.random() * 4 - 2;
      const q = quantizeInt8(x);
      expect(Number.isInteger(q)).toBe(true);
      expect(Math.abs(q)).toBeLessThanOrEqual(127);
    }
  }, 20000);

  it('反量化误差 ≤ 1/254（半量化步长）', () => {
    for (let i = 0; i < 20000; i++) {
      const x = Math.random() * 2 - 1;
      const err = Math.abs(dequantizeInt8(quantizeInt8(x)) - x);
      expect(err).toBeLessThanOrEqual(1 / 254 + 1e-12);
    }
  }, 20000);
});

describe('G-005 · 精度 uint8 对数编码（S-005）', () => {
  it('π=25 → k=196 → 解码 ≈24.42', () => {
    expect(encodePi(25)).toBe(196);
    const decoded = decodePi(196);
    expect(Math.abs(decoded - 24.42)).toBeLessThanOrEqual(0.005);
    // S-005 校验标准：编码再解码的相对误差 ≤ 2.5%
    expect(Math.abs(decoded - 25) / 25).toBeLessThanOrEqual(0.025);
  });

  it('π=400 → k=255 → 解码 ≈390.8', () => {
    expect(encodePi(400)).toBe(255);
    const decoded = decodePi(255);
    expect(Math.abs(decoded - 390.8)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(decoded - 400) / 400).toBeLessThanOrEqual(0.025);
  });

  it('π=0.002 → k=1 → 解码 ≈0.00256【饱和用例】', () => {
    // E-23 裁决：本用例为 k=1 饱和区用例，不要求 2.5%，只要求解码=边界码值
    expect(encodePi(0.002)).toBe(1);
    const decoded = decodePi(1);
    expect(Math.abs(decoded - 0.00256) / 0.00256).toBeLessThanOrEqual(0.005);
    // 饱和区语义：解码值即最小可编码精度，不可能更接近原 π
    // （实测相对误差 27.95%，属结构性量化损失，非实现缺陷）
    expect(Math.abs(decoded - 0.002) / 0.002).toBeGreaterThan(0.025);
    // 饱和区只要求：解码值 = 边界码值，且对该区所有 π 单调不减
    for (const pi of [0.002, 0.001, 0.0001, 1e-10, 5e-324]) {
      expect(encodePi(pi), `π=${pi}`).toBe(1);
      expect(decodePi(encodePi(pi))).toBeCloseTo(decoded, 12);
    }
  });

  it('π=0 → k=0 → 解码 0（未知）', () => {
    expect(encodePi(0)).toBe(0);
    expect(decodePi(0)).toBe(0);
  });

  it('码值恒在 [0]∪[1,255]，0 只表示未知', () => {
    for (let i = 0; i < 20000; i++) {
      const pi = Math.random() * 500;
      const k = encodePi(pi);
      expect(k === 0 || (k >= 1 && k <= 255)).toBe(true);
      if (k === 0) expect(pi).toBe(0);
    }
  }, 20000);

  it('E-23 非饱和区 k∈[2,254]：编码再解码相对误差 ≤ 2.5%', () => {
    let checked = 0;
    for (let i = 0; i <= 40000; i++) {
      const pi = (i / 40000) * 400;
      const k = encodePi(pi);
      if (k < 2 || k > 254) continue; // 饱和区由专项断言覆盖
      checked++;
      const decoded = decodePi(k);
      expect(Math.abs(decoded - pi) / pi, `π=${pi} k=${k}`).toBeLessThanOrEqual(0.025);
    }
    expect(checked).toBeGreaterThan(1000); // 确认真覆盖到了非饱和区
  }, 20000);

  it('E-23 幂等：全 k∈[1,255] encode(decode(k)) = k', () => {
    for (let k = 1; k <= 255; k++) {
      expect(encodePi(decodePi(k)), `k=${k}`).toBe(k);
    }
  });

  it('E-23 encode 对 π 单调不减（含 π=0 的未知跳变）', () => {
    let prev = -1;
    for (let i = 0; i <= 40000; i++) {
      const pi = (i / 40000) * 400;
      const k = encodePi(pi);
      expect(k, `π=${pi}`).toBeGreaterThanOrEqual(prev);
      prev = k;
    }
    expect(prev).toBe(255);
  }, 20000);

  it('E-01 范围修正：非饱和约 [0.00262, 382]', () => {
    // 下饱和：π < 0.00262 → k=1，解码恒 0.00256
    expect(encodePi(0.0026)).toBe(1);
    expect(encodePi(0.0001)).toBe(1);
    expect(encodePi(1e-10)).toBe(1);
    expect(decodePi(1)).toBeCloseTo(0.00256, 5);
    // 非饱和下端点：π=0.00262 起进入 k=2
    expect(encodePi(0.00262)).toBe(2);
    // 上饱和：π ≥ 382 → k=255，解码 390.8
    expect(encodePi(382)).toBe(255);
    expect(encodePi(400)).toBe(255);
    expect(decodePi(255)).toBeCloseTo(390.8, 1);
    // 非饱和上端点：π=381 仍在 k=254
    expect(encodePi(381)).toBe(254);
  });
});

describe('S-006 · σ 下限与 ICC 精度上限', () => {
  it('σ 下限 0.05 ⟺ π ≤ 400', () => {
    expect(PI_MAX).toBe(400);
    expect(Math.sqrt(1 / PI_MAX)).toBeCloseTo(0.05, 12);
    expect(clampPi(400)).toBe(400);
    expect(clampPi(401)).toBe(400);
    expect(clampPi(1e9)).toBe(400);
    expect(clampPi(399)).toBe(399);
  });

  it('π > 400 传入按 400 截断（编码结果与 400 一致）', () => {
    expect(encodePi(1000)).toBe(encodePi(400));
    expect(clampPi(1000)).toBe(400);
  });

  it('G-006 ICC 精度上限（τ=0.3）', () => {
    expect(iccPrecisionCap(0.5, 0.3)).toBeCloseTo(11.111, 3);
    expect(iccPrecisionCap(0.75, 0.3)).toBeCloseTo(33.333, 3);
    expect(iccPrecisionCap(0.9, 0.3)).toBeCloseTo(100.0, 3);
  });

  it('ICC=1 或 τ=0 时发散，按 σ 下限封顶到 400', () => {
    expect(iccPrecisionCap(1, 0.3)).toBe(400);
    expect(iccPrecisionCap(0.5, 0)).toBe(400);
  });

  it('ICC ≤ 0 无一致性，精度上限为 0', () => {
    expect(iccPrecisionCap(0, 0.3)).toBe(0);
    expect(iccPrecisionCap(-0.2, 0.3)).toBe(0);
  });

  it('ICC > 1 时 (1−ICC) 为负，不得吐出负 π（π 定义域 [0,400]）', () => {
    expect(iccPrecisionCap(1.5, 0.3)).toBe(0);
    expect(iccPrecisionCap(2, 0.3)).toBe(0);
    expect(iccPrecisionCap(1.0000001, 0.3)).toBe(0);
    expect(iccPrecisionCap(Number.MAX_VALUE, 0.3)).toBe(0);
    // 同一 ICC 在不同 τ 下必须同号，不得出现「τ=0 得 400、τ=0.3 得负数」的自相矛盾
    expect(iccPrecisionCap(2, 0)).toBe(400);
    for (const icc of [1.1, 1.5, 2, 10, 1e6]) {
      for (const tau of [0, 0.05, 0.3, 1]) {
        const cap = iccPrecisionCap(icc, tau);
        expect(Number.isFinite(cap), `icc=${icc} tau=${tau}`).toBe(true);
        expect(cap).toBeGreaterThanOrEqual(0);
        expect(cap).toBeLessThanOrEqual(400);
      }
    }
  });

  it('π 定义域 [0,400]：ICC 精度上限全输入域不越界', () => {
    for (let i = 0; i < 20000; i++) {
      const icc = Math.random() * 4 - 1; // 覆盖 [-1,3]，含 ICC>1
      const tau = Math.random() * 2;
      const cap = iccPrecisionCap(icc, tau);
      expect(Number.isFinite(cap)).toBe(true);
      expect(cap).toBeGreaterThanOrEqual(0);
      expect(cap).toBeLessThanOrEqual(400);
    }
  }, 20000);
});

describe('E-25 · 非有限输入分情况口径（π 侧）', () => {
  it('π = NaN → 未知（0）', () => {
    expect(clampPi(NaN)).toBe(0);
    expect(encodePi(NaN)).toBe(0);
  });

  it('π = +∞ → 饱和 400（σ→0 无限精确，不是未知）', () => {
    // 🔴 这是 E-25 与旧 S-007 字面的分歧点：+∞ 与 NaN 处理相反
    expect(clampPi(Infinity)).toBe(400);
    expect(encodePi(Infinity)).toBe(255); // 与 encodePi(400) 同码
    expect(encodePi(Infinity)).toBe(encodePi(400));
  });

  it('π = −∞ 或 π < 0 → 未知（0），负精度无物理意义', () => {
    expect(clampPi(-Infinity)).toBe(0);
    expect(clampPi(-1)).toBe(0);
    expect(clampPi(-1e-300)).toBe(0);
    expect(encodePi(-Infinity)).toBe(0);
    expect(encodePi(-5)).toBe(0);
  });

  it('有限 π 行为不受 E-25 影响', () => {
    expect(clampPi(0)).toBe(0);
    expect(clampPi(0.002)).toBe(0.002);
    expect(clampPi(400)).toBe(400);
    expect(clampPi(401)).toBe(400);
    expect(clampPi(25)).toBe(25);
    expect(encodePi(25)).toBe(196);
    expect(encodePi(400)).toBe(255);
  });

  it('clampPi 全输入域输出有限且落在 [0,400]', () => {
    const samples = [
      NaN, Infinity, -Infinity, -1e9, -0.001, -0, 0, 1e-320, 0.002,
      1, 25, 399, 400, 401, 1e9, Number.MAX_VALUE, Number.MIN_VALUE,
    ];
    for (const pi of samples) {
      const c = clampPi(pi);
      expect(Number.isFinite(c), `π=${pi}`).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(400);
    }
  });
});
