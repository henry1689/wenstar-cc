/**
 * S-009 · 昼夜相位按本地时间 —— 黄金算例 G-009
 */
import { describe, it, expect } from 'vitest';
import { phaseFromLocalMinutes } from '../core/dial.js';
import { PI_MAX } from '../core/config.js';

/** 精确值容差 1e-9（G-009） */
const TOL = 1e-9;
/** 0 值允许的浮点残差 |x| ≤ 1e-12（G-009） */
const ZERO_TOL = 1e-12;

describe('G-009 · 昼夜相位（S-009）', () => {
  it('00:00 → (sin 0, cos 1) = (0, 1)', () => {
    const p = phaseFromLocalMinutes(0);
    expect(Math.abs(p.sin - 0)).toBeLessThanOrEqual(ZERO_TOL);
    expect(Math.abs(p.cos - 1)).toBeLessThanOrEqual(TOL);
    expect(p.pi).toBe(400);
  });

  it('06:00 → (1, 0)', () => {
    const p = phaseFromLocalMinutes(360);
    expect(Math.abs(p.sin - 1)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(p.cos - 0)).toBeLessThanOrEqual(ZERO_TOL);
  });

  it('18:00 → (-1, 0)', () => {
    const p = phaseFromLocalMinutes(1080);
    expect(Math.abs(p.sin - -1)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(p.cos - 0)).toBeLessThanOrEqual(ZERO_TOL);
  });

  it('21:00 → (-0.707106781187, 0.707106781187)【E-24 展示值改 12 位】', () => {
    const p = phaseFromLocalMinutes(1260);
    // E-24 裁决：测试直接与 Math.SQRT1_2 闭式比较，不依赖十进制字面量
    expect(Math.abs(p.sin - -Math.SQRT1_2)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(p.cos - Math.SQRT1_2)).toBeLessThanOrEqual(TOL);
    // 12 位展示值核对（E-24 已把原 6 位 0.707107 改为 12 位）
    expect(Math.abs(p.sin - -0.707106781187)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(p.cos - 0.707106781187)).toBeLessThanOrEqual(1e-12);
  });

  it('精度固定 π = 400', () => {
    for (const minutes of [0, 360, 720, 1080, 1439]) {
      expect(phaseFromLocalMinutes(minutes).pi).toBe(PI_MAX);
      expect(phaseFromLocalMinutes(minutes).pi).toBe(400);
    }
  });

  it('单位向量：sin²+cos² = 1', () => {
    for (let minutes = 0; minutes < 1440; minutes += 7) {
      const p = phaseFromLocalMinutes(minutes);
      expect(Math.abs(p.sin * p.sin + p.cos * p.cos - 1)).toBeLessThanOrEqual(1e-12);
    }
  });

  it('23:59 与 00:01 相邻（跨零点不跳变）', () => {
    const lastMinute = phaseFromLocalMinutes(1439);
    const firstMinute = phaseFromLocalMinutes(1);
    const chord = Math.hypot(lastMinute.sin - firstMinute.sin, lastMinute.cos - firstMinute.cos);
    // 2 分钟的弦长 = 2·sin(π·2/1440) ≈ 0.00873
    expect(chord).toBeLessThan(0.01);
    // 对照：同一时刻的对跖点相距约 2，说明确实是「相邻」而非「相对」
    const opposite = phaseFromLocalMinutes(720);
    const far = Math.hypot(lastMinute.sin - opposite.sin, lastMinute.cos - opposite.cos);
    expect(far).toBeGreaterThan(1.5);
  });

  it('E-24 边界：输入 1440 分钟按 mod 1440 回绕，与 0 分钟等价', () => {
    const midnight = phaseFromLocalMinutes(0);
    const wrapped = phaseFromLocalMinutes(1440);
    expect(wrapped.sin).toBeCloseTo(midnight.sin, 12);
    expect(wrapped.cos).toBeCloseTo(midnight.cos, 12);
    expect(wrapped.pi).toBe(midnight.pi);
    // 多圈回绕同样成立
    expect(phaseFromLocalMinutes(1440 * 3).sin).toBeCloseTo(midnight.sin, 12);
    expect(phaseFromLocalMinutes(1440 * 3).cos).toBeCloseTo(midnight.cos, 12);
  });

  it('分钟数按天归一：负数亦归一', () => {
    const midnight = phaseFromLocalMinutes(0);
    expect(phaseFromLocalMinutes(1440).sin).toBeCloseTo(midnight.sin, 12);
    expect(phaseFromLocalMinutes(1440).cos).toBeCloseTo(midnight.cos, 12);
    const negative = phaseFromLocalMinutes(-60);
    const equivalent = phaseFromLocalMinutes(1440 - 60);
    expect(negative.sin).toBeCloseTo(equivalent.sin, 12);
    expect(negative.cos).toBeCloseTo(equivalent.cos, 12);
  });

  it('非有限分钟数 → 未知（pi=0，无 NaN）', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const p = phaseFromLocalMinutes(bad);
      expect(p.pi).toBe(0);
      expect(Number.isFinite(p.sin)).toBe(true);
      expect(Number.isFinite(p.cos)).toBe(true);
      expect(Number.isNaN(p.sin)).toBe(false);
      expect(Number.isNaN(p.cos)).toBe(false);
    }
  });
});
