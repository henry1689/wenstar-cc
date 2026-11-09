import { describe, it, expect } from 'vitest';
import { wilsonCI, pairedDiffCI, gateDecision } from '../index.js';

/**
 * MemWen OS 守卫14 —— Wilson 区间 + 配对三态门禁（ADR-024 附录 v2 §7.2）
 * 数学锚点取自附录：n=10、成功率 80% → 95% 区间约 [0.49, 0.94]（宽约 45pp），
 * 这正是「评测扩到 40-50 组」的数学依据。
 */

describe('wilsonCI · 区间报告口径', () => {
  it('n=10、k=8 → 约 [0.49, 0.94]（附录锚点：单点 80% 无统计意义）', () => {
    const ci = wilsonCI(8, 10);
    expect(ci.lo).toBeCloseTo(0.49, 1);
    expect(ci.hi).toBeCloseTo(0.94, 1);
    expect(ci.hi - ci.lo).toBeGreaterThan(0.4); // 宽度 >40pp
  });

  it('n=50、k=40 → 明显收窄（约 22pp 宽）', () => {
    const ci = wilsonCI(40, 50);
    expect(ci.hi - ci.lo).toBeLessThan(0.3);
    expect(ci.hi - ci.lo).toBeGreaterThan(0.15);
  });

  it('全对/全错边界：区间仍覆盖端点且合法', () => {
    const all = wilsonCI(10, 10);
    expect(all.lo).toBeLessThanOrEqual(1);
    expect(all.hi).toBeCloseTo(1, 5);
    const none = wilsonCI(0, 10);
    expect(none.lo).toBeCloseTo(0, 5);
    expect(none.hi).toBeGreaterThan(0);
  });

  it('非法输入 fail-fast', () => {
    expect(() => wilsonCI(1, 0)).toThrow(TypeError);
    expect(() => wilsonCI(11, 10)).toThrow(TypeError);
    expect(() => wilsonCI(-1, 10)).toThrow(TypeError);
  });
});

describe('gateDecision · 配对三态门禁', () => {
  const delta = 0.03;

  it('显著退化（新错旧对的题对占优，CI 上界 < 0）→ block', () => {
    // 0 改善 / 10 退化：d̂ = -1，区间上界必 < 0
    expect(gateDecision({ improved: 0, regressed: 10, n: 50 }, delta)).toBe('block');
  });

  it('下界达标（无显著退化且下界 ≥ -delta）→ pass', () => {
    // 10 改善 / 0 退化：d̂ = +0.2
    expect(gateDecision({ improved: 10, regressed: 0, n: 50 }, delta)).toBe('pass');
    // 无差异：CI = {0,0} → pass
    expect(gateDecision({ improved: 0, regressed: 0, n: 50 }, delta)).toBe('pass');
  });

  it('跨零且下界低于容忍 → review（不自动放行）', () => {
    // 2 改善 / 5 退化于 n=50：d̂ = -0.06，SE≈0.018 → 区间约 [-0.096, -0.024]
    // 上界 ≥ 0 不成立前先看：上界 -0.024 < 0 → 会 block；改用更接近零的构造
    // 4 改善 / 5 退化于 n=50：d̂ = -0.02，SE≈0.019 → 约 [-0.057, 0.017] 跨 0 且 lo < -0.03
    const v = gateDecision({ improved: 4, regressed: 5, n: 50 }, delta);
    expect(v).toBe('review');
  });

  it('容忍度放宽时 review → pass（闭边界方向性）', () => {
    // 3 改善 / 5 退化于 n=50：d̂=-0.04, SE≈0.0563, lo≈-0.150, hi≈0.070
    const p = { improved: 3, regressed: 5, n: 50 };
    // lo(-0.150) < -0.03 → review（不自动放行）
    expect(gateDecision(p, 0.03)).toBe('review');
    // 容忍放宽到 0.2：lo(-0.150) >= -0.2 → pass
    expect(gateDecision(p, 0.2)).toBe('pass');
  });

  it('配对 CI 输入校验 fail-fast', () => {
    expect(() => pairedDiffCI({ improved: 1, regressed: 1, n: 0 })).toThrow(TypeError);
    expect(() => pairedDiffCI({ improved: 40, regressed: 0, n: 30 })).toThrow(TypeError);
  });

  it('退化对为 0 时 SE=0：CI 退化为单点（不抛、不 NaN）', () => {
    const ci = pairedDiffCI({ improved: 0, regressed: 0, n: 50 });
    expect(ci.lo).toBe(0);
    expect(ci.hi).toBe(0);
  });
});
