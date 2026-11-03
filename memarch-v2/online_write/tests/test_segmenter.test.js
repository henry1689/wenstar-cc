/**
 * M2 测试：事件分割器（四因子）
 */
import { describe, it, expect } from 'vitest';
import { EventSegmenter } from '../EventSegmenter.js';

describe('EventSegmenter', () => {
  const seg = new EventSegmenter();
  const now = Date.now();

  it('第一条消息无条件切分', () => {
    const result = seg.isBoundary([], {
      ts: now, text: '你好', arousal: 0.3,
    });
    expect(result.is_boundary).toBe(true);
    expect(result.reason).toBe('first_turn');
  });

  it('时间间隔超过 120 分钟应硬切分', () => {
    const history = [{ ts: now - 60 * 60_000, text: '之前聊的', arousal: 0.3 }];
    const current = { ts: now + 130 * 60_000, text: '新话题', arousal: 0.3 };
    const result = seg.isBoundary(history, current);
    expect(result.is_boundary).toBe(true);
    expect(result.reason).toContain('hard_gap');
  });

  it('显式转场词 + 时间间隔应触发切分', () => {
    const t = Date.now();
    const history = [
      { ts: t - 30 * 60_000, text: '我们在聊电机的绝缘漆工艺', arousal: 0.4 },
      { ts: t - 28 * 60_000, text: '对，H级绝缘漆的耐热等级是180度', arousal: 0.4 },
      { ts: t - 25 * 60_000, text: '定子绕组的浸漆温度要控制在120度左右', arousal: 0.4 },
    ];
    const current = {
      ts: t,
      text: '对了，明天晚上想吃什么？我突然想到一家新开的火锅店',
      arousal: 0.6,
    };
    const result = seg.isBoundary(history, current);
    expect(result.factors.cue).toBe(1);  // cue 因子被检测到
    // cue + 时间间隔(25min/30min≈0.83) + arousal变化(0.2) 组合应触发切分
    expect(result.is_boundary).toBe(true);
  });

  it('连续对话无转场词不应切分', () => {
    const history = [
      { ts: now - 5 * 60_000, text: '今天电机测试数据怎么样', arousal: 0.4 },
      { ts: now - 3 * 60_000, text: '定子温升在正常范围内', arousal: 0.4 },
    ];
    const current = {
      ts: now,
      text: '那绝缘电阻呢？有没有达到标准',
      arousal: 0.4,
    };
    const result = seg.isBoundary(history, current);
    // 短时间、无转场、话题一致 → 不应切分（或分数很低）
    expect(result.boundary_score).toBeLessThan(0.55);
  });

  it('唤醒度大幅变化应提升边界分数', () => {
    const history = [
      { ts: now - 5 * 60_000, text: '今天天气不错', arousal: 0.2 },
    ];
    const calm = { ts: now, text: '是啊，适合出去走走', arousal: 0.25 };
    const excited = { ts: now, text: '什么？！你说什么？！这太让人意外了！', arousal: 0.9 };

    const r1 = seg.isBoundary(history, calm);
    const r2 = seg.isBoundary(history, excited);
    expect(r2.factors.arousal).toBeGreaterThan(r1.factors.arousal);
  });

  it('hasTransitionCue 应识别常见转场词', () => {
    expect(seg.hasTransitionCue('对了，明天记得带伞')).toBe(true);
    expect(seg.hasTransitionCue('换个话题，我们说说那个项目')).toBe(true);
    expect(seg.hasTransitionCue('继续聊刚才的电机')).toBe(false);
  });
});
