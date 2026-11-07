/**
 * 切片#3 补包 · 层参数（λ / τ）与维度级开关
 *
 * 覆盖验收清单 1、2：
 * - `LAYER_PARAMS` 三条加载断言（键序 / S-046 λ 层级顺序 / 只有 scene 无 τ）
 * - `layerOf` / `layerLambda` / `layerTau` / `resonanceMask` 逐维正确
 *
 * 说明「断言可被单测触发」：三条断言写在 config.ts 的**模块加载期**，
 * 一旦某个 λ/τ 配错，本文件在 `import` 阶段就会整体失败（而非静默跑绿）。
 * 下面的用例另按同样口径复算一遍，确保即使有人放宽了加载断言也会被单测拦住。
 */
import { describe, it, expect } from 'vitest';
import {
  DIMS_BY_LAYER,
  LAYER_NAMES,
  LAYER_PARAMS,
  NO_KALMAN_DIMS,
  OBSERVE_ONLY_DIMS,
  PRIVATE_ONLY_DIMS,
  layerLambda,
  layerOf,
  layerTau,
  resonanceMask,
} from '../core/config.js';

describe('LAYER_PARAMS · 取值与加载断言', () => {
  it('① 键序与 LAYER_NAMES 一致', () => {
    expect(Object.keys(LAYER_PARAMS)).toEqual([...LAYER_NAMES]);
  });

  it('各层 λ / τ 与任务书取值逐项一致', () => {
    expect(LAYER_PARAMS.body).toEqual({ lambda: 0.8, tauMin: 60 });
    expect(LAYER_PARAMS.core).toEqual({ lambda: 0.15, tauMin: 20 });
    expect(LAYER_PARAMS.appraisal).toEqual({ lambda: 0.4, tauMin: 10 });
    expect(LAYER_PARAMS.motive).toEqual({ lambda: 0.4, tauMin: 30 });
    // ⚠️ 临时值（E-28 未决）：白皮书未给 relation 的 τ，暂取与 dyad 同值
    expect(LAYER_PARAMS.relation).toEqual({ lambda: 0.15, tauMin: 120 });
    expect(LAYER_PARAMS.scene).toEqual({ lambda: 1.0, tauMin: null });
    expect(LAYER_PARAMS.dyad).toEqual({ lambda: 0.15, tauMin: 120 });
  });

  it('② S-046 λ 层级顺序：scene ≥ body ≥ appraisal = motive ≥ core = relation = dyad', () => {
    const lam = (l: (typeof LAYER_NAMES)[number]) => LAYER_PARAMS[l].lambda;
    const tiers: [string, string][] = [
      ['scene', 'body'],
      ['body', 'appraisal'],
      ['appraisal', 'motive'],
      ['appraisal', 'core'],
      ['appraisal', 'relation'],
      ['appraisal', 'dyad'],
      ['motive', 'core'],
      ['motive', 'relation'],
      ['motive', 'dyad'],
      ['core', 'relation'],
      ['core', 'dyad'],
      ['relation', 'dyad'],
    ];
    for (const [higher, lower] of tiers) {
      const h = lam(higher as never);
      const l = lam(lower as never);
      expect(h, `${higher} ≥ ${lower}`).toBeGreaterThanOrEqual(l);
    }
    // 同层位必须相等
    expect(lam('appraisal')).toBe(lam('motive'));
    expect(lam('core')).toBe(lam('relation'));
    expect(lam('core')).toBe(lam('dyad'));
  });

  it('③ 只有 scene 的 τ 为 null，其余六层为正有限数', () => {
    const withoutTau = LAYER_NAMES.filter((l) => LAYER_PARAMS[l].tauMin === null);
    expect(withoutTau).toEqual(['scene']);
    for (const l of LAYER_NAMES) {
      const { lambda, tauMin } = LAYER_PARAMS[l];
      expect(Number.isFinite(lambda), `${l}.lambda`).toBe(true);
      expect(lambda).toBeGreaterThanOrEqual(0);
      if (tauMin !== null) {
        expect(Number.isFinite(tauMin), `${l}.tauMin`).toBe(true);
        expect(tauMin).toBeGreaterThan(0);
      }
    }
  });

  it('内层参数对象已冻结（λ/τ 不可就地改写）', () => {
    expect(Object.isFrozen(LAYER_PARAMS)).toBe(true);
    for (const l of LAYER_NAMES) {
      expect(Object.isFrozen(LAYER_PARAMS[l]), l).toBe(true);
    }
  });
});

describe('layerOf / layerLambda · 48 维逐项', () => {
  it('每个维度都能查到且只属于一层，λ 与该层一致', () => {
    for (const layer of LAYER_NAMES) {
      for (const dim of DIMS_BY_LAYER[layer]) {
        expect(layerOf(dim), dim).toBe(layer);
        expect(layerLambda(dim), dim).toBe(LAYER_PARAMS[layer].lambda);
      }
    }
  });

  it('各层维度数：6 / 3 / 7 / 7 / 8 / 9 + dyad 8 = 48', () => {
    const counts = Object.fromEntries(
      LAYER_NAMES.map((l) => [l, DIMS_BY_LAYER[l].length]),
    );
    expect(counts).toEqual({
      body: 6,
      core: 3,
      appraisal: 7,
      motive: 7,
      relation: 8,
      scene: 9,
      dyad: 8,
    });
  });
});

describe('layerTau · Kalman 开关', () => {
  it('D27 与 D32–D40 返回 null（共 10 个维度编号）', () => {
    const nullDims = Object.keys(
      Object.fromEntries(
        LAYER_NAMES.flatMap((l) => DIMS_BY_LAYER[l])
          .map((d) => [d, layerTau(d)])
          .filter(([, tau]) => tau === null),
      ),
    );
    expect(nullDims).toHaveLength(10);
    expect(nullDims).toContain('D27');
    for (const n of [32, 33, 34, 35, 36, 37, 38, 39, 40]) {
      expect(nullDims, `D${n}`).toContain(`D${n}`);
    }
    expect([...NO_KALMAN_DIMS].sort()).toEqual([...nullDims].sort());
  });

  it('其余维度返回所属层的 τ', () => {
    expect(layerTau('D01')).toBe(60); // body
    expect(layerTau('D07')).toBe(20); // core
    expect(layerTau('D10')).toBe(10); // appraisal
    expect(layerTau('D17')).toBe(30); // motive
    expect(layerTau('D24')).toBe(120); // relation（临时值）
    expect(layerTau('D26')).toBe(120); // relation，非 D27 → 有 τ
    expect(layerTau('Y1')).toBe(120); // dyad
  });

  it('scene 层整层不走 Kalman（与「层没有 τ」区分）', () => {
    for (const dim of DIMS_BY_LAYER.scene) {
      expect(layerTau(dim), dim).toBeNull();
    }
    // relation 层**有** τ，只是 D27 这一个维度例外 —— 两者不得混为一谈
    expect(LAYER_PARAMS.relation.tauMin).not.toBeNull();
    expect(layerTau('D27')).toBeNull();
    expect(layerTau('D25')).toBe(120);
  });
});

describe('resonanceMask · E-14 细化', () => {
  it('只观测维度恒 0，私密模式也不放行', () => {
    expect([...OBSERVE_ONLY_DIMS]).toEqual(['D29', 'D30']);
    expect(resonanceMask('D29', false)).toBe(0);
    expect(resonanceMask('D29', true)).toBe(0);
    expect(resonanceMask('D30', false)).toBe(0);
    expect(resonanceMask('D30', true)).toBe(0);
  });

  it('D20 由私密模式开关控制', () => {
    expect([...PRIVATE_ONLY_DIMS]).toEqual(['D20']);
    expect(resonanceMask('D20', false)).toBe(0);
    expect(resonanceMask('D20', true)).toBe(1);
  });

  it('其余 46 个维度恒为 1', () => {
    const gated = new Set([...OBSERVE_ONLY_DIMS, ...PRIVATE_ONLY_DIMS]);
    for (const layer of LAYER_NAMES) {
      for (const dim of DIMS_BY_LAYER[layer]) {
        if (gated.has(dim)) continue;
        expect(resonanceMask(dim, false), dim).toBe(1);
        expect(resonanceMask(dim, true), dim).toBe(1);
      }
    }
  });
});

// ============ B-3 任务 2 · 只读集合视图（真冻结） ============

describe('只读集合视图 · 四条负向测试（B-3 任务 2）', () => {
  it("① 视图没有 delete 方法（'delete' in view === false）", () => {
    expect('delete' in OBSERVE_ONLY_DIMS).toBe(false);
    expect('add' in OBSERVE_ONLY_DIMS).toBe(false);
    expect('clear' in OBSERVE_ONLY_DIMS).toBe(false);
    expect('NO_KALMAN' in NO_KALMAN_DIMS ? true : 'add' in NO_KALMAN_DIMS).toBe(false);
  });

  it('② 直接调用 delete → TypeError（视图上没有该方法）', () => {
    expect(() => (OBSERVE_ONLY_DIMS as unknown as { delete: (v: string) => void }).delete('D29'))
      .toThrow(TypeError);
  });

  it('③ ★ 绕过路径：Set.prototype.delete.call(view) → TypeError', () => {
    // 决定性用例：若内部仍是 Set 实例，这一步会成功并真的删掉 D29。
    // 抛 TypeError 说明 brand check 失败 = 不是 Set 实例 = 原型链绕过被堵死。
    expect(() => Set.prototype.delete.call(OBSERVE_ONLY_DIMS, 'D29')).toThrow(TypeError);
    expect(() => Set.prototype.add.call(NO_KALMAN_DIMS, 'D01')).toThrow(TypeError);
    expect(() => Set.prototype.clear.call(PRIVATE_ONLY_DIMS)).toThrow(TypeError);
  });

  it('④ 内容未被改动（前三条之后仍可正常读取）', () => {
    expect(OBSERVE_ONLY_DIMS.has('D29')).toBe(true);
    expect(OBSERVE_ONLY_DIMS.has('D30')).toBe(true);
    expect(OBSERVE_ONLY_DIMS.size).toBe(2);
    expect(NO_KALMAN_DIMS.has('D27')).toBe(true);
    expect(PRIVATE_ONLY_DIMS.has('D20')).toBe(true);
  });

  // ============ B-3 退回单 §2.1 · forEach 是第三条绕过路径 ============
  // 前四条只堵了「直接调 delete」与「Set.prototype 走原型」两条。
  // 第三条：Set.prototype.forEach 的**第三个回调实参就是真身**——
  // 若原样透传 inner，调用方在回调里就能拿到内部 Set：
  //   OBSERVE_ONLY_DIMS.forEach((v, k, s) => (s as Set<DimId>).delete('D29'));
  // 统筹者复核实测该路径可删掉 D29，故单列用例。

  it('⑤ forEach 回调的第三个实参必须是视图本身，不是内部 Set', () => {
    let third: unknown;
    OBSERVE_ONLY_DIMS.forEach((_v, _k, s) => {
      third = s;
    });
    // 判据一：传的是 view（真身的第三个实参会是另一个对象）
    expect(third).toBe(OBSERVE_ONLY_DIMS);
    // 判据二：视图上没有 delete；真身 Set 上有 —— 这条区分了「传的是谁」
    expect(typeof third).toBe('object');
    expect('delete' in (third as object)).toBe(false);
    // 判据三：即便退一步按真身用法调原型方法，也照样删不动
    expect(() => Set.prototype.delete.call(third, 'D29')).toThrow(TypeError);
    // 判据四：内容确实没被改动
    expect(OBSERVE_ONLY_DIMS.has('D29')).toBe(true);
    expect(OBSERVE_ONLY_DIMS.size).toBe(2);
  });

  it('⑥ 三个集合的 forEach 第三参都是各自视图（逐个核，不止 OBSERVE_ONLY）', () => {
    for (const view of [OBSERVE_ONLY_DIMS, NO_KALMAN_DIMS, PRIVATE_ONLY_DIMS]) {
      let third: unknown;
      view.forEach((_v, _k, s) => {
        third = s;
      });
      expect(third, '第三参应为视图自身').toBe(view);
      expect('delete' in (third as object), '视图不得带 delete').toBe(false);
    }
    // 回调的前两参：Set 语义下 key 恒等于 value，不得传成别的
    const pairs: [unknown, unknown][] = [];
    OBSERVE_ONLY_DIMS.forEach((v, k) => pairs.push([v, k]));
    expect(pairs).toEqual([
      ['D29', 'D29'],
      ['D30', 'D30'],
    ]);
  });

  it('视图仍是合法的 ReadonlySet：可迭代、可 forEach、size 正确', () => {
    expect([...OBSERVE_ONLY_DIMS].sort()).toEqual(['D29', 'D30']);
    const seen: string[] = [];
    NO_KALMAN_DIMS.forEach((v) => seen.push(v));
    expect(seen).toHaveLength(NO_KALMAN_DIMS.size);
    expect(NO_KALMAN_DIMS.size).toBe(10);
    expect(typeof OBSERVE_ONLY_DIMS[Symbol.iterator]).toBe('function');
  });

  it('视图被 Object.freeze（属性层也不可改）', () => {
    for (const s of [OBSERVE_ONLY_DIMS, NO_KALMAN_DIMS, PRIVATE_ONLY_DIMS]) {
      expect(Object.isFrozen(s)).toBe(true);
    }
  });
});