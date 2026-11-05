/**
 * 切片#3 补包 B 第 4 项 · 常量精确快照
 *
 * 🔴 为什么需要它：`LAYER_PARAMS` / `DIMS_BY_LAYER` 此前**零生产消费者**，
 * 10⁵ 差分也跑不到层参数——常量一旦被误改，没有任何测试会红。
 * 本文件把「当前实际值」与入库快照逐项比对，改动即红。
 *
 * 覆盖范围（Sonnet 明确要求，缺一不可）：
 * - `DIMS_BY_LAYER` 的**维度名列表**（不只是层名和长度）
 * - `LAYER_PARAMS` 的**具体数值**（lambda 与 tauMin 逐个）
 * - `NO_KALMAN_DIMS` / `OBSERVE_ONLY_DIMS` / `PRIVATE_ONLY_DIMS`
 *
 * 快照文件：`config-snapshot.json`（随本测试入库）。
 * 想合法地改常量 → 同一提交里同步改快照，并在提交说明写明依据（E-28 / E-29 等）。
 */
import { describe, it, expect } from 'vitest';
import { exportLayerConstants } from '../core/config.js';
import expected from './config-snapshot.json';

describe('常量精确快照（config-snapshot.json）', () => {
  it('DIMS_BY_LAYER 维度名列表逐项一致', () => {
    expect(exportLayerConstants().dimsByLayer).toEqual(expected.dimsByLayer);
  });

  it('LAYER_PARAMS 的 lambda / tauMin 逐项一致', () => {
    expect(exportLayerConstants().layerParams).toEqual(expected.layerParams);
  });

  it('三个维度级开关集合一致（含排序）', () => {
    const c = exportLayerConstants();
    expect(c.noKalman).toEqual(expected.noKalman);
    expect(c.observeOnly).toEqual(expected.observeOnly);
    expect(c.privateOnly).toEqual(expected.privateOnly);
  });

  it('整包比对（防上面三条各自通过但整体错位）', () => {
    expect(exportLayerConstants()).toEqual(expected);
  });

  // ============ 补包 B2 第 5 项 · 实证闭环 ============
  //
  // 🔴 为什么补这两条：此前报告称「变异后快照必红」是**推理**——变异发生在内存副本上，
  // 真实常量没变，`toEqual(实际, 入库快照)` 这条断言读的是真实常量，**不会红**。
  // 下面把比对抽成同一个函数 `assertMatchesSnapshot`，用它跑两条：
  //   未变异 → 绿；变异 → 必须抛错。这才构成「该比对确实有判别力」的实证。
  // 全程**不修改任何源文件**（Sonnet 三条变异约束禁止手改源文件再改回）。

  /** 快照比对的唯一实现：两条测试共用，保证比的是同一把尺子 */
  function assertMatchesSnapshot(
    actual: ReturnType<typeof exportLayerConstants>,
  ): void {
    expect(actual).toEqual(expected);
  }

  it('实证 A：未变异时与入库快照一致（基线为绿）', () => {
    expect(() => assertMatchesSnapshot(exportLayerConstants())).not.toThrow();
    assertMatchesSnapshot(exportLayerConstants());
  });

  it('实证 B：改维度名后比对必红（同一把尺子确实会判失败）', () => {
    const base = exportLayerConstants();
    const mutated: ReturnType<typeof exportLayerConstants> = {
      ...base,
      dimsByLayer: { ...base.dimsByLayer, body: ['D01', 'D02', 'D03', 'D04', 'D05', 'D99'] },
    };
    expect(mutated.dimsByLayer.body).not.toEqual(expected.dimsByLayer.body);
    expect(() => assertMatchesSnapshot(mutated)).toThrow();
  });

  it('实证 C：改 relation τ 后比对必红（数值层同样有判别力）', () => {
    const base = exportLayerConstants();
    const mutated: ReturnType<typeof exportLayerConstants> = {
      ...base,
      layerParams: { ...base.layerParams, relation: { lambda: 0.15, tauMin: 100 } },
    };
    expect(mutated.layerParams.relation).not.toEqual(expected.layerParams.relation);
    expect(() => assertMatchesSnapshot(mutated)).toThrow();
  });

  it('实证 D：改开关集合后比对必红', () => {
    const base = exportLayerConstants();
    const mutated: ReturnType<typeof exportLayerConstants> = {
      ...base,
      observeOnly: ['D29'],
    };
    expect(() => assertMatchesSnapshot(mutated)).toThrow();
    const dropped: ReturnType<typeof exportLayerConstants> = {
      ...base,
      noKalman: base.noKalman.filter((d) => d !== 'D27'),
    };
    expect(() => assertMatchesSnapshot(dropped)).toThrow();
  });

  it('快照结构自洽：七层齐全、层参数键序与层名一致', () => {
    expect(Object.keys(expected.dimsByLayer)).toEqual([
      'body',
      'core',
      'appraisal',
      'motive',
      'relation',
      'scene',
      'dyad',
    ]);
    expect(Object.keys(expected.layerParams)).toEqual(Object.keys(expected.dimsByLayer));
    const dimCount = Object.values(expected.dimsByLayer).reduce(
      (acc, list) => acc + list.length,
      0,
    );
    expect(dimCount).toBe(48);
    expect(expected.noKalman).toHaveLength(10); // D27 + D32..D40
  });
});
