/**
 * 切片#3 · 多层聚合与权重（S-016 / S-017 / S-018）
 * 黄金算例 G-018 + 打乱顺序属性测试（E-06）
 *
 * 补包 B 第 1 项：打分入口由 `dimWeight` 收敛为 `effectiveWeight`，
 * 私密模式开关在唯一入口内强制生效。
 */
import { describe, it, expect } from 'vitest';
import * as agg from '../core/aggregation.js';
import {
  iccCoefficient,
  effectiveWeight,
  layerEvidence,
  coverage,
  layerCoverage,
  layerAdmitted,
  meetsMinLayers,
  totalEvidence,
  type WeightedTerm,
} from '../core/aggregation.js';
import { posteriorVariance } from '../core/evidence.js';
import {
  COVERAGE_MIN,
  DELTA_MAX,
  ICC_B_SPAN,
  OBSERVE_ONLY_DIMS,
  PRIVATE_ONLY_DIMS,
  resonanceMask,
} from '../core/config.js';

const TAU = 0.3;

/**
 * `privateMode = false` 是**当前唯一生产路径**（私密模式判定来源白皮书未定义）。
 * `true` 分支：契约已就位，功能未启用。
 */
const OFF = { privateMode: false } as const;
const ON = { privateMode: true } as const;

describe('G-018 · 覆盖率', () => {
  it('τ=0.3、πx=100 → v̂=0.009 → cov=0.9', () => {
    const vHat = posteriorVariance(100, TAU);
    expect(vHat).toBeCloseTo(0.009, 12);
    expect(coverage(100, TAU)).toBeCloseTo(0.9, 12);
  });

  it('τ=0.3、πx=0 → cov=0（精确）', () => {
    const vHat = posteriorVariance(0, TAU);
    expect(vHat).toBeCloseTo(0.09, 12); // v̂ = τ² 时 cov 恰为 0
    expect(Math.abs(coverage(0, TAU))).toBeLessThanOrEqual(1e-12);
    expect(Object.is(coverage(0, TAU) + 1, 1)).toBe(true); // cov 精确为 0
  });

  it('πx 越大覆盖越高（单调不减）', () => {
    let prev = -Infinity;
    for (const piX of [0, 1, 5, 25, 100, 400]) {
      const c = coverage(piX, TAU);
      expect(c).toBeGreaterThanOrEqual(prev);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      prev = c;
    }
  });

  it('层覆盖率 = 各维平均；空层为 0', () => {
    expect(layerCoverage([100, 100], TAU)).toBeCloseTo(0.9, 12);
    expect(layerCoverage([0, 0], TAU)).toBeCloseTo(0, 12);
    expect(layerCoverage([100, 0], TAU)).toBeCloseTo(0.45, 12);
    expect(layerCoverage([], TAU)).toBe(0);
  });
});

describe('S-017 · 维度权重', () => {
  it('A 级 r=1，权重 = base', () => {
    expect(iccCoefficient(0.9, 'A')).toBe(1);
    expect(effectiveWeight('D01', 0.5, 0.9, 'A', OFF)).toBeCloseTo(0.5, 12);
  });

  it('C 级 r=0，权重 = 0', () => {
    expect(iccCoefficient(0.1, 'C')).toBe(0);
    expect(effectiveWeight('D01', 0.5, 0.1, 'C', OFF)).toBe(0);
  });

  it('B 级 r=(ICC−0.5)/0.25 钳到 [0,1]', () => {
    expect(ICC_B_SPAN).toBe(0.25);
    expect(iccCoefficient(0.5, 'B')).toBeCloseTo(0, 12);
    expect(iccCoefficient(0.625, 'B')).toBeCloseTo(0.5, 12);
    expect(iccCoefficient(0.75, 'B')).toBeCloseTo(1, 12);
    // 越界钳位：低于 0.5 得负值→钳 0；高于 0.75 得超 1→钳 1
    expect(iccCoefficient(0.3, 'B')).toBe(0);
    expect(iccCoefficient(0.99, 'B')).toBe(1);
  });

  it('|δ| ≤ 0.3 被强制钳位', () => {
    expect(DELTA_MAX).toBe(0.3);
    expect(effectiveWeight('D01', 1, 1, 'A', OFF, 0.3)).toBeCloseTo(1.3, 12);
    expect(effectiveWeight('D01', 1, 1, 'A', OFF, -0.3)).toBeCloseTo(0.7, 12);
    // 越界 δ 被钳回 ±0.3
    expect(effectiveWeight('D01', 1, 1, 'A', OFF, 5)).toBeCloseTo(1.3, 12);
    expect(effectiveWeight('D01', 1, 1, 'A', OFF, -5)).toBeCloseTo(0.7, 12);
  });

  it('E-14 细化：D29/D30 只观测恒 0；D20 由私密模式开关控制', () => {
    expect([...OBSERVE_ONLY_DIMS]).toEqual(['D29', 'D30']);
    for (const dim of OBSERVE_ONLY_DIMS) {
      // 即使 base、ICC、δ 都给满，也必须是 0
      // （依赖指标不得作为任何优化目标，S-067 消融不变性）
      expect(effectiveWeight(dim, 1, 1, 'A', OFF, 0.3), dim).toBe(0);
      expect(effectiveWeight(dim, 1, 1, 'A', ON, 0.3), dim).toBe(0);
      expect(effectiveWeight(dim, 1, 1, 'A', OFF), dim).toBe(0);
    }

    // 🔴 D20 不再被锁死：权重本身正常算出，是否参与由开关决定
    expect([...PRIVATE_ONLY_DIMS]).toEqual(['D20']);
    expect(resonanceMask('D20', false)).toBe(0);
    expect(resonanceMask('D20', true)).toBe(1);
    // 只观测维度在私密模式下也仍是 0
    expect(resonanceMask('D29', true)).toBe(0);
    // 普通维度不受开关影响
    expect(resonanceMask('D21', false)).toBe(1);
    expect(resonanceMask('D01', true)).toBe(1);

    // 同 base 的普通维度不受影响
    expect(effectiveWeight('D21', 1, 1, 'A', OFF)).toBe(1);
  });

  it('权重恒非负（r_ICC ∈ [0,1] 且 1+δ ≥ 0.7）', () => {
    for (const grade of ['A', 'B', 'C'] as const) {
      for (const icc of [0, 0.3, 0.5, 0.6, 0.75, 1]) {
        const w = effectiveWeight('D01', 0.8, icc, grade, OFF, 0);
        expect(Number.isFinite(w)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ============ 补包 B 第 1 项：effectiveWeight 是唯一打分入口 ============

describe('effectiveWeight · 唯一打分入口', () => {
  it('D20：privateMode=false → 0；true → 非 0', () => {
    expect(effectiveWeight('D20', 1, 1, 'A', OFF, 0.3)).toBe(0);
    expect(effectiveWeight('D20', 1, 1, 'A', ON, 0.3)).not.toBe(0);
    expect(effectiveWeight('D20', 1, 1, 'A', ON, 0.3)).toBeCloseTo(1.3, 12);
  });

  it('🔴 保守规则：privateMode 非 true 的任何值（含 undefined）一律视为关', () => {
    // 漏传 / 传错 → 落到安全侧（D20 不参与），而不是「真值判断」放行
    const cases = [
      { privateMode: undefined },
      { privateMode: null },
      { privateMode: 1 },
      { privateMode: 'true' },
      {},
    ];
    for (const ctx of cases) {
      const w = effectiveWeight(
        'D20',
        1,
        1,
        'A',
        ctx as unknown as { privateMode: boolean },
        0.3,
      );
      expect(w, JSON.stringify(ctx)).toBe(0);
    }
  });

  it("🔴 'dimWeight' 已不再导出（漏乘风险在类型层消除）", () => {
    expect('dimWeight' in agg).toBe(false);
    expect('rawDimWeight' in agg).toBe(false);
    expect('effectiveWeight' in agg).toBe(true);
  });

  it('只观测维度即使 privateMode=true 也恒 0', () => {
    expect(effectiveWeight('D29', 1, 1, 'A', ON, 0.3)).toBe(0);
    expect(effectiveWeight('D30', 1, 1, 'A', ON, 0.3)).toBe(0);
  });

  it('普通维度与私密模式无关', () => {
    expect(effectiveWeight('D01', 0.5, 0.9, 'A', OFF)).toBe(
      effectiveWeight('D01', 0.5, 0.9, 'A', ON),
    );
  });

  it('ctx 为只读引用，不可被就地改写影响结果', () => {
    const ctx = { privateMode: true };
    const before = effectiveWeight('D20', 1, 1, 'A', ctx, 0.3);
    expect(before).toBeCloseTo(1.3, 12);
    expect(() => {
      (ctx as { privateMode: boolean }).privateMode = false;
    }).not.toThrow(); // JS 层拦不住，但每次调用都重新读 ctx，结果不被缓存
    expect(effectiveWeight('D20', 1, 1, 'A', { privateMode: false }, 0.3)).toBe(0);
  });
});

describe('S-016 · 层内聚合', () => {
  const terms: WeightedTerm[] = [
    { index: 5, w: 0.5, ell: 2 },
    { index: 1, w: 0.5, ell: 1 },
    { index: 3, w: 1, ell: -1 },
  ];

  it('按维度下标升序求和（E-06），与传入顺序无关', () => {
    // 升序：1 → 3 → 5 = 0.5*1 + 1*(-1) + 0.5*2 = 0.5 - 1 + 1 = 0.5
    expect(layerEvidence(terms)).toBeCloseTo(0.5, 12);
    const shuffled = [terms[2], terms[0], terms[1]];
    expect(layerEvidence(shuffled)).toBeCloseTo(0.5, 12);
    expect(layerEvidence([terms[1], terms[2], terms[0]])).toBeCloseTo(0.5, 12);
  });

  it('打乱输入顺序后结果差 ≤ 1e-12（属性测试）', () => {
    // 构造一批随机项，多种排列下结果必须逐位一致
    const base: WeightedTerm[] = [];
    for (let i = 0; i < 40; i++) {
      base.push({ index: i, w: Math.random(), ell: Math.random() * 6 - 3 });
    }
    const reference = layerEvidence(base);

    for (let trial = 0; trial < 200; trial++) {
      const shuffled = [...base];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const got = layerEvidence(shuffled);
      expect(Math.abs(got - reference), `trial ${trial}`).toBeLessThanOrEqual(1e-12);
    }
  }, 30000);

  it('空层聚合为 0', () => {
    expect(layerEvidence([])).toBe(0);
  });

  it('权重为 0 的项不贡献', () => {
    const withZero = [{ index: 0, w: 0, ell: 3 }, { index: 1, w: 1, ell: 2 }];
    expect(layerEvidence(withZero)).toBeCloseTo(2, 12);
  });
});

describe('S-018 · 层准入', () => {
  const base = { mask: 1, coverageSelf: 0.9, coverageUserEst: 0.9, evidence: 1, threshold: 0.5 };

  it('三条件全满足 → 准入', () => {
    expect(layerAdmitted(base)).toBe(true);
  });

  it('条件1：掩码 = 0 → 拒绝（层未激活）', () => {
    expect(layerAdmitted({ ...base, mask: 0 })).toBe(false);
    expect(layerAdmitted({ ...base, mask: 0.3 })).toBe(true); // > 0 即激活
  });

  it('条件2：任一侧覆盖率 < 0.3 → 拒绝', () => {
    expect(COVERAGE_MIN).toBe(0.3);
    expect(layerAdmitted({ ...base, coverageSelf: 0.29 })).toBe(false);
    expect(layerAdmitted({ ...base, coverageUserEst: 0.29 })).toBe(false);
    expect(layerAdmitted({ ...base, coverageSelf: 0.3 })).toBe(true); // 恰好等于下限算通过
    expect(layerAdmitted({ ...base, coverageUserEst: 0.3 })).toBe(true);
  });

  it('条件3：E_L < θ_L → 拒绝', () => {
    expect(layerAdmitted({ ...base, evidence: 0.49 })).toBe(false);
    expect(layerAdmitted({ ...base, evidence: 0.5 })).toBe(true); // 恰好等于阈值算通过
  });

  it('minLayers 不足返回空，且绝不自动降阈值', () => {
    expect(meetsMinLayers(3, 3)).toBe(true);
    expect(meetsMinLayers(2, 3)).toBe(false);
    expect(meetsMinLayers(0, 1)).toBe(false);
    // 关键：不达标时不会把阈值改小来凑数——这里验证判断只看计数
    expect(meetsMinLayers(2, 3)).toBe(false);
    expect(meetsMinLayers(3, 3)).toBe(true);
  });
});

describe('S-016 · 总证据', () => {
  it('E = Σ m_L·E_L（m_L 本切片固定 1）', () => {
    expect(totalEvidence([1, 2, 3])).toBe(6);
    expect(totalEvidence([])).toBe(0);
    expect(totalEvidence([0.5, -0.5])).toBe(0);
  });

  it('只计已通过准入的层：被拒层不进求和', () => {
    const layers = [
      { admitted: true, e: 1.5 },
      { admitted: false, e: 9 }, // 被拒，不能算进来
      { admitted: true, e: 0.5 },
    ];
    const admitted = layers.filter((l) => l.admitted).map((l) => l.e);
    expect(totalEvidence(admitted)).toBeCloseTo(2, 12);
    expect(totalEvidence(admitted)).not.toBeCloseTo(11, 12);
  });

  it('打乱层顺序结果差 ≤ 1e-12（E-06 层间同样固定顺序）', () => {
    const es = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
    const ref = totalEvidence(es);
    const rev = totalEvidence([...es].reverse());
    expect(Math.abs(ref - rev)).toBeLessThanOrEqual(1e-12);
  });
});