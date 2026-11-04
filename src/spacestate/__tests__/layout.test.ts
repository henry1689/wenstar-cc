/**
 * S-001 / S-002 / S-008 —— 79 维布局、值域表、D27 存储精度
 *
 * 期望值全部按基线规约**独立程序化生成**，与实现侧的字面量数组互不依赖，
 * 任何一侧错位都会被比对抓出。
 */
import { describe, it, expect } from 'vitest';
import {
  LAYOUT,
  isBipolar,
  D27_STORAGE_INDICES,
  stampStoragePrecision,
  type Block,
  type DimId,
} from '../core/layout.js';
import { normalizeReading } from '../core/types.js';

/** 经读数规范化入口取值（clampToRange 是内部原语，不对外导出） */
function readValue(v: number, dim: DimId): number {
  return normalizeReading({ v, pi: 10, src: 't' }, dim).reading.v;
}

/** 经读数规范化入口取截断标记 */
function isTruncated(v: number, dim: DimId): boolean {
  return normalizeReading({ v, pi: 10, src: 't' }, dim).truncated;
}

/** 按 S-001 规约独立生成期望布局 */
function expectedLayout(): { block: Block; dim: string }[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const out: { block: Block; dim: string }[] = [];
  for (let i = 32; i <= 40; i++) out.push({ block: 'scene', dim: `D${i}` });
  for (let i = 1; i <= 31; i++) out.push({ block: 'self', dim: `D${pad(i)}` });
  for (let i = 1; i <= 31; i++) out.push({ block: 'user_est', dim: `D${pad(i)}` });
  for (let i = 1; i <= 8; i++) out.push({ block: 'dyad', dim: `Y${i}` });
  return out;
}

/** S-002 规约原文列出的双极维（独立于实现的 BIPOLAR_DIMS 书写一遍） */
const EXPECTED_BIPOLAR = new Set([
  'D01', 'D02', 'D03', 'D05', 'D06', 'D07', 'D09', 'D11', 'D14', 'D15', 'D31',
  'D32', 'D34', 'D36', 'D37', 'D38', 'D39', 'D40',
  'Y2', 'Y4', 'Y7', 'Y8',
]);

describe('S-001 · 79 维布局', () => {
  it('LAYOUT 正好 79 项', () => {
    expect(LAYOUT).toHaveLength(79);
  });

  it('每一项的（块，维度编号）与规约逐项一致', () => {
    const expected = expectedLayout();
    expect(LAYOUT).toHaveLength(expected.length);
    expected.forEach((want, i) => {
      expect(LAYOUT[i].block, `下标 ${i}`).toBe(want.block);
      expect(LAYOUT[i].dim, `下标 ${i}`).toBe(want.dim);
    });
  });

  it('四个块的下标范围边界钉死', () => {
    expect(LAYOUT[0]).toEqual({ block: 'scene', dim: 'D32' });
    expect(LAYOUT[8]).toEqual({ block: 'scene', dim: 'D40' });
    expect(LAYOUT[9]).toEqual({ block: 'self', dim: 'D01' });
    expect(LAYOUT[39]).toEqual({ block: 'self', dim: 'D31' });
    expect(LAYOUT[40]).toEqual({ block: 'user_est', dim: 'D01' });
    expect(LAYOUT[70]).toEqual({ block: 'user_est', dim: 'D31' });
    expect(LAYOUT[71]).toEqual({ block: 'dyad', dim: 'Y1' });
    expect(LAYOUT[78]).toEqual({ block: 'dyad', dim: 'Y8' });
  });

  it('各块维度数为 9 / 31 / 31 / 8', () => {
    const count = (block: Block) => LAYOUT.filter((e) => e.block === block).length;
    expect(count('scene')).toBe(9);
    expect(count('self')).toBe(31);
    expect(count('user_est')).toBe(31);
    expect(count('dyad')).toBe(8);
  });
});

describe('S-002 · 值域表', () => {
  it('每一维的双极/单极判定与规约一致', () => {
    for (const entry of LAYOUT) {
      expect(
        isBipolar(entry.dim),
        `${entry.block}.${entry.dim} 应为${EXPECTED_BIPOLAR.has(entry.dim) ? '双极' : '单极'}`,
      ).toBe(EXPECTED_BIPOLAR.has(entry.dim));
    }
  });

  it('双极维按维度编号判定，与块无关（self/user_est 同名维度同值域）', () => {
    expect(isBipolar('D01')).toBe(true);
    expect(isBipolar('D33')).toBe(false);
    expect(isBipolar('D35')).toBe(false);
    expect(isBipolar('Y1')).toBe(false);
    expect(isBipolar('Y2')).toBe(true);
    expect(isBipolar('Y3')).toBe(false);
    expect(isBipolar('Y5')).toBe(false);
    expect(isBipolar('Y6')).toBe(false);
    expect(isBipolar('Y7')).toBe(true);
    expect(isBipolar('Y8')).toBe(true);
    expect(isBipolar('Y4')).toBe(true);
  });

  it('双极维越界截断到 [-1,1]，单极维截断到 [0,1]', () => {
    // D01 双极、D04 单极
    expect(readValue(1.5, 'D01')).toBe(1);
    expect(readValue(-1.5, 'D01')).toBe(-1);
    expect(readValue(1.5, 'D04')).toBe(1);
    expect(readValue(-0.1, 'D04')).toBe(0);
    expect(readValue(0.5, 'D04')).toBe(0.5);
    expect(readValue(-0.5, 'D01')).toBe(-0.5);
  });

  it('越界被截断并计数，不抛异常', () => {
    // 双极样本：1.5 越界、-0.3 不越界、2 越界、-2 越界
    let bipolarTruncated = 0;
    for (const v of [1.5, -0.3, 2, -2]) {
      if (isTruncated(v, 'D01')) bipolarTruncated++;
    }
    expect(bipolarTruncated).toBe(3);

    // 单极样本：0.5 不越界、-0.1 越界、1.2 越界
    let unipolarTruncated = 0;
    for (const v of [0.5, -0.1, 1.2]) {
      if (isTruncated(v, 'D04')) unipolarTruncated++;
    }
    expect(unipolarTruncated).toBe(2);

    // 边界值本身不计截断
    expect(isTruncated(1, 'D01')).toBe(false);
    expect(isTruncated(-1, 'D01')).toBe(false);
    expect(isTruncated(0, 'D04')).toBe(false);
    expect(isTruncated(1, 'D04')).toBe(false);
  });
});

describe('S-008 · 主体块 D27 存储精度恒 0', () => {
  it('下标由布局推导，结果为 [35, 66]', () => {
    expect(D27_STORAGE_INDICES).toEqual([35, 66]);
    expect(LAYOUT[35]).toEqual({ block: 'self', dim: 'D27' });
    expect(LAYOUT[66]).toEqual({ block: 'user_est', dim: 'D27' });
  });

  it('写入后下标 35 与 66 的 prec 恒为 0', () => {
    const prec = new Array<number>(79).fill(400);
    const stamped = stampStoragePrecision(prec);
    expect(stamped[35]).toBe(0);
    expect(stamped[66]).toBe(0);
  });

  it('其余维度的 prec 不受影响', () => {
    const prec = new Array<number>(79).fill(400);
    const stamped = stampStoragePrecision(prec);
    stamped.forEach((value, i) => {
      if (i === 35 || i === 66) return;
      expect(value, `下标 ${i}`).toBe(400);
    });
  });

  it('纯函数：不修改入参', () => {
    const prec = new Array<number>(79).fill(400);
    stampStoragePrecision(prec);
    expect(prec[35]).toBe(400);
    expect(prec[66]).toBe(400);
  });

  it('重复施加幂等', () => {
    const once = stampStoragePrecision(new Array<number>(79).fill(400));
    const twice = stampStoragePrecision(once);
    expect(twice).toEqual(once);
  });

  it('非有限入参归 0，有限入参截到 [0,400]（S-007 覆盖到本函数）', () => {
    const prec = new Array<number>(79).fill(NaN);
    prec[0] = 500; // 超上限
    prec[1] = Infinity;
    prec[2] = -Infinity;
    prec[3] = -5; // 负 π
    const stamped = stampStoragePrecision(prec);

    // 除 D27 两格外，全数组不得残留任何非有限值
    const nonFinite = stamped.filter((p, i) => i !== 35 && i !== 66 && !Number.isFinite(p));
    expect(nonFinite).toEqual([]);

    expect(stamped[0]).toBe(400); // 原 500 → 截到上限
    expect(stamped[1]).toBe(400); // 原 +∞ → 饱和 400（E-25：σ→0 无限精确，非未知）
    expect(stamped[2]).toBe(0); // 原 -∞ → 未知
    expect(stamped[3]).toBe(0);
    expect(stamped[4]).toBe(0); // 原 NaN
    expect(stamped[35]).toBe(0);
    expect(stamped[66]).toBe(0);
  });

  it('维度编号类型收紧为 DimId（编译期挡拼写错误）', () => {
    // 运行时仍可验证：合法编号都能查，清单与 LAYOUT 一致
    for (const entry of LAYOUT) {
      expect(typeof isBipolar(entry.dim)).toBe('boolean');
    }
    // 非法编号在类型层即被拒绝，此处只验证运行时行为可预期
    expect(isBipolar('D01')).toBe(true);
    expect(isBipolar('D33')).toBe(false);
  });
});
