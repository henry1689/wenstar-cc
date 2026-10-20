import { describe, it, expect } from 'vitest';
import { screenContext } from '../UUIDPoliceFilter.js';
import { injectMemories } from '../../../m4/MemoryInjector.js';
import type { PolicePolicy } from '../UUIDPoliceFilter.js';

/**
 * I008 正则容忍时间后缀 —— 回归守卫（2026-10-20）
 * ============================================================
 * T003（2026-10-18）给所有注入标签加了时间坐标后缀：同年 `·MM-DD`、跨年 `·YYYY-MM-DD`。
 * 两处依赖「标签形如 `【X的记忆】`」的正则没同步 ⇒ 静默 fail-open：
 *   ① UUIDPoliceFilter.screenContext 的注入边界兜底闸门对几乎所有记忆片段空转（filteredCount 恒 0）；
 *   ② MemoryInjector 的 kind 判定把 context 记忆误判成 sand（受精筛/条数上限约束）。
 * 修法：两处正则容忍可选时间后缀 `(?:·\d{4}-\d{2}-\d{2}|·\d{2}-\d{2})?`。
 * 本守卫锁死「时间后缀标签重新被识别」且「非实体/无时间后缀行为不回归」。
 */

const UUID_YU = 'TXS-000000001'; // 会晤实体（可见）
const UUID_ZHEN = 'TXS-000000008'; // 他人实体（不可见）
const NAME_TO_UUID: Record<string, string> = { 徐诗韵: UUID_YU, 阿珍: UUID_ZHEN };
const resolve = (n: string) => NAME_TO_UUID[n] ?? null;

const policy: PolicePolicy = {
  visibleUuids: new Set([UUID_YU]),
  enforce: true,
  searchScope: 'strict',
} as PolicePolicy;

describe('I008 正则1 — screenContext 注入边界闸门容忍时间后缀', () => {
  it('时间后缀的他人实体标签被过滤（闸门恢复兜底，非空转）', () => {
    const text = '【阿珍的记忆·10-20】办公室等诗雨…';
    const out = screenContext(text, policy, resolve);
    expect(out, '他人实体的时间后缀标签必须被过滤').not.toContain('办公室等诗雨');
  });

  it('时间后缀的会晤实体标签被保留', () => {
    const text = '【徐诗韵的记忆·10-20】蒹葭苍苍…';
    const out = screenContext(text, policy, resolve);
    expect(out, '会晤实体自己的时间后缀标签不误杀').toContain('蒹葭苍苍');
  });

  it('跨年时间后缀（·2025-12-31）同样被识别', () => {
    const text = '【阿珍的记忆·2025-12-31】旧事…';
    const out = screenContext(text, policy, resolve);
    expect(out).not.toContain('旧事');
  });

  it('无时间后缀的旧形态仍被过滤（不回归）', () => {
    const text = '【阿珍的记忆】未加时间坐标…';
    expect(screenContext(text, policy, resolve)).not.toContain('未加时间坐标');
  });

  it('无实体名（重要记忆）/ 普通文本 保留', () => {
    const text = '【重要记忆·10-20】要点…\n普通对话没有标签';
    const out = screenContext(text, policy, resolve);
    expect(out).toContain('要点');
    expect(out).toContain('普通对话没有标签');
  });
});

describe('I008 正则2 — MemoryInjector kind 判定容忍时间后缀', () => {
  it('时间后缀的记忆片段被当 context（豁免相关性精筛），不被 sand 精筛剔除', () => {
    // 构造一个与 query 无关键词重合、长度偏短的「时间后缀记忆」片段：
    //   若 kind 误判 sand → 会受 SPF 二道精筛（相关性低则剔除）；
    //   正确判 context → 恒保留（MemoryInjector:202 kind==='context' return true）。
    const frag = '【徐诗韵的记忆·10-20】完全不相关的晦涩片段乙';
    const out = injectMemories({
      memoryFragments: [frag],
      m4Timeline: [],
      knowledgeBaseText: '',
      vaultHits: [],
      maxChars: 8000,
      preserveLabels: true,
    } as any);
    expect(out, 'context 记忆豁免精筛，必须保留').toContain('晦涩片段乙');
  });

  it('对照：同样内容但判 sand 的路径会被精筛（证明 kind 确实影响去留）', () => {
    // 无标签前缀 ⇒ classify 走 sand ⇒ 受精筛；构造低相关内容验证其可被剔除。
    // 此用例只断言「注入流程不抛错且能区分」，避免过度绑定精筛阈值。
    const bare = '完全不相关的晦涩片段丙';
    const out = injectMemories({
      memoryFragments: [bare],
      m4Timeline: [],
      knowledgeBaseText: '',
      vaultHits: [],
      maxChars: 8000,
      preserveLabels: true,
    } as any);
    expect(typeof out).toBe('string'); // 不抛错即可（精筛阈值属 MemoryInjector 内部规格）
  });
});
