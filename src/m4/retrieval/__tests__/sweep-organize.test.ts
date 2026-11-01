import { describe, it, expect } from 'vitest';
import { sweepAllStores, organizeForQuestion, cleanSweepKeywords, CRYSTAL_DIRECTIVE, SWEEP_POLICY } from '../meeting-recall.js';

/**
 * P093 编排器+整编层回归（结晶核心令执行层）
 * 收集最大化不变量 + 问题中心整编 + 噪声治理 + 结晶注入单源。
 */
function mockSrc(rows: { memories?: unknown[]; vault?: unknown[]; kb?: unknown[] }) {
  return {
    queryAll: (sql: string) => {
      if (sql.includes('FROM memories')) return (rows.memories || []) as never;
      if (sql.includes('FROM vault_log')) return (rows.vault || []) as never;
      if (sql.includes('FROM knowledge_base')) return (rows.kb || []) as never;
      return [];
    },
  };
}

describe('P093 统一多仓收集编排器', () => {
  it('三仓全收 + 来源标注 + 去重（收集最大化）', () => {
    const frags = sweepAllStores(mockSrc({
      memories: [{ raw_input: '第一次亲热那天很紧张手都不知道往哪放' }],
      vault: [{ content_md: '亲密时光金库记录：那天的温存细节' }],
      kb: [{ content: '偏好档案：偏爱安静贴近的相处' }],
    }) as never, 'TXS-1', ['亲热', '那天']);
    expect(frags.length).toBe(3);
    expect(frags.map((f) => f.source)).toEqual(expect.arrayContaining(['砂金', '金库黑钻', '知识库']));
  });

  it('噪声词治理："还记/是就"类功能词不得进入主题扫（含"还记得"闭合）', () => {
    const cleaned = cleanSweepKeywords(['还记', '是就', '还记得', '记得吗', '诗雨', '亲热']);
    expect(cleaned).toEqual(['诗雨', '亲热']);
  });

  it('问题中心整编：命中密度高的片段排前 + 来源标注格式', () => {
    const lines = organizeForQuestion([
      { source: '知识库', content: '与话题无关的别的内容而已' },
      { source: '砂金', content: '亲热那天很紧张，亲热的细节记得不多' },
    ], ['亲热']);
    expect(lines[0]).toContain('〔砂金〕');
    expect(lines[0].includes('亲热')).toBe(true);
  });

  it('结晶注入单源含三重奏+憧憬自由+表达优先（宪法信条0 执行文本）', () => {
    expect(CRYSTAL_DIRECTIVE).toContain('三重奏');
    expect(CRYSTAL_DIRECTIVE).toContain('不受事实边界约束');
    expect(CRYSTAL_DIRECTIVE).toContain('宁可带标记地满');
    expect(CRYSTAL_DIRECTIVE).toContain('显式标记即合法');
    expect(CRYSTAL_DIRECTIVE).toContain('滋味档');
    expect(CRYSTAL_DIRECTIVE).toContain('感受与氛围的语汇');
    expect(SWEEP_POLICY.maxFrags).toBeGreaterThan(0);
  });
});
