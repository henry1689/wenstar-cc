import { describe, it, expect } from 'vitest';
import {
  evaluateDiamondPromotion,
  isEmotionalRelationalTag,
  isEmotionalRelationalMem,
  hasIntimateContent,
  normalizeCalcium01,
  EMOTION_REL_TAGS,
} from '../VaultManager.js';

/** 造一条可被评估的记忆（非元对话，lifecycle 可晋升） */
function mem(over: Record<string, any> = {}): Record<string, any> {
  return {
    raw_input: '那天我们一起在窗边看雨，很温柔',
    summary: '',
    narrative_tag: '',
    calcium_score: 0,
    recall_count: 0,
    lifecycle_state: 'active',
    promoted_to_diamond: 0,
    effective_strength: 0.5,
    ...over,
  };
}

describe('U3 情感/关系低钙晋升通道 (T068任务1)', () => {
  it('情感记忆低钙(0-1量纲0.625) recall>=1 可晋升', () => {
    const d = evaluateDiamondPromotion(mem({ narrative_tag: '亲密', calcium_score: 0.625, recall_count: 1 }));
    expect(d.eligible).toBe(true);
    expect(d.reason).toContain('emotion-channel');
  });

  it('非情感记忆低钙 recall>=1 不晋升', () => {
    const d = evaluateDiamondPromotion(mem({ narrative_tag: '日常印记', calcium_score: 0.625, recall_count: 1 }));
    expect(d.eligible).toBe(false);
  });

  it('情感记忆 recall=0 不晋升（须证明有价值）', () => {
    const d = evaluateDiamondPromotion(mem({ narrative_tag: '情感', calcium_score: 0.625, recall_count: 0 }));
    expect(d.eligible).toBe(false);
  });

  it('情感记忆归一化钙<0.3 不晋升', () => {
    // 0-1 量纲 0.2 < 0.3
    const d = evaluateDiamondPromotion(mem({ narrative_tag: '家庭', calcium_score: 0.2, recall_count: 2 }));
    expect(d.eligible).toBe(false);
  });

  it('三量纲归一化判断正确', () => {
    expect(normalizeCalcium01(0.625)).toBeCloseTo(0.625, 5); // 0-1 量纲
    expect(normalizeCalcium01(4.0)).toBeCloseTo(0.8, 5); // 1-5 量纲 ÷5
    expect(normalizeCalcium01(7)).toBeCloseTo(0.7, 5); // 5-10 量纲 ÷10
    expect(normalizeCalcium01(0)).toBe(0);
  });

  it('三量纲情感记忆都能经归一化过阈值', () => {
    // 1-5 量纲: 4.2÷5=0.84>=0.3
    expect(evaluateDiamondPromotion(mem({ narrative_tag: '恋爱', calcium_score: 4.2, recall_count: 1 })).eligible).toBe(true);
    // 5-10 量纲: 7÷10=0.7>=0.3
    expect(evaluateDiamondPromotion(mem({ narrative_tag: '感情', calcium_score: 7, recall_count: 1 })).eligible).toBe(true);
    // 0-1 量纲: 0.625>=0.3
    expect(evaluateDiamondPromotion(mem({ narrative_tag: '亲密', calcium_score: 0.625, recall_count: 1 })).eligible).toBe(true);
  });

  it('isEmotionalRelationalTag 识别情感/关系类', () => {
    expect(isEmotionalRelationalTag('亲密')).toBe(true);
    expect(isEmotionalRelationalTag('情感')).toBe(true);
    expect(isEmotionalRelationalTag('家庭')).toBe(true);
    expect(isEmotionalRelationalTag('user.emotion.romantic')).toBe(true);
    expect(isEmotionalRelationalTag('user.family.conflict')).toBe(true);
    expect(isEmotionalRelationalTag('日常印记')).toBe(false);
    expect(isEmotionalRelationalTag('梦境沉淀')).toBe(false);
    expect(isEmotionalRelationalTag(null)).toBe(false);
    expect(isEmotionalRelationalTag('')).toBe(false);
  });

  it('情感标签集不含工作/知识等非情感类', () => {
    expect(isEmotionalRelationalTag('工作')).toBe(false);
    expect(isEmotionalRelationalTag('知识')).toBe(false);
    expect(EMOTION_REL_TAGS.length).toBeGreaterThan(0);
  });

  // ── U3-A 内容判据（narrative_tag 缺口覆盖：亲密记忆 tag 多为 NULL/梦境沉淀） ──
  it('亲密内容但 narrative_tag 为 NULL 也可经内容判据晋升', () => {
    const d = evaluateDiamondPromotion(mem({
      narrative_tag: null,
      raw_input: '那一晚我们第一次亲热，很温存',
      calcium_score: 0.625,
      recall_count: 2,
    }));
    expect(d.eligible).toBe(true);
    expect(d.reason).toContain('emotion-channel');
  });

  it('亲密内容 recall=0 不晋升', () => {
    const d = evaluateDiamondPromotion(mem({
      narrative_tag: '梦境沉淀',
      raw_input: '梦见我们亲热的场景',
      calcium_score: 0.625,
      recall_count: 0,
    }));
    expect(d.eligible).toBe(false);
  });

  it('亲密内容归一钙 <0.3 不晋升', () => {
    const d = evaluateDiamondPromotion(mem({
      narrative_tag: null,
      raw_input: '那天我们拥抱了一下',
      calcium_score: 0.15,
      recall_count: 3,
    }));
    // 归一 0.15 < 0.3 ⇒ 情感通道不过（但 recall>=3 会走原候选路径，此处 narrative/tag 无原路径故 fail）
    expect(d.eligible).toBe(false);
  });

  it('hasIntimateContent / isEmotionalRelationalMem 判据', () => {
    expect(hasIntimateContent({ raw_input: '我们第一次亲热' })).toBe(true);
    expect(hasIntimateContent({ raw_input: '今天买了菜', summary: '' })).toBe(false);
    expect(isEmotionalRelationalMem({ narrative_tag: '亲密', raw_input: 'x' })).toBe(true);
    expect(isEmotionalRelationalMem({ narrative_tag: '日常印记', raw_input: '那一晚很温存' })).toBe(true);
    expect(isEmotionalRelationalMem({ narrative_tag: '日常印记', raw_input: '普通对话' })).toBe(false);
  });
});
