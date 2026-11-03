import { describe, it, expect } from 'vitest';
import { _privacyPatterns } from '../KnowledgeEngine.js';

/**
 * P135 · 隐私守卫「梓铭简介」解除拉黑 — 回归锁定
 * ============================================================
 * 业主裁决 A（2026-10-30）：源稿系业主 2026-06-28 亲自导入，历史批次误伤拉黑，解除。
 * 本测试锁两件事（防误伤面扩大、防词条被回填）：
 *   ① 「梓铭简介」（标题/内容两种形态）不再命中守卫
 *   ② 同正则其余黑名单词条**全部仍命中**（守卫能力不降级）
 *
 * 断言对象是 KnowledgeEngine 导出的真实正则常量（非复制），改源即改测。
 */

describe('P135 · 「梓铭简介」解除拉黑（业主裁决A）', () => {
  it('标题形态「梓铭简介：」不再命中', () => {
    expect(_privacyPatterns.test('梓铭简介：')).toBe(false);
  });
  it('内容形态（正文含“梓铭简介”）不再命中', () => {
    expect(_privacyPatterns.test('这是梓铭简介的正文开头')).toBe(false);
  });
});

describe('P135 · 守卫能力不降级（其余词条全部仍拦，防误伤面扩大）', () => {
  const stillBlocked: Array<[string, string]> = [
    // P137 移除原「徐诗雨身高」拦截项（实体档案类同批误伤，业主指令解除，下方放行断言锁定）
    ['我的名字是', '我的名字是鸿艺'],
    ['我的女友', '我的女友是玉瑶'],
    ['我的工作', '我的工作在高峰电业'],
    ['我在深圳市', '我在深圳市南山区'],
    ['我家里面', '我家里面三个人'],
    ['用户地址：', '用户地址：某某路1号'],
    ['用户偏好：', '用户偏好：喜欢咖啡'],
    ['习惯：', '习惯：早睡早起'],
    ['研究：', '研究：记忆体系'],
  ];
  for (const [label, sample] of stillBlocked) {
    it(`仍拦截：${label}`, () => {
      expect(_privacyPatterns.test(sample)).toBe(true);
    });
  }
  it('未被误放开：任意非词条文本仍不误拦（守卫只拦白名单词）', () => {
    expect(_privacyPatterns.test('【FG档案范式】熊梓铭的普通描述文本')).toBe(false);
  });
});

describe('P137 · 「徐诗雨身高」解除拉黑（业主指令，实体档案类同批误伤）', () => {
  it('「徐诗雨身高160」不再命中（原拦截项反转）', () => {
    expect(_privacyPatterns.test('徐诗雨身高160')).toBe(false);
  });
  it('个人隐私模板词条仍全部拦截（双向锁定：解除不影响个人防线）', () => {
    expect(_privacyPatterns.test('我的名字是鸿艺')).toBe(true);
    expect(_privacyPatterns.test('我在深圳市南山区')).toBe(true);
    expect(_privacyPatterns.test('用户地址：某某路1号')).toBe(true);
  });
});
