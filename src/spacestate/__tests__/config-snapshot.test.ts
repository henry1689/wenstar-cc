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
