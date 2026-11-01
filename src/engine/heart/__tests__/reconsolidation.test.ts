/**
 * 记忆再巩固单元测试
 */
import { describe, it, expect } from 'vitest';
import { applyReconsolidation, evaluateLibraryPromotion } from '../reconsolidation.js';
import type { EmotionState24 } from '../../bus/types.js';

function neutralEmotion(): EmotionState24 {
  return {
    joy: 30, sadness: 0, anger: 0, fear: 0,
    surprise: 10, disgust: 0, calm: 50, anxiety: 0,
    affection: 20, trust: 30, intimacy: 10, respect: 20,
    arousal: 10, fatigue: 10, excitement: 10, boredom: 0,
    dominance: 0, compliance: 10, warmth: 30, coldness: 0,
    nostalgia: 0, curiosity: 20, shyness: 0, jealousy: 0,
  };
}

describe('reconsolidation', () => {
  it('应该在高情感强度时增强重要度', () => {
    const highEmotion = neutralEmotion();
    highEmotion.arousal = 70;
    highEmotion.joy = 80;

    const result = applyReconsolidation({
      currentImportance: 50,
      currentVividness: 50,
      retrievalEmotion: highEmotion,
      trust: 50,
      ageHours: 24,
      retrievalCount: 3,
    });

    expect(result.importanceDelta).toBeGreaterThan(0);
    expect(result.newImportance).toBeGreaterThan(50);
  });

  it('应该限制单次调整量不超过 ±5', () => {
    const intense = neutralEmotion();
    intense.arousal = 100;
    intense.joy = 100;

    const result = applyReconsolidation({
      currentImportance: 50,
      currentVividness: 50,
      retrievalEmotion: intense,
      trust: 100,
      ageHours: 1,
      retrievalCount: 10,
    });

    expect(Math.abs(result.importanceDelta)).toBeLessThanOrEqual(5.1);
  });

  it('累计偏移超过 30 时应触发 AQC', () => {
    const result = applyReconsolidation({
      currentImportance: 60,
      currentVividness: 60,
      retrievalEmotion: neutralEmotion(),
      trust: 80,
      ageHours: 1,
      retrievalCount: 5,
    }, 28); // 已有 28 偏移

    expect(result.importanceDelta).toBeGreaterThan(0);
    // 如果新偏移导致累计 ≥ 30
    const wouldTrigger = (28 + Math.abs(result.importanceDelta)) >= 30;
    expect(result.triggerAQC).toBe(wouldTrigger);
  });

  it('长期不检索时重要度调整量不超过限制', () => {
    const result = applyReconsolidation({
      currentImportance: 50,
      currentVividness: 90,
      retrievalEmotion: neutralEmotion(),
      trust: 30,
      ageHours: 2160, // 90 天
      retrievalCount: 1,
    });

    expect(Math.abs(result.importanceDelta)).toBeLessThanOrEqual(5);
    expect(result.newImportance).toBeGreaterThanOrEqual(0);
    expect(result.newImportance).toBeLessThanOrEqual(100);
  });

  it('应该正确评估跨库晋升', () => {
    const promote = evaluateLibraryPromotion(75, 65, 50, 'familiar');
    expect(promote).toBe('promote_sand_to_gold');

    const diamond = evaluateLibraryPromotion(90, 85, 70, 'intimate');
    expect(diamond).toBe('promote_gold_to_diamond');

    const forget = evaluateLibraryPromotion(5, 10, 20, 'stranger');
    expect(forget).toBe('forget');
  });
});
