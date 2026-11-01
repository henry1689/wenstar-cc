import { describe, it, expect } from 'vitest';
import {
  arbitrateSensation,
  arbitrateV3,
  deriveHealth,
  parseSensationPayload,
  deriveDesire,
  deriveBody,
} from '../yaoling-sensation-pipeline.js';

/**
 * P140 · 瑶灵主观体感流水线（路径一）单元测试
 * ============================================================
 * 锁定：①仲裁纯函数（v1 补位语义：只填空维、不覆盖已供值）
 *       ②体感包解析（两种形态 + 防御式拒绝）
 * 隐私红线：仅中性数值样本，零实体信息。
 */

describe('arbitrateSensation（双路仲裁 v1·补位语义）', () => {
  const zeros = () => Array(40).fill(0);

  it('① 空维被主观值填充，返回 filled 计数', () => {
    const sub = zeros(); sub[0] = 0.6; sub[3] = 0.4;
    const { merged, filled } = arbitrateSensation(zeros(), sub);
    expect(filled).toBe(2);
    expect(merged[0]).toBe(0.6);
    expect(merged[3]).toBe(0.4);
    expect(merged[9]).toBe(0);
  });

  it('② 已供值的维不被覆盖（M3/瑶光优先）', () => {
    const exist = zeros(); exist[0] = 0.8; exist[1] = 0.3;
    const sub = zeros(); sub[0] = 0.1; sub[1] = 0.9; sub[2] = 0.5;
    const { merged, filled } = arbitrateSensation(exist, sub);
    expect(merged[0]).toBe(0.8);
    expect(merged[1]).toBe(0.3);
    expect(merged[2]).toBe(0.5);
    expect(filled).toBe(1);
  });

  it('③ 主观值全 0 → 无变化（filled=0，不落库语义）', () => {
    const { filled } = arbitrateSensation(zeros(), zeros());
    expect(filled).toBe(0);
  });
});

describe('parseSensationPayload（防御式解析）', () => {
  it('④ 形态一：dims[40] 数值数组', () => {
    const dims = Array.from({ length: 40 }, (_, i) => i * 0.01);
    expect(parseSensationPayload({ dims })).toHaveLength(40);
    expect(parseSensationPayload({ dims40: dims })).toHaveLength(40);
  });

  it('⑤ 形态二：d01_d08[8] → 扩为 40 维（尾部补零）', () => {
    const r = parseSensationPayload({ d01_d08: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(r).toHaveLength(40);
    expect(r?.[7]).toBe(8);
    expect(r?.[8]).toBe(0);
  });

  it('⑤b 形态三（真机首包）：dimensions[{dim_id,value_raw}] → 提取 D 维', () => {
    const r = parseSensationPayload({
      dimensions: [
        { dim_id: 'D01', value_raw: 0.42 },
        { dim_id: 'D05', value_raw: 0.31 },
        { dim_id: 'D33', value_raw: 0.9 },       // 非肉身维：v1 只消费 D01-D08，应不影响
        { dim_id: 'XX', value_raw: 0.5 },        // 非法 id 跳过
      ],
    });
    expect(r).toHaveLength(40);
    expect(r?.[0]).toBe(0.42);   // D01
    expect(r?.[4]).toBe(0.31);   // D05
    expect(r?.[33]).toBe(0);     // v1 不消费肉身八维以外（留 v2）
  });

  it('⑥ 非法输入一律 null（宁缺毋错）', () => {
    expect(parseSensationPayload(null)).toBeNull();
    expect(parseSensationPayload({ dims: [1, 2, 3] })).toBeNull();
    expect(parseSensationPayload({ dims: Array(40).fill('x') })).toBeNull();
    expect(parseSensationPayload('not-an-object')).toBeNull();
  });
});

describe('P141 v2 · 渴望与身体提炼（身心统一表达层）', () => {
  const mk = (over: Partial<{ desire: number; attachment: number; dependency: number; possessiveness: number }> = {}) => {
    const dims = Array(40).fill(0);
    // 新 40 通道语义：维度值在 dims 里（D10=9, D15=14, D39=38, D40=39）
    if (over.dependency) dims[38] = over.dependency;
    if (over.attachment) dims[14] = over.attachment;
    if (over.possessiveness) dims[39] = over.possessiveness;
    if (over.desire) dims[9] = over.desire;
    return { dims, desire: 0, attachment: 0, dependency: 0, possessiveness: 0, pleasure: 0, arousal: 0, intimacy: 0, ts: Date.now() };
  };

  it('⑦ 渴望分级：高依恋+占有 → 中文需求语句（瑶灵通道语义对齐）', () => {
    const d = deriveDesire(mk({ dependency: 0.8, attachment: 0.7, possessiveness: 0.6 }));
    expect(d.some((s) => s.includes('没有你不行'))).toBe(true);
    expect(d.some((s) => s.includes('想'))).toBe(true);
    expect(d.length).toBeLessThanOrEqual(3);
  });

  it('⑧ 平静态：无渴望语句（不硬造需求）', () => {
    expect(deriveDesire(mk())).toEqual([]);
  });

  it('⑨ 身体语句：高肌肉张力/激素涌动 → 中文体感（低于阈值 → 放松基线）', () => {
    const dims = Array(40).fill(0); dims[0] = 0.8; dims[3] = 0.7;   // D01 muscle, D04 endocrine
    const b = deriveBody(dims);
    expect(b.some((s) => s.includes('肌肉'))).toBe(true);
    expect(b.some((s) => s.includes('激素'))).toBe(true);
    expect(deriveBody(Array(40).fill(0))).toEqual(['身体放松、呼吸平稳']);
  });
});

describe('P142 极致版 · v3 双路仲裁 + 健康哨兵（无病无痛）', () => {
  const zeros = () => Array(40).fill(0);

  it('⑩ v3 融合：主观 0.7 + 客观 0.3（双路都在时），偏离度=感受强度', () => {
    const exist = zeros(); exist[0] = 0.6;   // 客观已供
    const sub = zeros(); sub[0] = 0.9;       // 主观强烈
    const { merged, deviation } = arbitrateV3(exist, sub);
    expect(merged[0]).toBeCloseTo(0.9 * 0.7 + 0.6 * 0.3, 4);   // 0.81
    expect(deviation).toBeCloseTo(0.3, 5);
  });

  it('⑪ v3 补位兼容：客观未到 → 主观补位（v1 语义保留）', () => {
    const sub = zeros(); sub[2] = 0.5;
    const { merged, filled } = arbitrateV3(zeros(), sub);
    expect(merged[2]).toBe(0.5);
    expect(filled).toBe(1);
  });

  it('⑫ 健康哨兵四态：剧痛/需休息/疲惫/健康', () => {
    const d1 = zeros(); d1[1] = 0.8;   // D02 pain
    expect(deriveHealth(d1).state).toBe('unwell');
    const d2 = zeros(); d2[6] = 0.2;   // D07 recovery 低
    expect(deriveHealth(d2).state).toBe('tired');
    const d3 = zeros(); d3[10] = 0.75; // D11 fatigue
    expect(deriveHealth(d3).state).toBe('tired');
    const h = deriveHealth(zeros());
    expect(h.state).toBe('healthy');
    expect(h.line).toContain('好状态');   // 健康态也要美出来
  });
});
