/**
 * M2 测试：在线显著性快速计算
 */
import { describe, it, expect } from 'vitest';
import { SalienceCalculator } from '../SalienceCalculator.js';

describe('SalienceCalculator', () => {
  const calc = new SalienceCalculator();

  it('寒暄短句应该低显著性', () => {
    const entry = {
      message_id: 'm1', namespace: 'default', role: 'user',
      content: '你好', ts_utc: Date.now(), arousal: 0.2,
    };
    const { salience, components } = calc.calculate(entry);
    expect(salience).toBeLessThan(0.3);
    expect(components.imp_rule).toBe(0);
  });

  it('包含计划/决定关键词应该提升 imp_rule', () => {
    const entry = {
      message_id: 'm2', namespace: 'default', role: 'user',
      content: '我决定下个月辞职去杭州创业，这是第一次创业',
      ts_utc: Date.now(), arousal: 0.5,
    };
    const { salience, components } = calc.calculate(entry);
    expect(components.imp_rule).toBeGreaterThanOrEqual(0.8);
    expect(salience).toBeGreaterThan(0.3);
  });

  it('包含第一人称 + 关系词应该提升 self_rule', () => {
    const entry = {
      message_id: 'm3', namespace: 'default', role: 'user',
      content: '我妈妈今天生日，我给她买了个蛋糕',
      ts_utc: Date.now(), arousal: 0.4,
    };
    const { components } = calc.calculate(entry);
    expect(components.self_rule).toBeGreaterThanOrEqual(0.5);
  });

  it('高唤醒度应该提升 arousal 因子', () => {
    const e1 = {
      message_id: 'e1', namespace: 'default', role: 'user',
      content: '今天天气不错', ts_utc: Date.now(), arousal: 0.2,
    };
    const e2 = {
      message_id: 'e2', namespace: 'default', role: 'user',
      content: '今天天气不错', ts_utc: Date.now(), arousal: 0.9,
    };
    const r1 = calc.calculate(e1);
    const r2 = calc.calculate(e2);
    expect(r2.salience).toBeGreaterThan(r1.salience);
  });

  it('isSmallTalk 应正确识别寒暄', () => {
    expect(calc.isSmallTalk('你好')).toBe(true);
    expect(calc.isSmallTalk('谢谢')).toBe(true);
    expect(calc.isSmallTalk('好的，我知道了，我们明天下午三点在公司会议室开会讨论那个项目')).toBe(false);
  });
});
