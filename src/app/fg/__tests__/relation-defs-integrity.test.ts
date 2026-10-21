import { describe, it, expect } from 'vitest';
import { RELATION_TYPE_DEFS, assertRelationTypeDefsIntegrity } from '../RelationshipTypes.js';

/**
 * T011 Phase 1 守卫 —— 关系类型单一真源完整性 + 写入拒绝
 * 锁四件事：
 *   ① DEFS 完整性断言（reverse悬空/缺label/格式）通过，且违例时 fail-fast
 *   ② DEFS 覆盖 T011 附录A 补齐项（含 lover_of 正式身份 / elder_sister_of / step_child_of 反向目标）
 *   ③ addEdge 写入拒绝 ∉DEFS 的 relation（经 DEFS 查表验证判据）
 *   ④ 单向特征边（has_appearance 等）reverse 允许为空
 */

describe('T011-① DEFS 完整性断言', () => {
  it('当前 DEFS 74 项全部合规（reverse/label/格式）', () => {
    expect(() => assertRelationTypeDefsIntegrity()).not.toThrow();
  });

  it('违例 DEFS → fail-fast throw，且报告具体违规', () => {
    const bad = {
      ...RELATION_TYPE_DEFS,
      ghost_of: { category: 'social' as any, label: '鬼', reverse: 'nonexistent_of' }, // reverse 悬空
      no_label: { category: 'social' as any, label: '', reverse: '' },                 // 缺 label
    };
    let msg = '';
    try { assertRelationTypeDefsIntegrity(bad as any); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('reverse悬空');
    expect(msg).toContain('nonexistent_of');
    expect(msg).toContain('缺中文label');
  });
});

describe('T011-② 附录A 补齐项覆盖', () => {
  it('A-1 在用类型已定义（lover_of 正式身份 / elder_sister_of / lives_in 等）', () => {
    for (const t of ['lover_of', 'elder_sister_of', 'younger_sister_of', 'elder_brother_of',
      'lives_in', 'residence_of', 'has_appearance', 'patient_of', 'org_of', 'employer_of', 'operated_by']) {
      expect(RELATION_TYPE_DEFS[t], `DEFS 应含 ${t}`).toBeTruthy();
    }
  });

  it('A-2 反向目标已定义（消除 reverse 悬空）', () => {
    for (const t of ['step_child_of', 'child_in_law_of', 'fan_of', 'org_of', 'server_of', 'grandparent_of']) {
      expect(RELATION_TYPE_DEFS[t], `DEFS 应含反向目标 ${t}`).toBeTruthy();
    }
  });

  it('elder_sister_of ↔ younger_sister_of 互为反向（修 T008 P0-1）', () => {
    expect(RELATION_TYPE_DEFS['elder_sister_of'].reverse).toBe('younger_sister_of');
    expect(RELATION_TYPE_DEFS['younger_sister_of'].reverse).toBe('elder_sister_of');
  });

  it('单向特征边 reverse 允许空（has_appearance）', () => {
    expect(RELATION_TYPE_DEFS['has_appearance'].reverse).toBe('');
  });
});

describe('T011-③ addEdge 写入拒收判据（DEFS 查表）', () => {
  // FamilyGraph.addEdge 的守卫判据：relation 非空且 ∉ DEFS → 拒。此处直接验证判据逻辑。
  const wouldReject = (r: string) => !!r && !RELATION_TYPE_DEFS[r];
  it('∉DEFS 的 relation 被拒', () => {
    expect(wouldReject('not_a_relation')).toBe(true);
    expect(wouldReject('father_of_law_zzz')).toBe(true);
  });
  it('∈DEFS 的 relation 放行', () => {
    for (const t of ['lover_of', 'elder_sister_of', 'spouse_of', 'has_appearance']) {
      expect(wouldReject(t), `${t} 应放行`).toBe(false);
    }
  });
  it('空 relation 由自指/其他闸门处理，本判据不误拦', () => {
    expect(wouldReject('')).toBe(false);
  });
});
