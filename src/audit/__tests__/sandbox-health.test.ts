/**
 * sandbox-health.test.ts — 砂金库守护判据（L3 守护层）
 * =====================================================
 * 背景（2026-09-13 砂金库全局诊断）：
 *   砂金库的四段链路（写入/归档/摘要/召回）长期缺乏**守护** —— 缺陷可以潜伏很久
 *   而无人察觉，靠人肉发现（本次就是用户体感异常才查出来的）。实测证据：
 *     · `is_summary=1` 一条都没有，而 `【对话摘要】` 记录却有 11 条
 *     · 归档 SQL 不带摘要豁免 → 摘要被自己所属的压缩流程压掉
 *     · 摘要生成未排除已有摘要 → `【对话摘要】【历史对话】【历史对话】` 嵌套
 *
 *   这些问题**都不是新引入的**，而是静默存在了很久。L3 守护层的意义：
 *   把它们变成**可巡检、可告警**的显式状态，同类缺陷不再长期潜伏。
 *
 * 设计：阈值判断抽成**纯函数**（本文件测的就是它们），巡检项只负责取数与呈现。
 *   好处：判据集中一处、可离线测试、不依赖运行中的服务。
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateSummaryChannel,
  evaluateContextWindow,
  evaluateSummaryNesting,
} from '../checks/memory.js';

describe('砂金库守护 — 摘要通道健康判据', () => {
  it('无摘要条目 → 健康（未触发过压缩，不是缺陷）', () => {
    const r = evaluateSummaryChannel(0, 0, 0);
    expect(r.ok).toBe(true);
  });

  it('🔴 有摘要但无一条 is_summary=1 → 不健康（摘要通道失效，实测过的缺陷）', () => {
    const r = evaluateSummaryChannel(11, 0, 11);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('11');
  });

  it('🔴 摘要被归档压掉 → 不健康（归档未豁免摘要）', () => {
    const r = evaluateSummaryChannel(5, 5, 3);
    expect(r.ok).toBe(false);
  });

  it('✅ 摘要可识别且未被归档 → 健康', () => {
    const r = evaluateSummaryChannel(5, 5, 0);
    expect(r.ok).toBe(true);
  });

  it('部分可识别但无归档 → 健康（宽松：不苛求 100%）', () => {
    const r = evaluateSummaryChannel(5, 4, 0);
    expect(r.ok).toBe(true);
  });
});

describe('砂金库守护 — 上下文窗口可用性判据', () => {
  it('🔴 可注入条数低于配置窗口 → 不健康（记不住前面的事）', () => {
    const r = evaluateContextWindow(30, 80);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('30');
  });

  it('✅ 可注入条数达标 → 健康', () => {
    const r = evaluateContextWindow(168, 80);
    expect(r.ok).toBe(true);
  });

  it('恰好等于窗口 → 健康（边界）', () => {
    expect(evaluateContextWindow(80, 80).ok).toBe(true);
  });

  it('窗口配置为 0（未配置）→ 不误报', () => {
    expect(evaluateContextWindow(10, 0).ok).toBe(true);
  });
});

describe('砂金库守护 — 摘要嵌套判据', () => {
  it('✅ 无嵌套 → 健康', () => {
    expect(evaluateSummaryNesting(0).ok).toBe(true);
  });

  it('🔴 摘要对摘要再摘要 → 不健康（实测过的层层套娃）', () => {
    const r = evaluateSummaryNesting(3);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('3');
  });
});
