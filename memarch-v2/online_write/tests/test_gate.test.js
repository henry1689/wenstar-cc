/**
 * M2 测试：三岔门控
 */
import { describe, it, expect } from 'vitest';
import { GateDecider } from '../Gate.js';

describe('GateDecider', () => {
  const gate = new GateDecider();

  it('namespace=test 应直接 DISCARD', () => {
    const entry = {
      message_id: 't1', namespace: 'test', role: 'user',
      content: '测试数据', ts_utc: Date.now(),
      salience: 0.9, has_meaningful_entity: true,
    };
    expect(gate.decide(entry)).toBe('DISCARD');
  });

  it('纯寒暄短句应 DISCARD', () => {
    const entry = {
      message_id: 's1', namespace: 'default', role: 'user',
      content: '你好', ts_utc: Date.now(),
      salience: 0.1, has_meaningful_entity: false,
    };
    expect(gate.decide(entry)).toBe('DISCARD');
  });

  it('高显著性 + 有实体应 WRITE', () => {
    const entry = {
      message_id: 'w1', namespace: 'default', role: 'user',
      content: '我决定下个月辞职去杭州创业，第一次创业很激动',
      ts_utc: Date.now(),
      salience: 0.7, has_meaningful_entity: true,
    };
    expect(gate.decide(entry)).toBe('WRITE');
  });

  it('中等显著性但无实体应 RAW_ONLY', () => {
    const entry = {
      message_id: 'r1', namespace: 'default', role: 'user',
      content: '今天心情一般般吧，也没什么特别的事',
      ts_utc: Date.now(),
      salience: 0.3, has_meaningful_entity: false,
    };
    expect(gate.decide(entry)).toBe('RAW_ONLY');
  });

  it('显著性高但无实体应 RAW_ONLY（而非 WRITE）', () => {
    const entry = {
      message_id: 'r2', namespace: 'default', role: 'user',
      content: '我觉得这个事情很重要，非常非常重要',
      ts_utc: Date.now(),
      salience: 0.6, has_meaningful_entity: false,
    };
    expect(gate.decide(entry)).toBe('RAW_ONLY');
  });

  it('healthCheck 应正确判断门控分布健康度', () => {
    // 健康分布：WRITE 25%, DISCARD 40%
    const healthy = GateDecider.healthCheck({ write: 25, rawOnly: 35, discard: 40 });
    expect(healthy.healthy).toBe(true);

    // WRITE 过高
    const tooManyWrite = GateDecider.healthCheck({ write: 50, rawOnly: 20, discard: 30 });
    expect(tooManyWrite.healthy).toBe(false);

    // DISCARD 过低
    const tooFewDiscard = GateDecider.healthCheck({ write: 20, rawOnly: 70, discard: 10 });
    expect(tooFewDiscard.healthy).toBe(false);
  });
});
