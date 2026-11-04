import { describe, it, expect } from 'vitest';
import { labelSingle, labelAggregate, isVagueMoodQuery, hasConflict } from '../labeler.js';
import { DEFAULT_CONFIG } from '../config.js';
import { ev } from './helpers.js';

const cfg = DEFAULT_CONFIG.labels;

describe('labeler.ts — 证据标签四档判定', () => {
  it('「记得」档：score≥0.6 且 recency≤30 天', () => {
    expect(labelSingle(ev({ uuid: 'u1', raw_text: 'x', score: 0.8, recency: 5 }), cfg)).toBe('remembered');
    expect(labelSingle(ev({ uuid: 'u2', raw_text: 'x', score: 0.6, recency: 30 }), cfg)).toBe('remembered');
  });

  it('「记得」档准确率：标"记得"的证据必须满足 score+recency 区间（≥95% 校准）', () => {
    // 批量打标，验证所有标 remembered 的证据都满足阈值
    const samples = [
      ev({ uuid: 'a', raw_text: 'x', score: 0.7, recency: 10 }),
      ev({ uuid: 'b', raw_text: 'x', score: 0.9, recency: 29 }),
      ev({ uuid: 'c', raw_text: 'x', score: 0.61, recency: 1 }),
    ];
    for (const s of samples) {
      const label = labelSingle(s, cfg);
      if (label === 'remembered') {
        expect(s.score).toBeGreaterThanOrEqual(cfg.remembered.min_score);
        expect(s.recency).toBeLessThanOrEqual(cfg.remembered.max_recency_days);
      }
    }
  });

  it('score 够但 recency 太远 → 降到 impression', () => {
    expect(labelSingle(ev({ uuid: 'u1', raw_text: 'x', score: 0.9, recency: 365 }), cfg)).toBe('impression');
  });

  it('「印象」档：score≥0.35', () => {
    expect(labelSingle(ev({ uuid: 'u1', raw_text: 'x', score: 0.5, recency: 100 }), cfg)).toBe('impression');
    expect(labelSingle(ev({ uuid: 'u2', raw_text: 'x', score: 0.35, recency: 9999 }), cfg)).toBe('impression');
  });

  it('「线索」档：score≥0.15', () => {
    expect(labelSingle(ev({ uuid: 'u1', raw_text: 'x', score: 0.2, recency: 100 }), cfg)).toBe('clue');
  });

  it('「不说」档：score<0.15', () => {
    expect(labelSingle(ev({ uuid: 'u1', raw_text: 'x', score: 0.05, recency: 100 }), cfg)).toBe('refused');
  });

  it('tombstone → refused', () => {
    expect(labelSingle(ev({ uuid: 'u1', raw_text: 'x', score: 0.9, tombstone: true }), cfg)).toBe('refused');
  });

  it('标签校准：四档对应的 score 区间与 config 声明一致', () => {
    // remembered
    expect(labelSingle(ev({ uuid: '1', raw_text: 'x', score: cfg.remembered.min_score, recency: 0 }), cfg)).toBe('remembered');
    // impression（score 在 remembered 与 impression 之间）
    const mid = (cfg.remembered.min_score + cfg.impression.min_score) / 2;
    expect(labelSingle(ev({ uuid: '2', raw_text: 'x', score: mid, recency: 9999 }), cfg)).toBe('impression');
    // clue
    const mid2 = (cfg.impression.min_score + cfg.clue.min_score) / 2;
    expect(labelSingle(ev({ uuid: '3', raw_text: 'x', score: mid2, recency: 9999 }), cfg)).toBe('clue');
    // refused
    expect(labelSingle(ev({ uuid: '4', raw_text: 'x', score: 0.01, recency: 0 }), cfg)).toBe('refused');
  });

  it('边界："就像我们之前那种温柔的感觉"——借氛围，强制降到 impression，不得判 remembered', () => {
    // 强证据本来应该是 remembered
    const strong = ev({ uuid: 'u1', raw_text: '你喜欢温柔的对话方式', score: 0.9, recency: 3 });
    expect(labelSingle(strong, cfg)).toBe('remembered');
    // 但用户 query 是借氛围 → 聚合后降档
    const result = labelAggregate({
      evidences: [strong],
      user_query: '就像我们之前那种温柔的感觉',
      config: cfg,
    });
    expect(result.degraded_vague).toBe(true);
    expect(result.label).toBe('impression');
    expect(result.label).not.toBe('remembered');
  });

  it('边界："那种感觉"短 query 触发模糊检测', () => {
    expect(isVagueMoodQuery('那种感觉')).toBe(true);
    expect(isVagueMoodQuery('就像我们之前那样')).toBe(true);
    expect(isVagueMoodQuery('我昨天吃了什么')).toBe(false);
  });

  it('边界：多条 A-side 证据矛盾 → 降一档', () => {
    const evA = ev({
      uuid: 'e1',
      raw_text: '你喜欢喝咖啡',
      score: 0.9,
      recency: 5,
      entities: ['咖啡'],
    });
    const evB = ev({
      uuid: 'e2',
      raw_text: '你不喜欢喝咖啡',
      score: 0.85,
      recency: 10,
      entities: ['咖啡'],
    });
    expect(hasConflict([evA, evB])).toBe(true);
    const result = labelAggregate({
      evidences: [evA, evB],
      user_query: '我喜欢喝什么',
      config: cfg,
    });
    // 原本 top = remembered（两条都够），矛盾 → 降到 impression
    expect(result.degraded_conflict).toBe(true);
    expect(result.label).toBe('impression');
  });

  it('边界：证据无共享实体 → 不算矛盾', () => {
    const evA = ev({ uuid: 'e1', raw_text: '你喜欢喝咖啡', score: 0.9, entities: ['咖啡'] });
    const evB = ev({ uuid: 'e2', raw_text: '你不喜欢跑步', score: 0.85, entities: ['跑步'] });
    expect(hasConflict([evA, evB])).toBe(false);
  });
});
