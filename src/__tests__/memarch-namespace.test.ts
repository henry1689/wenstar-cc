/**
 * memarch-namespace.test.ts — 命名空间解析 fail-closed（MEM-UNIFY-V1 批2B）
 * ======================================================================
 * 旧行为：实体 UUID 全部解析不到 ⇒ 回落本体 ns_yuyao（新实体的召回被替换成玉瑶的记忆）。
 * 新行为：
 *   - 空列表（无活跃实体）⇒ 本体 ns_yuyao（合法语义）；
 *   - 非空列表但 registry 缺失 / 全部未命中 ⇒ null（fail-closed，调用方跳过）；
 *   - 命中即返回对应命名空间。
 */
import { describe, it, expect } from 'vitest';
import { resolveNamespaceFromMap, DEFAULT_NAMESPACE } from '../webui/memarch-runtime.js';

describe('resolveNamespaceFromMap', () => {
  const map = new Map<string, string>([['TXS-1', 'ns_a'], ['TXS-2', 'ns_b']]);

  it('空列表 → 本体命名空间', () => {
    expect(resolveNamespaceFromMap(map, [])).toBe(DEFAULT_NAMESPACE);
    expect(resolveNamespaceFromMap(map, undefined)).toBe(DEFAULT_NAMESPACE);
  });

  it('命中即返回第一个可解析的命名空间', () => {
    expect(resolveNamespaceFromMap(map, ['TXS-2', 'TXS-1'])).toBe('ns_b');
    expect(resolveNamespaceFromMap(map, ['UNKNOWN', 'TXS-1'])).toBe('ns_a');
  });

  it('非空列表全部未命中 → null（不得回落本体）', () => {
    expect(resolveNamespaceFromMap(map, ['UNKNOWN'])).toBeNull();
  });

  it('registry 未就绪 + 非空列表 → null（fail-closed）', () => {
    expect(resolveNamespaceFromMap(null, ['TXS-1'])).toBeNull();
    expect(resolveNamespaceFromMap(undefined, ['TXS-1'])).toBeNull();
  });
});
