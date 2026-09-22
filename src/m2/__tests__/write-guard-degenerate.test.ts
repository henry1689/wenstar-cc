/**
 * 退化内容守卫的能力断言（写入端防垃圾）
 *
 * 背景（实测）：金库/黑钻里混进测试垃圾（`AAAAA…`、纯表情等），而 roleplay 记忆**豁免五要素守护**
 * ⇒ 垃圾可以绕过守卫直接进金库。本守卫在五要素判定**之前**拦退化内容。
 *
 * 要证明的能力：
 * 1. 空白 / 过短 / 单字符重复 / 纯表情标点 ⇒ 拦截（true）；
 * 2. **真实聊天不得误伤**（"你好呀"、"今天有点累"、"test" 等一律放行）；
 * 3. roleplay 豁免**不能**绕过本守卫（这是本次修的漏洞）。
 */
import { describe, it, expect } from 'vitest';

import { isDegenerateContent, checkWriteGuard } from '../MemoryWriteGateway.js';

describe('退化内容判定（纯函数）', () => {
  it('空白 / 过短 ⇒ 退化', () => {
    expect(isDegenerateContent('')).toBe(true);
    expect(isDegenerateContent('   \n\t ')).toBe(true);
    expect(isDegenerateContent('a')).toBe(true);
    expect(isDegenerateContent(undefined as any)).toBe(true);
  });

  it('单字符重复（如 AAAAA…）⇒ 退化', () => {
    expect(isDegenerateContent('AAAAAA')).toBe(true);
    expect(isDegenerateContent('aaaaaaaaaaaa')).toBe(true);
    expect(isDegenerateContent('。。。。。。。')).toBe(true);
  });

  it('纯表情 / 纯标点 / 纯符号（不含字母数字汉字）⇒ 退化', () => {
    expect(isDegenerateContent('😊👍🎉')).toBe(true);
    expect(isDegenerateContent('！？。，')).toBe(true);
    expect(isDegenerateContent('★★★☆☆')).toBe(true);
  });

  it('边界如实记录：含数字的单字内容**不**算退化（规则如此，不偷改规则去适配脏数据）', () => {
    // `<3` 含数字 3 ⇒ 按“含字母/数字/汉字即有内容”的规则应放行。
    // 这是刻意的宽度边界：宁可漏拦几个带字符的测试串，也不误拦真实聊天。
    expect(isDegenerateContent('<3 🎉')).toBe(false);
  });

  it('真实聊天**不得误伤**（含字母/数字/汉字即放行）', () => {
    for (const s of ['你好呀', '今天有点累', 'test', '你好', 'ok', '真的吗？', '第 3 章', '我爱你']) {
      expect(isDegenerateContent(s), `不应拦截: ${s}`).toBe(false);
    }
  });
});

describe('写入守门：退化内容在五要素判定之前拦截（roleplay 也不豁免）', () => {
  it('普通记忆：退化内容 ⇒ 拒绝，理由指明"退化内容"', () => {
    const r = checkWriteGuard({ rawInput: 'AAAAAAAAAA', entityGenes: [{ name: 'x' }] });
    expect(r.allowed).toBe(false);
    expect(String(r.reason)).toContain('退化内容');
  });

  it('roleplay 记忆：退化内容**仍然**被拦（修掉"豁免绕过"漏洞）', () => {
    const r = checkWriteGuard({ rawInput: '😊👍', memoryKind: 'roleplay', entityGenes: [] });
    expect(r.allowed, 'roleplay 豁免不得放行退化内容').toBe(false);
    expect(String(r.reason)).toContain('退化内容');
  });

  it('roleplay + 正常内容 ⇒ 仍按原设计豁免五要素（放行）', () => {
    const r = checkWriteGuard({ rawInput: '诗雨在呢，你回来了', memoryKind: 'roleplay', entityGenes: [] });
    expect(r.allowed, 'roleplay 的正常内容应继续豁免五要素').toBe(true);
  });

  it('普通记忆 + 正常内容 + 有基因 ⇒ 放行；无基因 ⇒ 仍被五要素拦', () => {
    expect(checkWriteGuard({ rawInput: '今天有点累', entityGenes: [{ name: 'x' }] }).allowed).toBe(true);
    const noGene = checkWriteGuard({ rawInput: '今天有点累', entityGenes: [] });
    expect(noGene.allowed).toBe(false);
    expect(String(noGene.reason)).toContain('五要素');
  });
});
