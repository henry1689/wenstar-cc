import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * MemSym-v1.0.0 批β 回归守卫（宪法断言式，制度级）
 * ==================================================
 * 依据：ADR-MEM-002 第四条法理 + 宪法信条7（双模式义务，8b410d7 颁布）。
 * 判据要求（经验21）：能力断言（三档协议必须在场），非计数/位置断言；
 * 允许重构（措辞可微调，核心标记必须保留）。
 */
describe('MemSym-v1.0.0 批β · 三档协议制度断言', () => {
  const root = resolve(__dirname, '../../../..');
  const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');

  it('会晤人格铁律（core-rules）引用 MEMORY-LAW-V1 单一法源（业主2026-11-08 批1 收口）', () => {
    const law = read('src/m5/prompts/memory-expression-law.ts');
    // 能力断言：三档协议的核心元素在场（法源为唯一文案源）
    expect(law).toContain('【记得】');
    expect(law).toContain('【印象】');
    expect(law).toContain('【线索】');
    expect(law).toContain('这叫回忆，不叫编造');
    expect(law).toContain('三重奏');
    // core-rules 只引用法源，不再内联第二套三档文案
    const src = read('src/m5/prompts/core-rules.ts');
    expect(src).toContain('MEMORY_LAW_CORE');
    // 旧二元律（不确定=直接说不太记得）必须已被替换（导致拒绝对话的根源）
    expect(src).not.toContain('直接说"不太记得了/没印象"');
  });

  it('S2-J1b 回忆三档正向化（retrieval-stage，业主2026-11-01法理升级）', () => {
    const src = read('src/webui/chat/retrieval-stage.ts');
    expect(src).toContain('回忆表达三档');
    expect(src).toContain('这叫回忆，不叫编造');
    // 旧绝对律文本已被替换
    expect(src).not.toContain('编造是系统级错误');
  });

  it('长文原文注入对齐三档（long-text-retrieval 记得档）', () => {
    const src = read('src/webui/chat/long-text-retrieval.ts');
    expect(src).toContain('【记得】档');
    // 原编造禁令的实质保留（不得新增提及）
    expect(src).toContain('表达自由');
  });

  it('ADR-MEM-002 法条本体含双模式义务（法理源头不空转）', () => {
    const adr = read('docs/adr/ADR-MEM-002-20261026-MemSym双通路记忆共生协议.md');
    expect(adr).toContain('主动运用义务');
    expect(adr).toContain('深度应答义务');
    expect(adr).toContain('敷衍回避');
  });
});
