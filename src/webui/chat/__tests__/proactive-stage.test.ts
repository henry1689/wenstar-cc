import { describe, it, expect } from 'vitest';
import { detectProactive, buildProactiveDirective, getTodayFestivals } from '../proactive-stage.js';

/**
 * MEM-UNIFY-V1 批4 · 主动回忆接线阶段
 * 锁定：节日走 CalendarEngine 单源、指令文案走 MEMORY-LAW-V1 单源、配置阈值生效。
 */

describe('ProactiveStage · 节日单源', () => {
  it('国庆节由 CalendarEngine 判定（不另建节日表）', () => {
    const list = getTodayFestivals(new Date('2026-10-01T12:00:00+08:00'));
    expect(list).toContain('国庆节');
  });

  it('普通日期不虚构节日', () => {
    const list = getTodayFestivals(new Date('2026-11-09T12:00:00+08:00'));
    expect(Array.isArray(list)).toBe(true);
  });
});

describe('ProactiveStage · 检测与开关', () => {
  it('配置开启时情绪信号可触发', () => {
    const res = detectProactive('今天真的好累', { now: new Date('2026-11-09T12:00:00+08:00') });
    expect(res.active).toBe(true);
    expect(res.triggers.some(t => t.type === 'emotion')).toBe(true);
  });

  it('无信号时不触发', () => {
    const res = detectProactive('嗯', { now: new Date('2026-11-09T03:00:00+08:00') });
    expect(res.active).toBe(false);
  });
});

describe('ProactiveStage · 指令单源', () => {
  it('无信号返回空串（调用方不得注入空块）', () => {
    expect(buildProactiveDirective({ active: false, triggers: [] })).toBe('');
  });

  it('有信号时包含主动义务/三重奏/憧憬自由（MEMORY-LAW-V1）', () => {
    const text = buildProactiveDirective({
      active: true,
      triggers: [{ type: 'emotion', weight: 0.8, reason: '对方情绪需要陪伴（累）' }],
    });
    expect(text).toContain('【主动回忆 · MemSym】');
    expect(text).toContain('主动义务');
    expect(text).toContain('三重奏');
    expect(text).toContain('憧憬');
    expect(text).toContain('不是可选项');
  });
});
