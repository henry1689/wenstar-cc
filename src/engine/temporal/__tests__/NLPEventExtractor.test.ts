/**
 * NLPEventExtractor.test.ts — 生理周期(phys_cycle)事件单位与单一源回归测试
 *
 * 结构根因:周期天数 30 曾三处硬编码(TemporalConfig 单一源未被引用 / baseDays / cycleMs 字面量),
 * 且 cycleMs 多乘 1000(30 天被记成 ≈82 年)。
 * 结构修复:phys_cycle 引 EVENT_COMMON_SENSE.menstruationCycleDays 单一源;cycleMs 从 baseDays 派生。
 * 语义:durationMs/cycleMs 对 phys_cycle = 周期间隔(下次到临),与 TemporalEventArchive 合规(≥20 天)自洽。
 */
import { describe, it, expect } from 'vitest';
import { NLPEventExtractor } from '../NLPEventExtractor.js';
import { EVENT_COMMON_SENSE } from '../TemporalConfig.js';

describe('NLPEventExtractor 生理周期事件', () => {
  it('无显式时长例假:cycleMs = 单一源 30 天(毫秒),endTs = now + 30 天', () => {
    const before = Date.now();
    const ev = NLPEventExtractor.extract('来例假了');
    const after = Date.now();
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('temporal_event');
    expect(ev!.params.eventType).toBe('phys_cycle');
    // 单一源:与 EVENT_COMMON_SENSE 定义一致(不再硬编码字面量)
    expect(ev!.params.cycleMs).toBe(EVENT_COMMON_SENSE.menstruationCycleDays * 86400000);
    expect(ev!.params.cycleMs).toBe(30 * 86400000); // 2.592e9,非旧值 2.592e12
    // endTs = 下次到临(周期间隔),落在合理窗口
    expect(ev!.params.endTs).toBeGreaterThanOrEqual(before + 30 * 86400000 - 1);
    expect(ev!.params.endTs).toBeLessThanOrEqual(after + 30 * 86400000 + 1);
  });

  it('带显式时长例假:cycleMs 仍 = 30 天周期(不被显式时长覆盖),endTs = now + 显式时长', () => {
    const before = Date.now();
    const ev = NLPEventExtractor.extract('例假5天');
    const after = Date.now();
    expect(ev).not.toBeNull();
    expect(ev!.params.eventType).toBe('phys_cycle');
    // S4 修正:显式时长不影响周期——cycleMs 必须独立派生,恒 30 天(旧实现此处也是 82 年 bug)
    expect(ev!.params.cycleMs).toBe(30 * 86400000);
    // endTs 用显式时长 5 天
    expect(ev!.params.durationMs).toBe(5 * 86400000);
    expect(ev!.params.endTs).toBeGreaterThanOrEqual(before + 5 * 86400000 - 1);
    expect(ev!.params.endTs).toBeLessThanOrEqual(after + 5 * 86400000 + 1);
  });

  it('其他事件(感冒)cycleMs = 0,不受生理周期逻辑影响', () => {
    const ev = NLPEventExtractor.extract('感冒了');
    expect(ev).not.toBeNull();
    expect(ev!.params.eventType).toBe('感冒');
    expect(ev!.params.cycleMs).toBe(0);
  });

  it('mode_switch(豁免模式)不受影响——同文件不同分支', () => {
    const ev = NLPEventExtractor.extract('开启豁免模式');
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('mode_switch');
    expect(ev!.params.mode).toBe('roleplay_exempt');
  });
});
