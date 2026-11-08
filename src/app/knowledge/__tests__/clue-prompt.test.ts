/**
 * V12.3 线索助理注入文案 — 纯函数单测
 * 覆盖：
 *   appendCluePrompt   — 模糊回忆 → LLM 自然追问提示（替换旧模板短句拦截）
 *   appendClueRecall   — 高置信线索命中 → 注入真实检索记忆
 * 断言要点：
 *   - 返回文案含提示头，不含任何模板短句（是不是…那家 / 是不是…那次）
 *   - 空 / 已有 knowledgeBaseText 两种情况拼接正确
 *   - 禁止编造铁律在文案中显式存在
 */
import { describe, it, expect } from 'vitest';
import { appendCluePrompt, appendClueRecall } from '../KnowledgeContextBuilder.js';

describe('appendCluePrompt（模糊回忆 → LLM 自然追问）', () => {
  it('空 knowledgeBaseText：返回完整提示文案', () => {
    const r = appendCluePrompt('');
    expect(r).toContain('【线索提示】');
    expect(r).toContain('鸿艺似乎在回忆某件具体的事');
    expect(r).toContain('帮他起头');
    expect(r).toContain('不要替他补出具体的时间、地点、人物');
  });

  it('已有 knowledgeBaseText：提示追加在末尾，原文保留', () => {
    const base = '【知识库】这是一段已有知识。';
    const r = appendCluePrompt(base);
    expect(r.startsWith(base)).toBe(true);
    expect(r).toContain('\n\n【线索提示】');
    expect(r.indexOf(base)).toBeLessThan(r.indexOf('【线索提示】'));
  });

  it('不含任何模板短句（不顶掉 LLM 叙事）', () => {
    const r = appendCluePrompt('');
    // 旧 M5ClueAssistant FEATURE_OPTIONS 模板短句绝不允许出现在提示里
    expect(r).not.toMatch(/是不是.*那家/);
    expect(r).not.toMatch(/是不是.*那次/);
    expect(r).not.toMatch(/是不是.*晚上/);
    expect(r).not.toMatch(/有猫/);
  });
});

describe('appendClueRecall（高置信线索命中 → 注入真实记忆）', () => {
  it('空 knowledgeBaseText + 多条命中：返回线索回忆参考', () => {
    const hits = ['去年十月加班的那个晚上', '在办公室等你加班'];
    const r = appendClueRecall('', hits);
    expect(r).toContain('【线索回忆参考】');
    expect(r).toContain('去年十月加班的那个晚上');
    expect(r).toContain('在办公室等你加班');
    expect(r).toContain('别用"不记得"挡回去');
  });

  it('已有 knowledgeBaseText：回忆参考追加在末尾', () => {
    const base = '【知识库】已有内容。';
    const r = appendClueRecall(base, ['片段A']);
    expect(r.startsWith(base)).toBe(true);
    expect(r).toContain('\n\n【线索回忆参考】');
    expect(r).toContain('片段A');
  });

  it('命中记忆按换行分隔，且含三档锚点提示', () => {
    const r = appendClueRecall('', ['片段A', '片段B']);
    expect(r).toContain('片段A\n片段B');
    expect(r).toContain('相关就自然提起、顺着说');
  });

  it('空命中列表：返回空文案头部（无崩溃）', () => {
    const r = appendClueRecall('', []);
    expect(r).toContain('【线索回忆参考】');
    expect(r).toContain('以下片段有关');
  });
});
