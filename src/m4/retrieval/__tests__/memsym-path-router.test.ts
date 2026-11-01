import { describe, it, expect } from 'vitest';
import { classifyMemSymPath, B_BOOST_CONFIG } from '../memsym-path-router.js';
import { incMemSym, trackElementUse, elementReuseEntropy } from '../memsym-metrics.js';

/**
 * MemSym 批δ · 主旨判定器边界回归（memsym-boundary-cases-v1.json 映射）
 * ======================================================================
 * 歧义样例（B-AMBIG-*）严禁误降级进 A——业主加固条款②：误降级会到处乱加
 * "印象里、不太确定"，氛围感破碎。判定保守方向偏向 A（隐患六）。
 */
describe('MemSym 批δ · 主旨判定器', () => {
  it('B 合法样例（纯当下）→ B', () => {
    expect(classifyMemSymPath('我安安静静陪着你，不急的。')).toBe('B');
    expect(classifyMemSymPath('我想好好贴近你，慢慢和你说话。')).toBe('B');
  });

  it('歧义保护样例（B-AMBIG-01..07，带过往关键词但主旨是当下）→ 全部 B，严禁误降级', () => {
    const ambiguous = [
      '就像我们之前那种温柔的感觉，我们慢慢来。',
      '像以前那样，你靠着我就好。',
      '还记得那种安安静静的味道吗——现在就是。',
      '我们老样子，轻轻的，不着急。',
      '之前舒服的那种节奏，今天也给你。',
      '你上次说想放松，那我们今天就慢慢聊。',
      '以前怎么哄你的，现在也一样。',
    ];
    for (const m of ambiguous) {
      expect(classifyMemSymPath(m), `歧义样例被误降级: ${m}`).toBe('B');
    }
  });

  it('往事陈述样例 → A（三档协议全套）', () => {
    expect(classifyMemSymPath('记得之前我们安安静静慢慢贴近的时候，特别舒服。')).toBe('A');
    expect(classifyMemSymPath('上次我们在天台聊了很久。')).toBe('A');
    expect(classifyMemSymPath('还记得我们之前一起做饭那次吗？给我讲讲好不好，我想听。')).toBe('A');
    expect(classifyMemSymPath('印象里那天晚上我们在天台靠着吹风，聊了很久。')).toBe('A');
  });

  it('B 路钙化增强：低系数+冷却（默契生长但不压倒主动回忆，防僵化）', () => {
    expect(B_BOOST_CONFIG.coefficient).toBeLessThan(0.2); // < A 路召回 boost
    expect(B_BOOST_CONFIG.cooldownHours).toBeGreaterThanOrEqual(1);
  });

  it('五指标计数与复用熵（回音室观测原料）', () => {
    incMemSym('pathA'); incMemSym('pathB'); incMemSym('elementPicked', 2);
    trackElementUse('偏爱安静氛围感');
    trackElementUse('偏爱安静氛围感');
    trackElementUse('喜欢慢慢说话');
    expect(elementReuseEntropy()).toBeGreaterThan(0); // 分布不均时熵有限、可监测
  });
});
