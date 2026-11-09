import { describe, it, expect, vi } from 'vitest';
import { detectProactiveTriggers, filterTriggers } from '../proactive-trigger.js';

/**
 * MEM-UNIFY-V1 批4 · 主动回忆触发器回归
 * 五类信号：节日 / 纪念日 / 情绪 / 日常 / 话题关联；纯规则、零 LLM、零副作用。
 */

const NOON = new Date('2026-11-09T12:00:00+08:00');
const NIGHT = new Date('2026-11-09T22:00:00+08:00');
const EARLY_MORNING = new Date('2026-11-09T03:00:00+08:00');

describe('主动触发 · 五类信号', () => {
  it('节日：调用方传入的节日名直接成信号', () => {
    const res = detectProactiveTriggers('今天过得怎么样', { now: NOON, festivals: ['中秋节'] });
    const festival = res.triggers.find(t => t.type === 'festival');
    expect(res.active).toBe(true);
    expect(festival?.reason).toContain('中秋节');
    expect(festival?.weight).toBeGreaterThan(0.8);
  });

  it('情绪：负面优先于正面（同句并存时只取负面）', () => {
    const neg = detectProactiveTriggers('今天有点累，不过也挺开心', { now: NOON });
    const e = neg.triggers.find(t => t.type === 'emotion');
    expect(e?.signal).toBe('negative');
    expect(e?.reason).toContain('累');

    const pos = detectProactiveTriggers('今天太开心了', { now: NOON });
    expect(pos.triggers.find(t => t.type === 'emotion')?.signal).toBe('positive');
  });

  it('日常：按当前时段判定（睡前窗口）', () => {
    const res = detectProactiveTriggers('在吗', { now: NIGHT });
    const r = res.triggers.find(t => t.type === 'routine');
    expect(r?.signal).toBe('night');
  });

  it('话题关联：复用召回概念图（daily 主题）', () => {
    const res = detectProactiveTriggers('周末想出去散步', { now: NOON });
    const topic = res.triggers.find(t => t.type === 'topic');
    expect(topic?.reason).toContain('daily');
  });

  it('纪念日：往年同月同日有高钙/地标记忆才触发', () => {
    const queryAll = vi.fn(() => [{ n: 2, earliest: '2024' }]);
    const res = detectProactiveTriggers('今天有什么特别的吗', {
      now: NOON, sqlite: { queryAll }, entityUuid: 'TXS-000000001',
    });
    const ann = res.triggers.find(t => t.type === 'anniversary');
    expect(ann?.reason).toContain('2 条');
    expect(queryAll).toHaveBeenCalledTimes(1);
    // SQL 必须带 UUID 隔离与「往年」条件（不是全表扫）
    const sql = String((queryAll.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain('belong_entity_uuid = ?');
    expect(sql).toContain('substr(created_at, 1, 4) < ?');
  });

  it('纪念日：无库命中但对方明说纪念日 → 轻信号', () => {
    const res = detectProactiveTriggers('今天是我们的纪念日', { now: NOON });
    expect(res.triggers.find(t => t.type === 'anniversary')?.weight).toBeLessThan(0.85);
  });

  it('无信号：夜里三点、中性短句 → 不触发', () => {
    const res = detectProactiveTriggers('嗯', { now: EARLY_MORNING });
    expect(res.active).toBe(false);
    expect(res.triggers).toHaveLength(0);
  });

  it('空消息不触发', () => {
    expect(detectProactiveTriggers('', { now: NOON }).active).toBe(false);
  });
});

describe('主动触发 · 过滤与排序', () => {
  it('按权重降序排列', () => {
    const res = detectProactiveTriggers('今天好累', { now: NIGHT, festivals: ['中秋节'] });
    const weights = res.triggers.map(t => t.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it('filterTriggers：低于阈值丢弃并重算 active', () => {
    const res = detectProactiveTriggers('在吗', { now: NIGHT });
    expect(res.active).toBe(true); // 仅 routine(0.4)
    const filtered = filterTriggers(res, 0.5);
    expect(filtered.active).toBe(false);
    expect(filtered.triggers).toHaveLength(0);
  });
});
