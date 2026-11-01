/**
 * 情感标签映射单元测试
 */
import { describe, it, expect } from 'vitest';
import { classifyEmotion } from '../emotion-label.js';
import type { EmotionState24 } from '../../bus/types.js';

function makeVector(values: Partial<EmotionState24>): EmotionState24 {
  const base: EmotionState24 = {
    joy: 0, sadness: 0, anger: 0, fear: 0,
    surprise: 0, disgust: 0, calm: 0, anxiety: 0,
    affection: 0, trust: 0, intimacy: 0, respect: 0,
    arousal: 0, fatigue: 0, excitement: 0, boredom: 0,
    dominance: 0, compliance: 0, warmth: 0, coldness: 0,
    nostalgia: 0, curiosity: 0, shyness: 0, jealousy: 0,
  };
  return { ...base, ...values };
}

describe('emotion-label', () => {
  it('应该识别甜蜜依恋', () => {
    const result = classifyEmotion(makeVector({
      affection: 50, intimacy: 40, joy: 45, arousal: 30, trust: 40,
    }));
    expect(result.primary.subtype).toBe('甜蜜依恋');
  });

  it('应该识别委屈受伤', () => {
    const result = classifyEmotion(makeVector({
      sadness: 40, trust: 15, anger: 10, anxiety: 25,
    }));
    expect(result.primary.subtype).toBe('委屈受伤');
  });

  it('应该识别娇羞', () => {
    const result = classifyEmotion(makeVector({
      shyness: 40, intimacy: 35, arousal: 30, warmth: 30,
    }));
    expect(result.primary.subtype).toBe('娇羞');
  });

  it('应该识别安静喜欢', () => {
    const result = classifyEmotion(makeVector({
      affection: 30, joy: 25, arousal: 10, shyness: 15,
    }));
    expect(result.primary.subtype).toBe('安静喜欢');
  });

  it('应该返回平静理性作为默认值', () => {
    const result = classifyEmotion(makeVector({
      calm: 60, joy: 10,
    }));
    // 无匹配时返回平静理性
    expect(result.primary.subtype).toBe('平静理性');
  });
});
