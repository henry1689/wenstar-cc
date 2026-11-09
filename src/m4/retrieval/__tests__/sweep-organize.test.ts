import { describe, it, expect } from 'vitest';
import {
  sweepAllStores, organizeForQuestion, cleanSweepKeywords, CRYSTAL_DIRECTIVE, SWEEP_POLICY,
} from '../meeting-recall.js';

/**
 * P093 编排器+整编层回归（结晶核心令执行层）
 * 收集最大化不变量 + 问题中心整编 + 噪声治理 + 结晶注入单源。
 *
 * MEM-UNIFY-V1 批4：收集扩容到 黑钻(active)/共享知识/对话原文；取消 12 条与 110 字硬顶，
 *   改字符预算装包；vault_log 不再作为记忆源（D3 审计台账）。
 */
function mockSrc(rows: {
  memories?: unknown[]; diamond?: unknown[]; kb?: unknown[]; kbShared?: unknown[]; conv?: unknown[]; vault?: unknown[];
}) {
  return {
    queryAll: (sql: string) => {
      if (sql.includes('FROM memories')) return (rows.memories || []) as never;
      if (sql.includes('FROM black_diamond')) return (rows.diamond || []) as never;
      if (sql.includes('FROM knowledge_base')) {
        return (sql.includes('belong_entity_uuid IS NULL') ? rows.kbShared : rows.kb) as never || [];
      }
      if (sql.includes('FROM conversations')) return (rows.conv || []) as never;
      if (sql.includes('FROM vault_log')) return (rows.vault || []) as never;
      return [];
    },
  };
}

describe('P093 统一多仓收集编排器', () => {
  it('多仓全收 + 来源标注 + 去重（收集最大化）', () => {
    const frags = sweepAllStores(mockSrc({
      memories: [{ raw_input: '第一次亲热那天很紧张手都不知道往哪放' }],
      diamond: [{ summary: '亲密时光黑钻记录：那天的温存细节' }],
      kb: [{ content: '偏好档案：偏爱安静贴近的相处' }],
    }) as never, 'TXS-1', ['亲热', '那天']);
    expect(frags.length).toBe(3);
    expect(frags.map((f) => f.source)).toEqual(expect.arrayContaining(['砂金', '金库黑钻', '知识库']));
  });

  it('批4 扩容：黑钻 active + 共享知识（D5）+ 对话原文，vault_log 不再收集（D3）', () => {
    const frags = sweepAllStores(mockSrc({
      diamond: [{ summary: '黑钻里的往事：那次旅行很开心', created_at: '2026-01-01' }],
      kbShared: [{ content: '共享知识：这条对所有实体都可见', created_at: '2026-02-01' }],
      conv: [{ content: '我们上次聊到旅行的时候很开心', created_at: '2026-03-01' }],
      vault: [{ content_md: '这是审计台账里的一段旧内容不应进入记忆' }],
    }) as never, 'TXS-1', ['旅行']);
    const sources = frags.map((f) => f.source);
    expect(sources).toContain('金库黑钻');
    expect(sources).toContain('知识库');
    expect(sources).toContain('对话原文');
    expect(sources).not.toContain('砂金');
    expect(frags.some(f => f.content.includes('审计台账'))).toBe(false);
  });

  it('批4：超过原 12 条硬顶不再被截断（按字符预算装包）', () => {
    const memories = Array.from({ length: 20 }, (_, i) => ({
      raw_input: `第${i + 1}条与旅行有关的回忆细节内容`,
      created_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    }));
    const frags = sweepAllStores(mockSrc({ memories }) as never, 'TXS-1', ['旅行'], {
      memoriesPerKw: 20,
      maxChars: 100000,
      safetyMaxFrags: 48,
    });
    expect(frags.length).toBe(20);
    expect(organizeForQuestion(frags, ['旅行'], { maxChars: 100000 }).length).toBe(20);
  });

  it('批4：单条字符上限默认 400（原 110 字硬顶取消）', () => {
    const long = '旅'.repeat(600);
    const frags = sweepAllStores(mockSrc({ memories: [{ raw_input: long }] }) as never, 'TXS-1', ['旅行']);
    expect(frags[0].content.length).toBe(SWEEP_POLICY.perFragmentChars);
  });

  it('批4：整编按字符预算装包（预算小则少收）', () => {
    const frags = Array.from({ length: 10 }, (_, i) => ({
      source: '砂金' as const,
      content: `旅行回忆第${i}条：` + '内容'.repeat(30),
    }));
    const small = organizeForQuestion(frags, ['旅行'], { maxChars: 400 });
    expect(small.length).toBeLessThan(frags.length);
    expect(small.length).toBeGreaterThan(0);
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
    // 🔴 2026-11-03（S4 B类）：返回类型由 string[] 改为结构化对象（line/source/content/createdAt），
    //   `line` 保留〔source〕content 可溯源前缀 —— 断言强度不变（仍校验前缀与内容命中）。
    expect(lines[0].line).toContain('〔砂金〕');
    expect(lines[0].line.includes('亲热')).toBe(true);
    expect(lines[0].source).toBe('砂金');
  });

  /**
   * 🔴 2026-11-03（S4 独立评审 P1-B 类的回归防线）
   * ============================================================
   * 事故形态：sweepAllStores 三条 SQL 只 SELECT 文本 ⇒ 最大的记忆聚合通道
   * 注入时不带时间坐标，而数据层 created_at 100% 在库 —— 是**通道选择不取**，不是数据没有。
   * S8 立法意图为「记忆类注入必须携带时间坐标」。
   */
  it('🔴 碎片必须透传 createdAt（sweepAllStores 取出 → organizeForQuestion 透传）', () => {
    const ISO = '2026-10-15T03:21:00.000Z';
    const withTime = sweepAllStores(mockSrc({
      memories: [{ raw_input: '第一次亲热那天很紧张手都不知道往哪放', created_at: ISO }],
    }) as never, 'TXS-1', ['亲热']);
    expect(withTime.length, 'mock 应命中至少 1 条').toBeGreaterThan(0);
    expect(withTime[0].createdAt, 'sweepAllStores 必须把 created_at 从 SQL 带出来').toBe(ISO);

    const organized = organizeForQuestion(withTime, ['亲热']);
    expect(organized[0].createdAt, 'organizeForQuestion 必须透传 createdAt（供 memFragWithTime 格式化）').toBe(ISO);
    expect(organized[0].source).toBe('砂金');

    // fail-open：无时间戳的行不阻塞注入（createdAt 缺省 ⇒ memFragWithTime 回退无时间标签）
    const noTime = sweepAllStores(mockSrc({
      memories: [{ raw_input: '没有时间戳的一段回忆内容仍然要能注入' }],
    }) as never, 'TXS-1', ['回忆']);
    expect(noTime.length).toBeGreaterThan(0);
    expect(noTime[0].createdAt).toBeUndefined();
  });

  it('结晶注入单源含三重奏+憧憬自由+表达优先（宪法信条0 执行文本）', () => {
    expect(CRYSTAL_DIRECTIVE).toContain('三重奏');
    expect(CRYSTAL_DIRECTIVE).toContain('不受事实边界约束');
    expect(CRYSTAL_DIRECTIVE).toContain('宁可带标记地满');
    expect(CRYSTAL_DIRECTIVE).toContain('显式标记即合法');
    expect(CRYSTAL_DIRECTIVE).toContain('滋味档');
    expect(CRYSTAL_DIRECTIVE).toContain('感受与氛围的语汇');
    expect(SWEEP_POLICY.maxChars).toBeGreaterThan(0);
    expect(SWEEP_POLICY.safetyMaxFrags).toBeGreaterThan(12);
  });
});
