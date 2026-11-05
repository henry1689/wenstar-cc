/**
 * 切片#3 · 层 → 维度归属（E-05 / S-018 / E-10）
 *
 * 钉死三件事：
 * 1. `DIMS_BY_LAYER` 逐层与 Opus v3 维度表一致（v3.1 口径，非 v2.1 全表）；
 * 2. 下标表恰好铺满 79 维、零重叠；
 * 3. 掩码数组的下标序与 `LAYER_NAMES` 对齐（错位会把某层的权重挂到别的层上）。
 *
 * 补包 B 第 2 项：`LAYER_DIMS` / `LAYER_ADMISSION_DIMS` 已改为模块私有，
 * 只能经 `layerIndices(layer, purpose)` 取——本文件的全部访问都走该入口。
 */
import { describe, it, expect } from 'vitest';
import { DIMS_BY_LAYER, DEFAULT_MASKS, LAYER_NAMES, type LayerName } from '../core/config.js';
import { D27_STORAGE_INDICES, LAYOUT, layerIndices } from '../core/layout.js';

/** 闭区间下标序列，便于逐项比对 */
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const dims = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    `D${String(from + i).padStart(2, '0')}`,
  );

/** 层内求和用的下标（唯一入口） */
const sum = (layer: LayerName): readonly number[] => layerIndices(layer, 'sum');
/** 覆盖率 / 准入用的下标（剔除 D27，唯一入口） */
const adm = (layer: LayerName): readonly number[] => layerIndices(layer, 'admission');

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

describe('E-05 · 下标推导（layerIndices 取 sum）', () => {
  it('七层合计恰好 79 项，且互不重叠', () => {
    const all = LAYER_NAMES.flatMap((layer) => [...sum(layer)]);
    expect(all).toHaveLength(LAYOUT.length);
    expect(all).toHaveLength(79);
    expect(new Set(all).size).toBe(79);
    expect(all.every((i) => Number.isInteger(i) && i >= 0 && i < LAYOUT.length)).toBe(true);
  });

  it('场景层 = 下标 0..8；关系场 = 71..78', () => {
    expect([...sum('scene')]).toEqual(range(0, 8));
    expect([...sum('dyad')]).toEqual(range(71, 78));
  });

  it('body：self 9..14 + user_est 40..45（D01–D06 在两侧各一份）', () => {
    expect([...sum('body')]).toEqual([...range(9, 14), ...range(40, 45)]);
  });

  it('core / appraisal / motive / relation 的区间与维度表对齐', () => {
    expect([...sum('core')]).toEqual([...range(15, 17), ...range(46, 48)]);
    expect([...sum('appraisal')]).toEqual([...range(18, 24), ...range(49, 55)]);
    expect([...sum('motive')]).toEqual([...range(25, 31), ...range(56, 62)]);
    expect([...sum('relation')]).toEqual([...range(32, 39), ...range(63, 70)]);
  });

  it('每层下标数与维度数量成比例（D01–D31 层 × 2 块）', () => {
    expect(sum('body')).toHaveLength(12);
    expect(sum('core')).toHaveLength(6);
    expect(sum('appraisal')).toHaveLength(14);
    expect(sum('motive')).toHaveLength(14);
    expect(sum('relation')).toHaveLength(16);
    expect(sum('scene')).toHaveLength(9);
    expect(sum('dyad')).toHaveLength(8);
  });

  it('E-10 提醒：主体块 D27 的两处下标都落在 relation 层内', () => {
    // 这不是「D27 属于多个层」，而是 D27 同频在 relation 层、且 E-10 规定
    // 主体块存储精度恒为 0 —— 接入层准入时须先从 piXs 中剔除这两项，
    // 否则两项恒定 0 覆盖率会把关系层覆盖率整体压低。
    expect(D27_STORAGE_INDICES).toEqual([35, 66]);
    for (const index of D27_STORAGE_INDICES) {
      expect(sum('relation')).toContain(index);
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

describe('E-10 · 准入下标（layerIndices 取 admission）', () => {
  it('只有 relation 层变短（16 → 14），其余六层与 sum 逐项相等', () => {
    for (const layer of LAYER_NAMES) {
      if (layer === 'relation') {
        expect(adm('relation')).toHaveLength(14);
        expect(sum('relation')).toHaveLength(16);
        continue;
      }
      expect([...adm(layer)], layer).toEqual([...sum(layer)]);
    }
  });

  it('relation 层恰好剔除下标 35 / 66，顺序不变', () => {
    const expected = sum('relation').filter((index) => !D27_STORAGE_INDICES.includes(index));
    expect([...adm('relation')]).toEqual(expected);
    expect(expected).not.toContain(35);
    expect(expected).not.toContain(66);
    expect(adm('relation')).toHaveLength(14);
  });

  it('覆盖率上限不再被 D27 压低：16 项 vs 14 项的差异正是 E-10 要避免的', () => {
    // 16 项里有 2 项恒 0 覆盖率 → 关系层上限 14/16 = 0.875，
    // 叠加其它未产出维度极易跌破 COVERAGE_MIN，导致关系层永难准入
    const ratio = adm('relation').length / sum('relation').length;
    expect(ratio).toBeCloseTo(14 / 16, 12);
    expect(ratio).toBeLessThan(1);
  });

  it('准入下标并集仍铺满且无重复', () => {
    const all = LAYER_NAMES.flatMap((layer) => [...adm(layer)]);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(79 - D27_STORAGE_INDICES.length);
  });
});

describe('layerIndices · 唯一入口（补包 B 第 2 项）', () => {
  it("非法 purpose 运行期抛错，不静默回落", () => {
    expect(() => layerIndices('body', 'wrong' as never)).toThrow(/非法 purpose/);
    expect(() => layerIndices('body', '' as never)).toThrow(/非法 purpose/);
  });

  it('两次调用返回同一份冻结数组（不会每次造新对象）', () => {
    expect(layerIndices('body', 'sum')).toBe(layerIndices('body', 'sum'));
    expect(Object.isFrozen(layerIndices('body', 'sum'))).toBe(true);
    expect(Object.isFrozen(layerIndices('relation', 'admission'))).toBe(true);
  });

  it('sum 与 admission 仅 relation 不同（其余六层逐项相等）', () => {
    // 比内容而非引用：admissionIndices 走 filter 会造新数组，
    // 「同一引用」不是契约，「逐项一致」才是
    for (const layer of LAYER_NAMES) {
      const s = [...layerIndices(layer, 'sum')];
      const a = [...layerIndices(layer, 'admission')];
      if (layer === 'relation') {
        expect(a).not.toEqual(s);
        expect(a).toHaveLength(s.length - D27_STORAGE_INDICES.length);
        continue;
      }
      expect(a, layer).toEqual(s);
    }
  });
});