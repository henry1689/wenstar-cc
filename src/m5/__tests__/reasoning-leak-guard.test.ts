import { describe, it, expect } from 'vitest';
import { resolveReplyFromFields } from '../DeepSeekLLMProvider.js';

// M-LEAK 思维链泄漏护栏行为回归测试（2026-09-12）
// 现象：会晤回复把 LLM 思维链整段当回复输出（英文分析 + 中文草稿 + 指令复述）。
// 链路：会晤走 roleplay 配置(reasoning_effort='max' + max_tokens=3000) → 思维链吃光额度
//   → content 为空 → 代码回退取 reasoning_content 整段 → 剥离器(全中文措辞枚举)不命中
//   → 保底返回原文 → 整段泄漏。
// 修复：字段边界优先 —— content 有值即用 content；content 为空时 reasoning 仅作最后手段，
//   且必须剥出真实答案，剥离失败（≈原文）则判「无可用答案」返回空，绝不把思维链当前台回复。
// 样例脱敏，不涉及任何亲密/未成年内容。

describe('[m5] M-LEAK 回复字段择取护栏（content 优先，思维链绝不回退为原文）', () => {
  it('content 有值 → 直接用 content（即使 reasoning 是一大段思维链）', () => {
    const content = '嗯，天亮了。你醒啦？昨晚睡得好吗？';
    const reasoning = 'Let me parse the current situation. It is 03:48 AM. I should respond gently. '
      + 'Draft: 嗯，天亮了呀。Count: ~30 chars. 这大概合适。';
    expect(resolveReplyFromFields(content, reasoning)).toBe(content);
  });

  it('content 空 + reasoning 为英文分析型思维链（无可剥离答案）→ 返回空（现逻辑回退原文 → 红）', () => {
    // 与线上泄漏同形态：英文规划/评估 + 中文草稿复述 + 指令残留，无中文过渡标记/答案起点
    const reasoning = [
      'Let me parse the current situation.',
      'Current time: 2026/9/12 06:28:57 (Beijing time). The speaker target: 徐诗雨.',
      'So 鸿艺 is saying the dawn has come. I should respond as 徐诗雨 — gentle, attentive.',
      'Draft: （我望向窗外）嗯，天亮了。你这一宿没怎么合眼吧？',
      'Count: ~50 chars. Hmm, maybe soften the ending.',
      '对徐诗雨说点什么…',
    ].join('\n');
    // 护栏：剥离不出真实答案 → 返回空，绝不把思维链原文当回复
    expect(resolveReplyFromFields('', reasoning)).toBe('');
  });

  it('content 空 + reasoning 含可剥离的中文最终稿 → 返回剥离后的答案', () => {
    const reasoning = '让我来写回应：（她笑了笑）嗯，天亮了，你醒啦？我陪着你呢。';
    const out = resolveReplyFromFields('', reasoning);
    expect(out).toContain('天亮了');
    expect(out.startsWith('让我来写')).toBe(false);
  });

  it('content 与 reasoning 都为空 → 返回空（不抛、不返回原文）', () => {
    expect(resolveReplyFromFields('', '')).toBe('');
    expect(resolveReplyFromFields(undefined, undefined)).toBe('');
  });
});
