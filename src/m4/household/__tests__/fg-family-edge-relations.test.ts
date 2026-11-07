// FG 家族边关系集合的回归测试
// ============================================================
// 背景（2026-11-07）：完整性守护检查 ⑩ 曾硬编码 12 种直系/同辈关系，
//   漏掉 uncle_of / aunt_of / cousin_of / nibling_of / nephew_of / niece_of，
//   导致「熊梓铭 --uncle_of--> 我」被误判为缺少家族边，系统启动即降级运行。
// 修复：检查改用 RelationshipTypes 的 FAMILY + KINSHIP 全集（唯一真源）。
// 本测试锁住该契约：关系词典必须覆盖叔侄/堂表亲，且必须包含原硬编码的 12 种，
// 防止有人再次把子集收窄回去。
import { describe, it, expect } from 'vitest';
import { RELATION_CATEGORY, getRelationsByCategory } from '../../../app/fg/RelationshipTypes.js';

/** 修复后守护使用的关系全集（与 FamilyGraph 中的 FAMILY_EDGE_RELATIONS 同源同算法） */
function familyEdgeRelations(): string[] {
  return [
    ...getRelationsByCategory(RELATION_CATEGORY.FAMILY),
    ...getRelationsByCategory(RELATION_CATEGORY.KINSHIP),
  ];
}

describe('FG 家族边关系集合', () => {
  it('必须包含叔侄/堂表亲关系（修复前缺失的 6 种）', () => {
    const rels = familyEdgeRelations();
    for (const r of ['uncle_of', 'aunt_of', 'cousin_of', 'nibling_of', 'nephew_of', 'niece_of']) {
      expect(rels, `缺少关系 ${r}`).toContain(r);
    }
  });

  it('必须包含原硬编码的 12 种直系/同辈关系（不得回退）', () => {
    const rels = familyEdgeRelations();
    const legacyTwelve = [
      'mother_of', 'father_of', 'spouse_of', 'sibling_of', 'child_of', 'parent_of',
      'grandparent_of', 'grandchild_of', 'elder_sister_of', 'younger_sister_of',
      'elder_brother_of', 'younger_brother_of',
    ];
    for (const r of legacyTwelve) {
      expect(rels, `缺少关系 ${r}`).toContain(r);
    }
  });

  it('关系集合非空且无重复', () => {
    const rels = familyEdgeRelations();
    expect(rels.length).toBeGreaterThan(12);
    expect(new Set(rels).size).toBe(rels.length);
  });

  it('不把职场/社交关系误算为家族边', () => {
    const rels = familyEdgeRelations();
    for (const r of ['colleague_of', 'classmate_of', 'acquaintance_of', 'boss_of']) {
      expect(rels, `不应包含 ${r}`).not.toContain(r);
    }
  });
});
