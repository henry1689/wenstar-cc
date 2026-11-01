/**
 * 24D 情感衰减引擎单元测试
 */
import { describe, it, expect } from 'vitest';
import { applyDecay, applyDecayOnly } from '../emotion-decay.js';
import type { EmotionState24 } from '../../bus/types.js';

function makeVector(values?: Partial<EmotionState24>): EmotionState24 {
  const base: EmotionState24 = {
    joy: 30, sadness: 0, anger: 0, fear: 0,
    surprise: 10, disgust: 0, calm: 50, anxiety: 0,
    affection: 20, trust: 30, intimacy: 10, respect: 20,
    arousal: 10, fatigue: 10, excitement: 10, boredom: 0,
    dominance: 0, compliance: 10, warmth: 30, coldness: 0,
    nostalgia: 0, curiosity: 20, shyness: 0, jealousy: 0,
  };
  return { ...base, ...values };
}

describe('emotion-decay', () => {
  it('应该对稳态维度做 72h 半衰期衰减', () => {
    const vec = makeVector({ trust: 80, affection: 70 });
    const result = applyDecayOnly(vec, 72); // 72h = 1个半衰期

    // trust: 80×e^(-1) = 29.4, 基线回归 -36%距离 ≈ 18.9
    expect(result.trust).toBeGreaterThan(15);
    expect(result.trust).toBeLessThan(25);

    // affection 类似: 70×e^(-1) = 25.7, 基线回归 ≈ 16.5
    expect(result.affection).toBeGreaterThan(12);
    expect(result.affection).toBeLessThan(22);
  });

  it('应该对急性唤醒维度做 2h 半衰期衰减', () => {
    const vec = makeVector({ arousal: 80, excitement: 70 });
    const result = applyDecayOnly(vec, 4); // 4h = 2个半衰期

    // arousal: 80×e^(-2) = 10.8, 基线回归 ≈ 10.6
    expect(result.arousal).toBeGreaterThan(8);
    expect(result.arousal).toBeLessThan(15);
  });

  it('应该对认知特质维度做 120h 慢衰减', () => {
    const vec = makeVector({ curiosity: 80, nostalgia: 60 });
    const result = applyDecayOnly(vec, 24); // 24h 对 120h 半衰期影响很小

    // curiosity 只衰减一点: 80 → ~55（基线低于实际值，附加基线回归）
    expect(result.curiosity).toBeGreaterThan(50);
    expect(result.nostalgia).toBeGreaterThan(40);
  });

  it('应该应用刺激增量', () => {
    const vec = makeVector({ joy: 30, affection: 20 });
    const result = applyDecay({
      current: vec,
      delta: { joy: 15, affection: 20 } as Partial<EmotionState24>,
      deltaHours: 0, // 瞬时刺激
      relationStage: 'familiar',
    });

    expect(result.vector.joy).toBeGreaterThan(40);
    expect(result.vector.affection).toBeGreaterThan(35);
    expect(result.appliedDelta).toBe(true);
  });

  it('应该限制在 [0, 100] 区间', () => {
    const vec = makeVector({ joy: 95 });
    const result = applyDecay({
      current: vec,
      delta: { joy: 20 } as Partial<EmotionState24>,
      deltaHours: 0,
      relationStage: 'familiar',
    });

    expect(result.vector.joy).toBeLessThanOrEqual(100);
  });

  it('长时间无对话后应该向基线回落', () => {
    const vec = makeVector({ joy: 90, trust: 90 });
    const result = applyDecayOnly(vec, 720); // 30天无对话

    // 应该接近基线值
    expect(result.joy).toBeGreaterThan(0);
    expect(result.joy).toBeLessThan(50); // 基线0.3
    expect(result.trust).toBeGreaterThan(0);
    expect(result.trust).toBeLessThan(20); // 基线0.3
  });
});
