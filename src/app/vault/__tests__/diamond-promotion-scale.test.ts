/**
 * 黑钻晋升的**量纲归一**能力断言（2026-09-22 修复）
 *
 * 背景（实测）：晋升规则里的阈值（4.5 / 4.0 / 3.5）是按 **0–5** 量纲写的，
 * 而 `calcium_score` 实测是 **0–1**（candidate 2927 条中 `>=4.5` 与 `recall>=5` 均为 **0 条**）
 * ⇒ 晋升通道等于死路，砂金堆积到 51 天。
 *
 * 要证明的能力：
 * 1. 0–1 量纲：高钙化（≥0.9）能晋升；
 * 2. 0–5 量纲（历史数据）：等价值（≥4.5）同样能晋升（归一化生效）；
 * 3. 低钙化且无因子 ⇒ 不晋升（不能因修复而滥发黑钻）；
 * 4. 元对话/自我陈述**仍**不具资格（与钙化分无关）。
 */
import { describe, it, expect } from 'vitest';

import { evaluateDiamondPromotion } from '../VaultManager.js';

const base = { raw_input: '今天和她一起去了海边，她说想每年都来', summary: '' };

describe('黑钻晋升 · 量纲归一', () => {
  it('0–1 量纲：calcium_score 0.95 ⇒ 达到 native-calcium 线（晋升）', () => {
    const d = evaluateDiamondPromotion({ ...base, calcium_score: 0.95 });
    expect(d.eligible).toBe(true);
    expect(d.targetState).toBe('promoted');
  });

  it('0–5 量纲（历史数据）：calcium_score 4.75 ⇒ 归一后同样晋升', () => {
    const d = evaluateDiamondPromotion({ ...base, calcium_score: 4.75 });
    expect(d.eligible, '0–5 量纲的历史记忆不得被漏掉').toBe(true);
  });

  it('低钙化且无任何因子 ⇒ 不晋升（不滥发黑钻）', () => {
    const d = evaluateDiamondPromotion({ ...base, calcium_score: 0.2, recall_count: 0 });
    expect(d.eligible).toBe(false);
    expect(d.targetState).toBe('candidate');
  });

  it('landmark + 中等钙化（0.75）⇒ 晋升', () => {
    const d = evaluateDiamondPromotion({ ...base, calcium_score: 0.75, is_landmark: 1 });
    expect(d.eligible).toBe(true);
  });

  it('多因子达标（landmark + 高钙化 ⇒ score≥5 且因子≥2）⇒ 晋升', () => {
    const d = evaluateDiamondPromotion({ ...base, calcium_score: 0.85, is_landmark: 1 });
    expect(d.eligible).toBe(true);
    expect(String(d.reason)).toMatch(/multi-factor|landmark/);
  });

  it('元对话/自我陈述 ⇒ 无论钙化多高都无资格', () => {
    const d = evaluateDiamondPromotion({ ...base, raw_input: '系统提示：请总结以上对话', calcium_score: 0.99 });
    expect(d.eligible).toBe(false);
    expect(d.reason).toBe('meta-discourse');
  });
});
