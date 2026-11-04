import { describe, it, expect } from 'vitest';
import { attribute, toReinforceSignal } from '../attributor.js';
import { DEFAULT_CONFIG } from '../config.js';
import { ev } from './helpers.js';

const cfg = DEFAULT_CONFIG.attribution;

describe('attributor.ts — 强化归因器', () => {
  it('confirm：确认词 + token 命中证据', () => {
    const evidences = [ev({ uuid: 'u1', raw_text: '你喜欢喝咖啡' })];
    const hits = attribute({
      user_reply: '对，我喜欢喝咖啡',
      used_evidences: evidences,
      config: cfg,
    });
    expect(hits.some((h) => h.uuid === 'u1' && h.signal === 'confirm')).toBe(true);
  });

  it('correct：纠正词命中 → 对所有 used 证据打 correct', () => {
    const evidences = [
      ev({ uuid: 'u1', raw_text: '你喜欢喝咖啡' }),
      ev({ uuid: 'u2', raw_text: '上次在东莞' }),
    ];
    const hits = attribute({
      user_reply: '不对，我不喜欢喝咖啡',
      used_evidences: evidences,
      config: cfg,
    });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.signal === 'correct')).toBe(true);
  });

  it('engaged：用户提到了证据内容但无明确肯定', () => {
    const evidences = [ev({ uuid: 'u1', raw_text: '你喜欢喝咖啡，特别是拿铁' })];
    const hits = attribute({
      user_reply: '拿铁最近好像涨价了',
      used_evidences: evidences,
      config: cfg,
    });
    expect(hits.some((h) => h.uuid === 'u1' && h.signal === 'engaged')).toBe(true);
  });

  it('ignored：用户完全没接话头 → top-1 证据打 ignored', () => {
    const evidences = [
      ev({ uuid: 'u1', raw_text: '你喜欢喝咖啡', score: 0.9 }),
      ev({ uuid: 'u2', raw_text: '你喜欢跑步', score: 0.5 }),
    ];
    const hits = attribute({
      user_reply: '今天天气真好',
      used_evidences: evidences,
      config: cfg,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].signal).toBe('ignored');
    expect(hits[0].uuid).toBe('u1');
  });

  it('correct 优先级最高——即使同时有 confirm 词也按 correct 走', () => {
    const evidences = [ev({ uuid: 'u1', raw_text: '你喜欢喝咖啡' })];
    const hits = attribute({
      user_reply: '对的，但其实是我更喜欢茶',
      used_evidences: evidences,
      config: cfg,
    });
    expect(hits[0].signal).toBe('correct');
  });

  it('空回应 → 无归因', () => {
    expect(attribute({ user_reply: '', used_evidences: [], config: cfg })).toHaveLength(0);
  });

  it('toReinforceSignal 映射正确', () => {
    expect(toReinforceSignal('confirm')).toBe('positive');
    expect(toReinforceSignal('engaged')).toBe('positive');
    expect(toReinforceSignal('ignored')).toBe('negative');
  });
});
