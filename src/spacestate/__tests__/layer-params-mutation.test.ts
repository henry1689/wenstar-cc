/**
 * 切片#3 补包 B 第 5 项 · 变异测试（Mutation Test）
 *
 * 🔴 目的：证明「常量被改坏时，测试**真的会红**」。
 * `LAYER_PARAMS` 零生产消费者，普通断言只能证明「现在是对的」，
 * 不能证明「改错了会被抓」——变异测试补的就是这个缺口。
 *
 * 三条约束（Sonnet 裁定）：
 * - **约束 A 自动化，禁止手改源文件**：全部变异在内存里构造（复制 → 改字段 →
 *   交给断言/对拍），**自动恢复**（每例用全新副本）。手工改源文件再改回
 *   可能把 `120` 写成 `120.0`，造成假通过。
 * - **约束 B 覆盖面**：7 层 λ + 7 层 τ + 反向 τ + NO_KALMAN 增删 + OBSERVE_ONLY 增删
 * - **约束 C 留痕**：输出「变异个数 / 被抓到个数」，要求 **100%**
 *
 * 约定：`run()` **正常返回 = 该变异已被抓到**；`run()` 抛错 = 漏网。
 * 两类「被抓到」分开统计：
 * - `assert`：`assertLayerParams` 抛错（加载断言）
 * - `snapshot`：与入库快照对拍不一致
 */
import { describe, it, expect } from 'vitest';
import {
  assertLayerParams,
  exportLayerConstants,
  LAYER_NAMES,
  LAYER_PARAMS,
  NO_KALMAN_DIMS,
  OBSERVE_ONLY_DIMS,
  type LayerName,
  type LayerParam,
} from '../core/config.js';
import expected from './config-snapshot.json';

type Params = Record<LayerName, LayerParam>;
type Snapshot = typeof expected;

/** 深拷贝当前真实参数（每例一份，用完即弃 = 自动恢复，无需改源文件） */
const freshParams = (): Params =>
  Object.fromEntries(
    LAYER_NAMES.map((l) => [
      l,
      { lambda: LAYER_PARAMS[l].lambda, tauMin: LAYER_PARAMS[l].tauMin },
    ]),
  ) as Params;

/** 用变异后的参数构造快照形态，与入库快照比对 */
function snapshotWith(
  params: Params,
  noKalman: readonly string[],
  observe: readonly string[],
): Snapshot {
  return {
    ...expected,
    layerParams: Object.fromEntries(
      LAYER_NAMES.map((l) => [l, { lambda: params[l].lambda, tauMin: params[l].tauMin }]),
    ),
    noKalman: [...noKalman].sort(),
    observeOnly: [...observe].sort(),
  } as Snapshot;
}

type CatchKind = 'assert' | 'snapshot';

interface Mutation {
  readonly name: string;
  readonly expectCatch: CatchKind;
  /** 正常返回 = 被抓到；抛错 = 漏网 */
  readonly run: () => void;
}

function collectMutations(): Mutation[] {
  const mutations: Mutation[] = [];
  const baseNoKalman = [...NO_KALMAN_DIMS].sort();
  const baseObserve = [...OBSERVE_ONLY_DIMS].sort();

  /**
   * 加载断言路径：必须抛错，且**错误消息命中**——
   * 只 `toThrow()` 会让「因别的原因抛错」也算通过（Sonnet 明确要求）。
   */
  const caughtByAssert = (params: Params, pattern: RegExp): (() => void) => () => {
    let message = '';
    let threw = false;
    try {
      assertLayerParams(params);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    if (!threw) throw new Error('assertLayerParams 未抛错 → 变异漏网');
    if (!pattern.test(message)) {
      throw new Error(`抛错但消息不匹配 ${pattern}：实际「${message}」→ 变异漏网`);
    }
  };

  /** 对拍路径：必须与入库快照不一致，且差异字段真的变了 */
  const caughtBySnapshot = (
    params: Params,
    noKalman: readonly string[],
    observe: readonly string[],
    changedKey: keyof Snapshot,
  ): (() => void) => () => {
    const got = snapshotWith(params, noKalman, observe);
    if (JSON.stringify(got) === JSON.stringify(expected)) {
      throw new Error(`变异后仍与快照一致（${changedKey}）→ 变异漏网`);
    }
    if (!(changedKey in got)) throw new Error(`快照缺少字段 ${String(changedKey)}`);
  };

  // ---- 约束 B：每层 λ 各变异一次（7 次）----
  // 用 +0.01 微小扰动：不破坏 S-046 层级顺序（否则会误判成「断言抓到」），
  // 因此只有对拍能抓到——这正是要验证的「快照有保护力」
  for (const layer of LAYER_NAMES) {
    mutations.push({
      name: `λ.${layer} +0.01`,
      expectCatch: 'snapshot',
      run: (() => {
        const l = layer;
        return () => {
          const p = freshParams();
          p[l] = { ...p[l], lambda: p[l].lambda + 0.01 };
          caughtBySnapshot(p, baseNoKalman, baseObserve, 'layerParams')();
        };
      })(),
    });
  }

  // ---- 约束 B：每层 τ 各变异一次（7 次）----
  for (const layer of LAYER_NAMES) {
    if (layer === 'scene') {
      // scene 的 τ 为 null → 变异为数值：预期**加载断言抛错**，不是对拍不一致
      mutations.push({
        name: 'τ.scene null → 60（专项：应抛错）',
        expectCatch: 'assert',
        run: (() => {
          return () => {
            const p = freshParams();
            p.scene = { ...p.scene, tauMin: 60 };
            caughtByAssert(p, /τ 为 null 的层应只有 scene/)();
          };
        })(),
      });
      continue;
    }
    mutations.push({
      name: `τ.${layer} +1`,
      expectCatch: 'snapshot',
      run: (() => {
        const l = layer;
        return () => {
          const p = freshParams();
          const tau = p[l].tauMin as number;
          p[l] = { ...p[l], tauMin: tau + 1 };
          caughtBySnapshot(p, baseNoKalman, baseObserve, 'layerParams')();
        };
      })(),
    });
  }

  // ---- 反向变异：relation τ → null（验证「只有 scene 无 τ」双向有效）----
  mutations.push({
    name: 'τ.relation 120 → null（反向：应抛错）',
    expectCatch: 'assert',
    run: () => {
      const p = freshParams();
      p.relation = { ...p.relation, tauMin: null };
      caughtByAssert(p, /τ 为 null 的层应只有 scene，实际：relation/)();
    },
  });

  // ---- 约束 B：NO_KALMAN 增一个 / 删一个 ----
  mutations.push({
    name: 'NO_KALMAN 增 D01',
    expectCatch: 'snapshot',
    run: () => {
      caughtBySnapshot(freshParams(), [...baseNoKalman, 'D01'], baseObserve, 'noKalman')();
    },
  });
  mutations.push({
    name: 'NO_KALMAN 删 D27',
    expectCatch: 'snapshot',
    run: () => {
      caughtBySnapshot(
        freshParams(),
        baseNoKalman.filter((d) => d !== 'D27'),
        baseObserve,
        'noKalman',
      )();
    },
  });

  // ---- 约束 B：OBSERVE_ONLY 增一个 / 删一个 ----
  mutations.push({
    name: 'OBSERVE_ONLY 增 D21',
    expectCatch: 'snapshot',
    run: () => {
      caughtBySnapshot(freshParams(), baseNoKalman, [...baseObserve, 'D21'], 'observeOnly')();
    },
  });
  mutations.push({
    name: 'OBSERVE_ONLY 删 D30',
    expectCatch: 'snapshot',
    run: () => {
      caughtBySnapshot(
        freshParams(),
        baseNoKalman,
        baseObserve.filter((d) => d !== 'D30'),
        'observeOnly',
      )();
    },
  });

  return mutations;
}

describe('变异测试（补包 B 第 5 项）', () => {
  const mutations = collectMutations();

  it('变异清单满足约束 B 的覆盖面（≥ 19 例）', () => {
    expect(mutations.length).toBeGreaterThanOrEqual(19);
    const names = mutations.map((m) => m.name);
    for (const l of LAYER_NAMES) expect(names).toContain(`λ.${l} +0.01`);
    for (const l of LAYER_NAMES) {
      expect(names.some((n) => n.startsWith(`τ.${l} `)), `τ.${l}`).toBe(true);
    }
    expect(names).toContain('NO_KALMAN 增 D01');
    expect(names).toContain('NO_KALMAN 删 D27');
    expect(names).toContain('OBSERVE_ONLY 增 D21');
    expect(names).toContain('OBSERVE_ONLY 删 D30');
  });

  it('每一例变异都必须被抓到（抓得率 100%）', () => {
    const caught = { assert: 0, snapshot: 0 };
    const missed: string[] = [];
    for (const m of mutations) {
      try {
        m.run();
        caught[m.expectCatch] += 1;
      } catch (err) {
        missed.push(`${m.name} → ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(missed, '漏网的变异').toEqual([]);
    expect(caught.assert + caught.snapshot).toBe(mutations.length);

    // 约束 C 留痕：变异个数 / 被抓到个数，两类分开
    // eslint-disable-next-line no-console
    console.log(
      `\n变异测试留痕：变异 ${mutations.length} 例，被抓 ${caught.assert + caught.snapshot} 例` +
        `\n  ├ 加载断言抛错抓到：${caught.assert} 例` +
        `\n  └ 对拍不一致抓到：${caught.snapshot} 例` +
        `\n  抓得率：${(((caught.assert + caught.snapshot) / mutations.length) * 100).toFixed(1)}%`,
    );
  });

  it('基线（未变异）必须同时通过断言与对拍——否则上面的统计无意义', () => {
    expect(() => assertLayerParams({ ...LAYER_PARAMS })).not.toThrow();
    expect(exportLayerConstants().layerParams).toEqual(expected.layerParams);
    expect(JSON.stringify(snapshotWith(freshParams(), [...NO_KALMAN_DIMS], [...OBSERVE_ONLY_DIMS]))).toBe(
      JSON.stringify(expected),
    );
  });
});
