/**
 * 任务 4 能力断言：知识「重复即更新」的**合并策略**（追加不覆盖）
 *
 * 产品语义（用户 2026-09-20 决定）：知识重复提交不再直接拒给（409），而是更新既有条目；
 * 合并策略必须**不丢旧内容**（旧条目独有信息不能被"准重复"覆盖掉）。
 *
 * 要证明的能力：
 * 1. 新内容为空 ⇒ 不动旧内容；
 * 2. 旧内容已包含新内容 ⇒ 不重复追加（**幂等**：重复提交同一内容不会让条目无限变长）；
 * 3. 新旧不同 ⇒ **追加**且旧内容完整保留；
 * 4. 追加后旧内容仍在前（顺序稳定，可追溯）。
 */
import { describe, it, expect } from 'vitest';

import { mergeDuplicateContent } from '../KnowledgeEngine.js';

describe('知识重复合并策略（追加不覆盖）', () => {
  it('新内容为空 / 纯空白 ⇒ 旧内容不变、不追加', () => {
    expect(mergeDuplicateContent('旧内容', '').appended).toBe(false);
    expect(mergeDuplicateContent('旧内容', '   \n  ').content).toBe('旧内容');
  });

  it('旧内容已包含新内容 ⇒ 不重复追加（幂等，不会无限变长）', () => {
    const old = '知识A：完整说明。\n\n---\n\n知识A：补充一句。';
    const r1 = mergeDuplicateContent(old, '知识A：补充一句。');
    expect(r1.appended).toBe(false);
    expect(r1.content).toBe(old);

    // 连续两次合并同一新内容：第二次必须不追加（幂等）
    const first = mergeDuplicateContent('旧', '新');
    expect(first.appended).toBe(true);
    const second = mergeDuplicateContent(first.content, '新');
    expect(second.appended, '重复提交同一内容不得无限追加').toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('新旧不同 ⇒ 追加；且旧内容完整保留、顺序为旧在前', () => {
    const r = mergeDuplicateContent('旧内容（不可丢）', '新内容（补记）');
    expect(r.appended).toBe(true);
    expect(r.content, '旧内容必须完整保留').toContain('旧内容（不可丢）');
    expect(r.content).toContain('新内容（补记）');
    expect(r.content.indexOf('旧内容（不可丢）')).toBeLessThan(r.content.indexOf('新内容（补记）'));
  });

  it('旧内容为空 ⇒ 直接取新内容（不产生多余分隔线）', () => {
    const r = mergeDuplicateContent('', '新内容');
    expect(r.appended).toBe(true);
    expect(r.content).toBe('新内容');
    expect(r.content.startsWith('---')).toBe(false);
  });

  it('非字符串入参不抛错（鲁棒：NULL / undefined 安全）', () => {
    expect(() => mergeDuplicateContent(undefined as any, undefined as any)).not.toThrow();
    expect(mergeDuplicateContent(undefined as any, 'x').content).toBe('x');
    expect(mergeDuplicateContent('x', null as any).content).toBe('x');
  });
});
