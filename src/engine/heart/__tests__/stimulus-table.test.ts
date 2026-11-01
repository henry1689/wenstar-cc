/**
 * 24D 刺激量表单元测试
 */
import { describe, it, expect } from 'vitest';
import { getStimulusDelta, getBaseStimulus, DECAY_HALFLIFE, type StimulusType } from '../stimulus-table.js';
import type { EmotionState24 } from '../../bus/types.js';

function defaultEmotion(): EmotionState24 {
  return {
    joy: 30, sadness: 0, anger: 0, fear: 0,
    surprise: 10, disgust: 0, calm: 50, anxiety: 0,
    affection: 20, trust: 30, intimacy: 10, respect: 20,
    arousal: 10, fatigue: 10, excitement: 10, boredom: 0,
    dominance: 0, compliance: 10, warmth: 30, coldness: 0,
    nostalgia: 0, curiosity: 20, shyness: 0, jealousy: 0,
  };
}

describe('stimulus-table', () => {
  it('应该对 praise 事件产生正向情感增量', () => {
    const delta = getStimulusDelta({
      type: 'praise',
      intensity: 0.8,
      trustFactor: 0.6,
      relationStage: 'familiar',
      currentEmotion: defaultEmotion(),
    });

    // affection, trust, joy 应该升高
    expect(delta.affection).toBeGreaterThan(0);
    expect(delta.trust).toBeGreaterThan(0);
    expect(delta.joy).toBeGreaterThan(0);
    // sadness, anger 应该不变或降低
    expect(delta.sadness).toBeLessThanOrEqual(0);
    expect(delta.anger).toBeLessThanOrEqual(0);
  });

  it('应该对 hurtful 事件产生负向情感增量', () => {
    const delta = getStimulusDelta({
      type: 'hurtful',
      intensity: 0.9,
      trustFactor: 0.5,
      relationStage: 'familiar',
      currentEmotion: defaultEmotion(),
    });

    expect(delta.affection).toBeLessThan(0);
    expect(delta.trust).toBeLessThan(0);
    expect(delta.sadness).toBeGreaterThan(0);
    expect(delta.anger).toBeGreaterThan(0);
  });

  it('应该对 intimate_act 事件产生亲密+唤醒增量', () => {
    const delta = getStimulusDelta({
      type: 'intimate_act',
      intensity: 0.7,
      trustFactor: 0.7,
      relationStage: 'intimate',
      currentEmotion: defaultEmotion(),
    });

    expect(delta.intimacy).toBeGreaterThan(0);
    expect(delta.arousal).toBeGreaterThan(0);
    expect(delta.affection).toBeGreaterThan(0);
  });

  it('边际递减应该在情感极值附近生效', () => {
    const extremeEmotion = defaultEmotion();
    extremeEmotion.joy = 95; // 接近上限
    extremeEmotion.affection = 90;

    const deltaNormal = getStimulusDelta({
      type: 'praise',
      intensity: 0.8,
      trustFactor: 0.6,
      relationStage: 'familiar',
      currentEmotion: defaultEmotion(), // 正常值
    });

    const deltaExtreme = getStimulusDelta({
      type: 'praise',
      intensity: 0.8,
      trustFactor: 0.6,
      relationStage: 'familiar',
      currentEmotion: extremeEmotion, // 极值
    });

    // 极值时的增量应该小于正常值
    expect(Math.abs(deltaExtreme.affection)).toBeLessThan(Math.abs(deltaNormal.affection));
  });

  it('关系阶段系数应该正确影响增量', () => {
    const stranger = getStimulusDelta({
      type: 'praise',
      intensity: 0.8,
      trustFactor: 0.6,
      relationStage: 'stranger',
      currentEmotion: defaultEmotion(),
    });

    const intimate = getStimulusDelta({
      type: 'praise',
      intensity: 0.8,
      trustFactor: 0.6,
      relationStage: 'intimate',
      currentEmotion: defaultEmotion(),
    });

    // 亲密期的正向情感增量应该大于陌生期
    // affection 是 positive_steady, stranger 0.5 → intimate 2.0
    expect(intimate.affection).toBeGreaterThan(stranger.affection);
  });

  it('所有 15 种事件类型都有基准值', () => {
    const types: StimulusType[] = [
      'praise', 'tease', 'casual_chat', 'cold', 'hurtful',
      'apology', 'vulnerable', 'question',
      'adult_flirt', 'adult_dominant', 'adult_submissive', 'adult_explicit',
      'intimate_act', 'silence', 'reunion',
    ];

    for (const t of types) {
      const base = getBaseStimulus(t);
      expect(base).not.toBeNull();
      expect(base!.length).toBe(24);
    }
  });

  it('半衰期分类值正确', () => {
    expect(DECAY_HALFLIFE.steady).toBe(72);
    expect(DECAY_HALFLIFE.acute).toBe(2);
    expect(DECAY_HALFLIFE.cognitive).toBe(120);
    expect(DECAY_HALFLIFE.negative).toBe(48);
    expect(DECAY_HALFLIFE.social).toBe(12);
  });
});
