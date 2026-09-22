/**
 * 摘要通道守卫（2026-09-22，A+C）
 *
 * 背景（实测）：`is_compacted=1` 的对话占 **97%**（4593/4742），而【对话摘要】内容行只有 **14 条**、
 * 其中 `is_summary=1` 仅 **11 条**，且 `src/webui/`+`src/m4/`+`src/m5/` 里**没有任何读取方**
 * ⇒ 被压实的前文既不在历史、也没进上下文 ⇒ **语义跳跃**。
 *
 * 本文件盯住两条**硬约束**（源码级能力断言，防回归）：
 * 1. **摘要通道必须有读取方**：`ConversationDB.getRecentConversations` 必须显式取 `is_summary=1` 的行
 *    并前置返回（原先"写了没人读"）；
 * 2. **摘要取数不得引入测试/角色扮演污染**：该查询必须带 namespace/is_test 过滤。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'ConversationDB.ts'), 'utf-8');

describe('摘要通道守卫（防“写了没人读”）', () => {
  it('历史加载必须显式读取 is_summary=1 的摘要行（原先无任何读取方）', () => {
    expect(SRC, 'getRecentConversations 必须包含摘要取数分支').toContain('COALESCE(is_summary, 0) = 1');
  });

  it('摘要取数必须排除测试行（namespace=test / is_test=1）', () => {
    const idx = SRC.indexOf('COALESCE(is_summary, 0) = 1');
    const seg = SRC.slice(idx, idx + 320);
    expect(seg, '摘要查询需过滤 test 命名空间').toContain("COALESCE(namespace,'default') <> 'test'");
    expect(seg, '摘要查询需过滤 is_test').toContain('COALESCE(is_test, 0) = 0');
  });

  it('摘要必须前置（作为“更早背景”），不得插到最近轮次之后', () => {
    expect(SRC, '摘要应以时间升序前置拼接到历史').toContain('sums.reverse(), ...recent');
  });

  it('摘要通道异常不得阻塞历史（有兜底 return）', () => {
    const idx = SRC.indexOf('COALESCE(is_summary, 0) = 1');
    const seg = SRC.slice(idx, idx + 520);
    expect(seg, '摘要取数需 try/catch 兜底').toContain('catch');
    expect(seg, '兜底时仍返回最近轮次').toContain('return recent;');
  });
});
