/**
 * S-003 / S-007 —— DimReading 结构契约、NaN/±Infinity 视为未知
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DimReading,
  UNKNOWN_READING,
  isKnown,
  normalizeReading,
} from '../core/types.js';
import {
  quantizeInt8,
  dequantizeInt8,
  encodePi,
  decodePi,
  clampPi,
  iccPrecisionCap,
} from '../core/coding.js';
import { phaseFromLocalMinutes } from '../core/dial.js';

describe('S-003 · DimReading 结构', () => {
  it('pi=0 时整条读数规范化为未知（整改 B，与 oracle 返回 (0,0) 对齐）', () => {
    const r = normalizeReading({ v: 0.9, pi: 0, src: 'test' }, 'D01');
    expect(r.reading.pi).toBe(0);
    expect(isKnown(r.reading)).toBe(false);
    // 整改 B：pi=0（及 -0）一律归 UNKNOWN_READING，v 归 0，不再保留原值
    expect(r.reading.v).toBe(0);
    expect(r.flag).toBe(null);
    expect(r.truncated).toBe(false);
    // -0 同样规范化
    const neg = normalizeReading({ v: 0.9, pi: -0, src: 'test' }, 'D01');
    expect(neg.reading.pi).toBe(0);
    expect(Object.is(neg.reading.pi, -0)).toBe(false);
  });

  it('pi>0 时读数已知', () => {
    const r = normalizeReading({ v: 0.4, pi: 12, src: 'test' }, 'D01');
    expect(isKnown(r.reading)).toBe(true);
    expect(r.reading.v).toBe(0.4);
    expect(r.reading.pi).toBe(12);
    expect(r.reading.src).toBe('test');
  });

  it('未知读数的 pi 恒为 0', () => {
    expect(UNKNOWN_READING.pi).toBe(0);
    expect(isKnown(UNKNOWN_READING)).toBe(false);
    expect(Object.isFrozen(UNKNOWN_READING)).toBe(true);
  });

  it('isKnown 要求 v 有限 且 π>0 且非 NaN（整改 1 / 整改 C / E-25）', () => {
    // E-25：π=+∞ 是 σ→0 无限精确，未规范化时不得被误判为未知（整改 C 去掉 isFinite）
    expect(isKnown({ v: 0.5, pi: Infinity, src: 'x' })).toBe(true);
    // 整改 1：v 非有限时即使 π 正常也算未知——否则 NaN 会被当有效值读出去
    expect(isKnown({ v: NaN, pi: 100, src: 'x' })).toBe(false);
    expect(isKnown({ v: Infinity, pi: 100, src: 'x' })).toBe(false);
    expect(isKnown({ v: NaN, pi: Infinity, src: 'x' })).toBe(false);
    // NaN 精度仍是未知
    expect(isKnown({ v: 0.5, pi: NaN, src: 'x' })).toBe(false);
    // 负精度 / 零精度是未知
    expect(isKnown({ v: 0.5, pi: -Infinity, src: 'x' })).toBe(false);
    expect(isKnown({ v: 0.5, pi: -1, src: 'x' })).toBe(false);
    expect(isKnown({ v: 0.5, pi: 0, src: 'x' })).toBe(false);
    expect(isKnown({ v: 0.5, pi: 1e-9, src: 'x' })).toBe(true);
    expect(isKnown({ v: 0, pi: 25, src: 'x' })).toBe(true);
  });

  it('类型定义里不出现 sigma / variance 字段（静态审查）', () => {
    const raw = readFileSync(fileURLToPath(new URL('../core/types.ts', import.meta.url)), 'utf8');
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
      .replace(/"(?:[^"\\]|\\.)*"/g, ' ');
    expect(stripped).not.toMatch(/\b(sigma|variance)\s*[?:]/i);
  });

  it('精度越界被截断到 [0,400] 并标记（S-006 由读数入口统一执行）', () => {
    expect(normalizeReading({ v: 0.5, pi: 1000, src: 't' }, 'D01')).toEqual({
      reading: { v: 0.5, pi: 400, src: 't' },
      flag: null, // 🔴 π 有限但 >400 = 常规截断，不是异常，不计入异常计数
      truncated: true,
    });
    expect(normalizeReading({ v: 0.5, pi: -5, src: 't' }, 'D01').reading.pi).toBe(0);
    expect(normalizeReading({ v: 0.5, pi: 200, src: 't' }, 'D01').truncated).toBe(false);
  });

  it('值域越界被截断并标记（S-002）', () => {
    const r = normalizeReading({ v: 1.7, pi: 10, src: 't' }, 'D01');
    expect(r.reading.v).toBe(1);
    expect(r.truncated).toBe(true);
    const r2 = normalizeReading({ v: -0.4, pi: 10, src: 't' }, 'D04');
    expect(r2.reading.v).toBe(0);
    expect(r2.truncated).toBe(true);
  });
});

describe('S-007 + E-25 · 非有限输入与负精度', () => {
  const hostileValues = [NaN, Infinity, -Infinity];
  // E-25 属性测试扩充：π 侧额外注入负精度（−∞ / 负有限值）
  const hostilePi = [NaN, Infinity, -Infinity, -1, -0.5, -1e-10];

  // 10⁵ 组是 S-007 规约硬性要求，不可减量；全量套件并行时 CPU 竞争
  // 会超过 vitest 默认 5s 超时（单跑约 0.7s），故显式放宽到 30s。
  it('10⁵ 组带 NaN / ±∞ / 负精度输入：输出全有限，未知读数贡献恰好为 0', () => {
    let nonFiniteOutputs = 0;
    let hostileRounds = 0;

    for (let i = 0; i < 100000; i++) {
      // 约 1/5 的样本注入恶意输入，其余为随机值
      const inject = i % 5 === 0;
      if (inject) hostileRounds++;
      const v = inject ? hostileValues[i % hostileValues.length] : Math.random() * 6 - 3;
      const pi = inject ? hostilePi[i % hostilePi.length] : Math.random() * 500;

      const normalized = normalizeReading({ v, pi, src: 'prop' }, 'D01');
      const q = quantizeInt8(v);
      const dq = dequantizeInt8(q);
      const k = encodePi(pi);
      const decoded = decodePi(k);
      const clamped = clampPi(pi);
      const phase = phaseFromLocalMinutes(v);
      const cap = iccPrecisionCap(v, pi);

      const outputs = [
        normalized.reading.v,
        normalized.reading.pi,
        q,
        dq,
        k,
        decoded,
        clamped,
        phase.sin,
        phase.cos,
        phase.pi,
        cap,
      ];

      for (const out of outputs) {
        if (!Number.isFinite(out)) nonFiniteOutputs++;
      }

      // —— E-25 分情况断言 ——
      // ① v/q/x = NaN 或 ±∞ → 读数未知；🔴 不得把 +∞ 截成边界值凭空造强证据
      if (!Number.isFinite(v)) {
        expect(normalized.reading.pi, `v=${v}`).toBe(0);
        expect(isKnown(normalized.reading)).toBe(false);
      }
      // ② π = +∞ → 饱和 400，**不得**当未知
      if (Number.isFinite(v) && pi === Infinity) {
        expect(normalized.reading.pi).toBe(400);
        expect(normalized.truncated).toBe(true);
      }
      // ③ π = −∞ 或 π < 0 → 未知并计数
      if (Number.isFinite(v) && (pi === -Infinity || (Number.isFinite(pi) && pi < 0))) {
        expect(normalized.reading.pi).toBe(0);
        expect(normalized.truncated).toBe(true);
      }
      // ④ π = NaN → 未知
      if (Number.isFinite(v) && Number.isNaN(pi)) {
        expect(normalized.reading.pi).toBe(0);
      }
      // 未知读数 → pi=0：下游证据贡献公式中 pi=0 即贡献恰好为 0
      if (!isKnown(normalized.reading)) {
        expect(normalized.reading.pi).toBe(0);
        // 未知读数不得残留非有限 v，否则下游仍可能凭大值造证据
        expect(Number.isFinite(normalized.reading.v)).toBe(true);
      }
      // 已知读数的 π 必须落在定义域 [0,400]
      if (isKnown(normalized.reading)) {
        expect(normalized.reading.pi).toBeGreaterThanOrEqual(0);
        expect(normalized.reading.pi).toBeLessThanOrEqual(400);
      }
    }

    expect(hostileRounds).toBeGreaterThan(0);
    expect(nonFiniteOutputs).toBe(0);
  }, 30000);

  it('flag 字符串与 Python oracle 逐字对齐（五值）', () => {
    const flag = (r: { v: number; pi: number }, dim: 'D01' | 'D04' = 'D01') =>
      normalizeReading({ ...r, src: 't' }, dim).flag;

    // 前四个 = 异常，计数
    expect(flag({ v: 0.5, pi: NaN })).toBe('nan');
    expect(flag({ v: 0.5, pi: Infinity })).toBe('pos_inf');
    expect(flag({ v: 0.5, pi: -Infinity })).toBe('negative');
    expect(flag({ v: 0.5, pi: -1 })).toBe('negative');
    expect(flag({ v: NaN, pi: 100 })).toBe('bad_value');
    expect(flag({ v: Infinity, pi: 100 })).toBe('bad_value');
    expect(flag({ v: -Infinity, pi: 100 })).toBe('bad_value');

    // 值域钳位 = range_clamped（仅在无更高优先级异常时出现）
    expect(flag({ v: 1.5, pi: 10 })).toBe('range_clamped'); // 双极越上界
    expect(flag({ v: -0.4, pi: 10 }, 'D04')).toBe('range_clamped'); // 单极越下界
    expect(flag({ v: 0.5, pi: 10 })).toBe(null); // 正常

    // 🔴 优先级：更高优先级异常盖过 range_clamped
    expect(flag({ v: 1.5, pi: NaN })).toBe('nan'); // 不是 range_clamped
    expect(flag({ v: 1.5, pi: Infinity })).toBe('pos_inf');
    expect(flag({ v: 1.5, pi: -1 })).toBe('negative');
    expect(flag({ v: Infinity, pi: 10 })).toBe('bad_value');

    // 🔴 π 有限但 >400 → flag=null（常规截断不算异常），但 truncated=true
    const over = normalizeReading({ v: 0.5, pi: 1000, src: 't' }, 'D01');
    expect(over.flag).toBe(null);
    expect(over.truncated).toBe(true);
    expect(over.reading.pi).toBe(400);

    // π=0 → null 且 truncated=false
    const zero = normalizeReading({ v: 0.5, pi: 0, src: 't' }, 'D01');
    expect(zero.flag).toBe(null);
    expect(zero.truncated).toBe(false);
  });

  it('单极/双极由 dim 决定，差分时须把 bipolar 一起喂给 oracle', () => {
    // 同一个 v=-0.4：双极合法，单极越界
    const bipolar = normalizeReading({ v: -0.4, pi: 10, src: 't' }, 'D01'); // D01 双极
    const unipolar = normalizeReading({ v: -0.4, pi: 10, src: 't' }, 'D04'); // D04 单极
    expect(bipolar.flag).toBe(null);
    expect(bipolar.reading.v).toBe(-0.4);
    expect(unipolar.flag).toBe('range_clamped');
    expect(unipolar.reading.v).toBe(0);
    expect(unipolar.truncated).toBe(true);
  });

  it('E-25 分情况表逐条钉死', () => {
    const read = (r: { v: number; pi: number }) => normalizeReading({ ...r, src: 't' }, 'D01');

    // π = NaN → 未知（π=0）
    expect(read({ v: 0.5, pi: NaN }).reading.pi).toBe(0);
    // π = +∞ → 饱和 400（σ→0 无限精确，不是未知）
    expect(read({ v: 0.5, pi: Infinity }).reading.pi).toBe(400);
    expect(read({ v: 0.5, pi: Infinity }).truncated).toBe(true);
    // π = −∞ 或 π < 0 → 未知并计数
    expect(read({ v: 0.5, pi: -Infinity }).reading.pi).toBe(0);
    expect(read({ v: 0.5, pi: -Infinity }).truncated).toBe(true);
    expect(read({ v: 0.5, pi: -1 }).reading.pi).toBe(0);
    expect(read({ v: 0.5, pi: -1 }).truncated).toBe(true);
    // v = NaN 或 ±∞ → 该读数未知（不得截成边界值）
    for (const badV of [NaN, Infinity, -Infinity]) {
      const r = read({ v: badV, pi: 400 });
      expect(r.reading.pi, `v=${badV}`).toBe(0);
      expect(Number.isFinite(r.reading.v)).toBe(true);
    }
    // 有限合规输入不受影响
    const ok = read({ v: 0.5, pi: 25 });
    expect(ok.reading).toEqual({ v: 0.5, pi: 25, src: 't' });
    expect(ok.truncated).toBe(false);
  });

  it('NaN 输入的读数按 pi=0 处理', () => {
    expect(normalizeReading({ v: NaN, pi: 100, src: 't' }, 'D01').reading.pi).toBe(0);
    expect(normalizeReading({ v: 0.5, pi: NaN, src: 't' }, 'D01').reading.pi).toBe(0);
    expect(normalizeReading({ v: Infinity, pi: 100, src: 't' }, 'D01').reading.pi).toBe(0);
    expect(normalizeReading({ v: 0.5, pi: -Infinity, src: 't' }, 'D01').reading.pi).toBe(0);
  });

  it('编码层对非有限输入不吐 NaN', () => {
    expect(Number.isFinite(quantizeInt8(NaN))).toBe(true);
    expect(Number.isFinite(quantizeInt8(Infinity))).toBe(true);
    expect(Number.isFinite(dequantizeInt8(NaN))).toBe(true);
    expect(Number.isFinite(encodePi(NaN))).toBe(true);
    expect(Number.isFinite(encodePi(Infinity))).toBe(true);
    expect(Number.isFinite(decodePi(NaN))).toBe(true);
    expect(Number.isFinite(clampPi(NaN))).toBe(true);
    expect(Number.isFinite(phaseFromLocalMinutes(NaN).sin)).toBe(true);
    expect(Number.isFinite(iccPrecisionCap(NaN, NaN))).toBe(true);
  });
});
