/**
 * EntityNameCodec 单测（C2/C3，2026-09-11）
 * =========================================
 * 这是「实体名」解析的**唯一事实源**，此前 5+ 处各自实现（含 4 次静默降级事故）。
 * 本测试做两件事：
 *   1. 逐路覆盖兼容格式（逗号 / JSON 字符串数组 / JSON 对象数组 / 已是数组 / 非法输入）
 *   2. **等价性回归**：把迁移前的两个历史实现原文内联于此，对夹具矩阵逐例比对，
 *      证明收口是「忠实超集」而非行为变更（这是本次重构最关键的证据）
 */
import { describe, it, expect } from 'vitest';
import {
  parseEntries,
  parseNames,
  formatNames,
  hasNames,
  ENTITY_NAME_COLUMNS,
} from '../EntityNameCodec.js';

// ─────────────────────────────────────────────────────────────
// 迁移前的历史实现（原文，仅用于等价性比对）
//   A. SleepTimeConsolidator.parseEntityNames（被删）
//   B. MemoryAssessor.parseConversationEntities 的「取人名」部分
// ─────────────────────────────────────────────────────────────
function legacyParseEntityNames(raw: unknown): string[] {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
    } catch { /* 非 JSON 则按逗号切 */ }
  }
  return s.split(',').map((x: string) => x.trim()).filter(Boolean);
}

function legacyParseConversationEntityNames(raw: unknown): string[] {
  const out: string[] = [];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') { if (item.trim()) out.push(item.trim()); }
          else if (item && typeof item === 'object' && typeof item.name === 'string') {
            if (item.name.trim()) out.push(item.name.trim());
          }
        }
        return out;
      }
    } catch { /* fallback to csv */ }
    return raw.split(',').map((n) => n.trim()).filter(Boolean);
  }
  return out;
}

// 夹具矩阵：覆盖真实数据形态 + 历史边界
const FIXTURES: unknown[] = [
  null, undefined, '', '   ',
  '徐诗韵', '徐诗韵,熊梓铭', ' 徐诗韵 , 熊梓铭 ', '徐诗韵,,熊梓铭', ',',
  '["徐诗韵"]', '["徐诗韵","熊梓铭"]', '[]', '[" 徐诗韵 "]',
  '[{"name":"徐诗韵","type":"person"}]',
  '[{"name":"徐诗韵"},{"name":"熊梓铭"}]',
  '[{"name":""}]', '[{}]',
  '["徐诗韵",{"name":"熊梓铭"}]',
  '[not valid json', '{broken',
  [], ['徐诗韵', '熊梓铭'], ['徐诗韵', '', '熊梓铭'],
  123, {}, true,
];

describe('[C2] EntityNameCodec 兼容格式覆盖', () => {
  it('parseNames: 空/非字符串输入一律返回 [] 且不抛错', () => {
    for (const bad of [null, undefined, '', '   ', 123, {}, true, [], NaN, 0]) {
      expect(() => parseNames(bad)).not.toThrow();
      expect(parseNames(bad)).toEqual([]);
    }
  });

  it('parseNames: 非法 JSON（以 [ 开头但解析失败）沿历史语义落到逗号分支', () => {
    // 与迁移前的 SleepTimeConsolidator.parseEntityNames 完全一致：不抛错，按逗号切
    expect(() => parseNames('[bad')).not.toThrow();
    expect(parseNames('[bad')).toEqual(['[bad']);
  });

  it('parseNames: 逗号分隔（conversations 与 memories 的实际写入格式）', () => {
    expect(parseNames('徐诗韵,熊梓铭')).toEqual(['徐诗韵', '熊梓铭']);
    expect(parseNames(' 徐诗韵 , 熊梓铭 ')).toEqual(['徐诗韵', '熊梓铭']);
    expect(parseNames('徐诗韵,,熊梓铭')).toEqual(['徐诗韵', '熊梓铭']);
  });

  it('parseNames: JSON 字符串数组（历史格式）', () => {
    expect(parseNames('["徐诗韵","熊梓铭"]')).toEqual(['徐诗韵', '熊梓铭']);
  });

  it('parseNames: JSON 对象数组（entity_genes 形状也安全）', () => {
    expect(parseNames('[{"name":"徐诗韵","type":"person"}]')).toEqual(['徐诗韵']);
    expect(parseNames('[{"name":"徐诗韵"},{"name":"熊梓铭"}]')).toEqual(['徐诗韵', '熊梓铭']);
  });

  it('parseNames: 已是数组的入参（避免调用方重复解析出错）', () => {
    expect(parseNames(['徐诗韵', '熊梓铭'])).toEqual(['徐诗韵', '熊梓铭']);
    expect(parseNames(['徐诗韵', '', '熊梓铭'])).toEqual(['徐诗韵', '熊梓铭']);
  });

  it('formatNames: 逗号分隔、空数组为 ""、去空去重前后空白', () => {
    expect(formatNames(['徐诗韵', '熊梓铭'])).toBe('徐诗韵,熊梓铭');
    expect(formatNames([' 徐诗韵 ', ''])).toBe('徐诗韵');
    expect(formatNames([])).toBe('');
    expect(formatNames(null)).toBe('');
    expect(formatNames(undefined)).toBe('');
  });

  it('parseEntries: 结构化条目保留（不丢 type/allele）', () => {
    const e = parseEntries('[{"name":"徐诗韵","type":"person","allele":"韵"}]');
    expect(e).toHaveLength(1);
    expect((e[0] as Record<string, unknown>).type).toBe('person');
    expect((e[0] as Record<string, unknown>).allele).toBe('韵');
  });

  it('round-trip: formatNames(parseNames(x)) 稳定（幂等）', () => {
    for (const fx of ['徐诗韵,熊梓铭', '["徐诗韵","熊梓铭"]']) {
      const once = formatNames(parseNames(fx));
      expect(formatNames(parseNames(once))).toBe(once);
    }
  });

  it('hasNames 与 parseNames 一致', () => {
    expect(hasNames('徐诗韵')).toBe(true);
    expect(hasNames('')).toBe(false);
    expect(hasNames('[]')).toBe(false);
  });

  it('列名常量是唯一事实源（防手写列名漂移）', () => {
    expect(ENTITY_NAME_COLUMNS.conversations).toBe('entity_names');
    expect(ENTITY_NAME_COLUMNS.memories).toBe('fg_entity_names');
  });
});

describe('[C3] 与迁移前历史实现的等价性（忠实超集，非行为变更）', () => {
  /**
   * λ 有意偏离清单（仅非字符串入参）—— 必须在测试里显式登记，不假装没变。
   * 理由：legacy 对任意入参做 `String(raw)`，会把 `{}` 变成 `'[object Object]'`
   * （垃圾入垃圾出）；codec 对非字符串一律返回 []。
   * 实际数据来源是 DB 列（string | null），永远不会是对象/数字 → 对真实路径零影响。
   */
  const INTENTIONAL_DEVIATIONS = new Set(['number', 'object', 'boolean']);

  it('parseNames 对 A 实现（SleepTimeConsolidator）的全部夹具一致（仅非字符串入参有意偏离）', () => {
    const diffs: string[] = [];
    for (const fx of FIXTURES) {
      const codec = parseNames(fx);
      const legacy = legacyParseEntityNames(fx).map((s) => String(s).trim()).filter(Boolean);
      // 允许的偏离 ①：非字符串入参（刻意改进，见上）
      if (fx !== null && fx !== undefined && typeof fx !== 'string' && !Array.isArray(fx)
          && INTENTIONAL_DEVIATIONS.has(typeof fx) && codec.length === 0) {
        continue;
      }
      // 允许的偏离 ②：对象数组（legacy 会产出 "[object Object]"，codec 取 .name —— 严格更优）
      const entries = parseEntries(fx);
      const hasObject = Array.isArray(entries) && entries.some((e) => typeof e !== 'string');
      if (!hasObject && JSON.stringify(codec) !== JSON.stringify(legacy)) {
        diffs.push(`fixture=${JSON.stringify(fx)} codec=${JSON.stringify(codec)} legacy=${JSON.stringify(legacy)}`);
      }
    }
    expect(diffs, diffs.join('\n')).toEqual([]);
  });

  it('parseNames 对 B 实现（MemoryAssessor 取人名）的全部夹具一致', () => {
    const diffs: string[] = [];
    for (const fx of FIXTURES) {
      if (Array.isArray(fx)) continue; // B 实现不支持数组入参（codec 是超集）
      const codec = parseNames(fx);
      const legacy = legacyParseConversationEntityNames(fx);
      if (JSON.stringify(codec) !== JSON.stringify(legacy)) {
        diffs.push(`fixture=${JSON.stringify(fx)} codec=${JSON.stringify(codec)} legacy=${JSON.stringify(legacy)}`);
      }
    }
    expect(diffs, diffs.join('\n')).toEqual([]);
  });
});
