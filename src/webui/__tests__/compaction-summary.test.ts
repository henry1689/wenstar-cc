/**
 * B（2026-09-22）能力断言：对话压缩的**摘要规范化与提示词构造**
 *
 * 背景：原 `compressTurnsSmart` **不是 LLM 摘要**而是机械截断（`(已存金库) + 前 40 字` /
 * `【历史对话】 + 前 80 字`），注释虽写"LLM可用时使用LLM"但该分支从未实现 ⇒ "摘要"实为残片
 * （样本含测试串、原始片段）⇒ 即便摘要通道打通（A/C），连贯性收益仍受限。
 *
 * 本文件证明两个纯函数的能力（LLM 调用与注入本身由 server.ts 负责，端到端另见提交说明）：
 * 1. `normalizeCompactionSummary`：去换行、**去嵌套前缀**、限长、空值返回空串（触发回退）；
 * 2. `buildCompactionPrompt`：标注说话人、超长**保留尾部**、明确要求"第三人称 + 禁止编造"。
 */
import { describe, it, expect } from 'vitest';

import { normalizeCompactionSummary, buildCompactionPrompt } from '../maintenance.js';

describe('摘要规范化（normalizeCompactionSummary）', () => {
  it('去换行与多余空白（摘要必须是单段）', () => {
    expect(normalizeCompactionSummary('今天  去了\n海边\n她很高兴')).toBe('今天 去了 海边 她很高兴');
  });

  it('去掉嵌套前缀，防止「【对话摘要】【历史对话】…」反复嵌套', () => {
    expect(normalizeCompactionSummary('【对话摘要】她今天很开心')).toBe('她今天很开心');
    expect(normalizeCompactionSummary('【历史对话】一起去看了海')).toBe('一起去看了海');
  });

  it('限长并加省略号', () => {
    const long = '甲'.repeat(50);
    const out = normalizeCompactionSummary(long, 20);
    expect(out.length).toBe(21);
    expect(out.endsWith('…')).toBe(true);
  });

  it('空/纯空白 ⇒ 返回空串（调用方据此回退机械压缩）', () => {
    expect(normalizeCompactionSummary('')).toBe('');
    expect(normalizeCompactionSummary('   \n\t ')).toBe('');
    expect(normalizeCompactionSummary(undefined as any)).toBe('');
  });
});

describe('摘要提示词（buildCompactionPrompt）', () => {
  const turns = [
    { role: 'user', content: '明天一起去看海' },
    { role: 'assistant', content: '好呀，我记着了' },
  ];

  it('标注说话人（鸿艺 / 她），便于第三人称摘要', () => {
    const p = buildCompactionPrompt(turns);
    expect(p).toContain('鸿艺: 明天一起去看海');
    expect(p).toContain('她: 好呀，我记着了');
  });

  it('明确要求第三人称、保留未竟约定、禁止编造', () => {
    const p = buildCompactionPrompt(turns);
    expect(p).toContain('第三人称');
    expect(p).toContain('承诺与未完成的约定');
    expect(p).toContain('禁止推测或编造');
  });

  it('超长时保留**尾部**（最近的对话对连贯性更重要）', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ role: 'user', content: `第${i}句` }));
    const p = buildCompactionPrompt(many, 200);
    expect(p, '应保留最后一句').toContain('第399句');
    expect(p, '应丢弃最早的内容').not.toContain('第0句');
  });
});
