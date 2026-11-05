/**
 * 切片#3 补充 · 层 → 维度归属（E-05 / S-018）
 *
 * 钉死三件事：
 * 1. `DIMS_BY_LAYER` 逐层与 Opus v3 维度表一致（v3.1 口径，非 v2.1 全表）；
 * 2. `LAYER_DIMS` 由 LAYOUT 推导出的下标表恰好铺满 79 维、零重叠；
 * 3. 掩码数组的下标序与 `LAYER_NAMES` 对齐（错位会把某层的权重挂到别的层上）。
 */
import { describe, it, expect } from 'vitest';
import { DIMS_BY_LAYER, DEFAULT_MASKS, LAYER_NAMES } from '../core/config.js';
import { D27_STORAGE_INDICES, LAYER_DIMS, LAYOUT } from '../core/layout.js';

/** 闭区间下标序列，便于逐项比对 */
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const dims = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    `D${String(from + i).padStart(2, '0')}`,
  );

describe('E-05 · DIMS_BY_LAYER 归属表（v3.1 口径）', () => {
  it('七层与 Opus v3 维度表逐项一致', () => {
    expect(DIMS_BY_LAYER.body).toEqual(dims(1, 6));
    expect(DIMS_BY_LAYER.core).toEqual(dims(7, 9));
    expect(DIMS_BY_LAYER.appraisal).toEqual(dims(10, 16));
    expect(DIMS_BY_LAYER.motive).toEqual(dims(17, 23));
    expect(DIMS_BY_LAYER.relation).toEqual(dims(24, 31));
    expect(DIMS_BY_LAYER.scene).toEqual(dims(32, 40));
    expect(DIMS_BY_LAYER.dyad).toEqual(['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6', 'Y7', 'Y8']);
  });

  it('键序与 LAYER_NAMES 完全一致（掩码按此下标取值）', () => {
    expect(Object.keys(DIMS_BY_LAYER)).toEqual([...LAYER_NAMES]);
  });

  it('D01–D40 每维恰好属于一层', () => {
    const all = LAYER_NAMES.flatMap((layer) => [...DIMS_BY_LAYER[layer]]);
    // v3.1 共 48 项：D01–D40（40 个维度编号，D01–D31 在 Ⅰ–Ⅴ 层、D32–D40 在场景层）
    // + Y1–Y8（8 个关系指数）
    expect(all).toHaveLength(48);
    expect(new Set(all).size).toBe(48);
    for (const dim of dims(1, 40)) {
      expect(all.filter((d) => d === dim), dim).toHaveLength(1);
    }
  });

  it('接口数组全部冻结（运行时不可就地改写）', () => {
    expect(Object.isFrozen(DIMS_BY_LAYER)).toBe(true);
    for (const layer of LAYER_NAMES) {
      expect(Object.isFrozen(DIMS_BY_LAYER[layer]), layer).toBe(true);
    }
  });
});

describe('E-05 · LAYER_DIMS 下标推导', () => {
  it('七层合计恰好 79 项，且互不重叠', () => {
    const all = LAYER_NAMES.flatMap((layer) => [...LAYER_DIMS[layer]]);
    expect(all).toHaveLength(LAYOUT.length);
    expect(all).toHaveLength(79);
    expect(new Set(all).size).toBe(79);
    expect(all.every((i) => Number.isInteger(i) && i >= 0 && i < LAYOUT.length)).toBe(true);
  });

  it('场景层 = 下标 0..8；关系场 = 71..78', () => {
    expect([...LAYER_DIMS.scene]).toEqual(range(0, 8));
    expect([...LAYER_DIMS.dyad]).toEqual(range(71, 78));
  });

  it('body：self 9..14 + user_est 40..45（D01–D06 在两侧各一份）', () => {
    expect([...LAYER_DIMS.body]).toEqual([...range(9, 14), ...range(40, 45)]);
  });

  it('core / appraisal / motive / relation 的区间与维度表对齐', () => {
    expect([...LAYER_DIMS.core]).toEqual([...range(15, 17), ...range(46, 48)]);
    expect([...LAYER_DIMS.appraisal]).toEqual([...range(18, 24), ...range(49, 55)]);
    expect([...LAYER_DIMS.motive]).toEqual([...range(25, 31), ...range(56, 62)]);
    expect([...LAYER_DIMS.relation]).toEqual([...range(32, 39), ...range(63, 70)]);
  });

  it('每层下标数与维度数量成比例（D01–D31 层 × 2 块）', () => {
    expect(LAYER_DIMS.body).toHaveLength(12);
    expect(LAYER_DIMS.core).toHaveLength(6);
    expect(LAYER_DIMS.appraisal).toHaveLength(14);
    expect(LAYER_DIMS.motive).toHaveLength(14);
    expect(LAYER_DIMS.relation).toHaveLength(16);
    expect(LAYER_DIMS.scene).toHaveLength(9);
    expect(LAYER_DIMS.dyad).toHaveLength(8);
  });

  it('LAYER_DIMS 的键序与 LAYER_NAMES 一致，内层数组已冻结', () => {
    expect(Object.keys(LAYER_DIMS)).toEqual([...LAYER_NAMES]);
    expect(Object.isFrozen(LAYER_DIMS)).toBe(true);
    for (const layer of LAYER_NAMES) {
      expect(Object.isFrozen(LAYER_DIMS[layer]), layer).toBe(true);
    }
  });

  it('E-10 提醒：主体块 D27 的两处下标都落在 relation 层内', () => {
    // 这不是「D27 属于多个层」，而是 D27 同频在 relation 层、且 E-10 规定
    // 主体块存储精度恒为 0 —— 接入层准入时须先从 piXs 中剔除这两项，
    // 否则两项恒定 0 覆盖率会把关系层覆盖率整体压低。
    expect(D27_STORAGE_INDICES).toEqual([35, 66]);
    for (const index of D27_STORAGE_INDICES) {
      expect(LAYER_DIMS.relation).toContain(index);
    }
  });
});

describe('S-018 · 掩码与层序对齐', () => {
  it('三套掩码长度均等于层数，> 0 即视为激活', () => {
    const layerCount = LAYER_NAMES.length;
    expect(layerCount).toBe(7);
    for (const [name, mask] of Object.entries(DEFAULT_MASKS)) {
      expect(mask, name).toHaveLength(layerCount);
      expect(mask.every((m) => Number.isFinite(m) && m >= 0), name).toBe(true);
    }
  });

  it('通路 C 全层激活；通路 B 与共同经历只激活部分层', () => {
    expect(DEFAULT_MASKS.pathwayC.every((m) => m > 0)).toBe(true);
    expect(DEFAULT_MASKS.pathwayB.filter((m) => m > 0)).toHaveLength(4);
    expect(DEFAULT_MASKS.sharedEpiphany.filter((m) => m > 0)).toHaveLength(4);
  });

  it('scene 层在通路 B 下未激活、在共同经历下激活（掩码未错位）', () => {
    const sceneIndex = LAYER_NAMES.indexOf('scene');
    expect(DEFAULT_MASKS.pathwayB[sceneIndex]).toBe(0);
    expect(DEFAULT_MASKS.sharedEpiphany[sceneIndex]).toBeGreaterThan(0);
  });
});
