import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FamilyGraph } from '../FamilyGraph.js';
import { parseSocialGroups, sameSocialGroup, findOutsiders } from '../SocialGroupResolver.js';

/**
 * P123 · 社团判定接口单测
 * ================================================================
 * 设计依据：P113 §2.3（六用例：同社团/跨社团/fail-closed/多值/批量/host缺失）
 * + parse 边界 + FamilyGraph 三薄委托 smoke。
 *
 * 分层：纯函数层（resolver）不依赖库，覆盖全部判定语义；
 *      委托层（FG）用临时库验证「uuid→social_group_genes 列→纯函数」的接线与 legacy 兜底。
 */

// ─── 纯函数层：P113 §2.3 六用例 ───

describe('SocialGroupResolver · parseSocialGroups（fail-closed 归一化）', () => {
  it('单值 CO01 → [CO01]', () => expect(parseSocialGroups('CO01')).toEqual(['CO01']));
  it('WW 自由人编码保留（参与判定，不特殊过滤）', () => expect(parseSocialGroups('WW')).toEqual(['WW']));
  it('规范多值 A|B → [A, B]，并 trim/去空项', () => expect(parseSocialGroups(' CO01 | WW ')).toEqual(['CO01', 'WW']));
  it('空串 → null', () => expect(parseSocialGroups('')).toBeNull());
  it('纯分隔符/空白 → null', () => expect(parseSocialGroups(' |  ')).toBeNull());
  it('null / undefined / 非字符串 → null', () => {
    expect(parseSocialGroups(null)).toBeNull();
    expect(parseSocialGroups(undefined)).toBeNull();
    expect(parseSocialGroups(123)).toBeNull();
  });
});

describe('SocialGroupResolver · sameSocialGroup（P113 用例 1-4）', () => {
  it('用例1 同社团：CO01 vs CO01 → true', () =>
    expect(sameSocialGroup(['CO01'], ['CO01'])).toBe(true));
  it('用例2 跨社团：CO01 vs WW → false', () =>
    expect(sameSocialGroup(['CO01'], ['WW'])).toBe(false));
  it('用例3 fail-closed：任一方 null → false（视为不同社团）', () => {
    expect(sameSocialGroup(null, ['CO01'])).toBe(false);
    expect(sameSocialGroup(['CO01'], null)).toBe(false);
    expect(sameSocialGroup(null, null)).toBe(false);
  });
  it('用例4 多值交集：[CO01, WW] vs [CO01] → true', () =>
    expect(sameSocialGroup(['CO01', 'WW'], ['CO01'])).toBe(true));
  it('多值无交集：[CO01, SC01] vs [WW] → false', () =>
    expect(sameSocialGroup(['CO01', 'SC01'], ['WW'])).toBe(false));
});

describe('SocialGroupResolver · findOutsiders（P113 用例 5-6）', () => {
  const A = { uuid: 'TXS-A', groups: ['CO01'] as string[] | null };
  const B = { uuid: 'TXS-B', groups: ['CO01'] as string[] | null };
  const C = { uuid: 'TXS-C', groups: ['WW'] as string[] | null };

  it('用例5 批量：3 人中 1 人跨社团 → 返回该 1 人', () =>
    expect(findOutsiders([A, B, C], ['CO01'])).toEqual(['TXS-C']));

  it('用例6 host 编码缺失 → 全员视为 outsiders', () =>
    expect(findOutsiders([A, B, C], null)).toEqual(['TXS-A', 'TXS-B', 'TXS-C']));

  it('成员编码缺失（无法判定）→ 入名单', () => {
    const X = { uuid: 'TXS-X', groups: null as string[] | null };
    expect(findOutsiders([A, X], ['CO01'])).toEqual(['TXS-X']);
  });

  it('全员同社团 → 空名单', () =>
    expect(findOutsiders([A, B], ['CO01'])).toEqual([]));

  it('返回顺序保持入参顺序', () =>
    expect(findOutsiders([C, A], ['CO01'])).toEqual(['TXS-C']));

  it('host 自身在参会列表且 host 缺码 → 含 host（与 P113 用例字面一致）', () => {
    const H = { uuid: 'TXS-H', groups: null as string[] | null };
    expect(findOutsiders([H, A], null)).toEqual(['TXS-H', 'TXS-A']);
  });
});

// ─── 委托层：FamilyGraph 三方法接线 smoke（临时库） ───

const DB = join('D:/tmp', `__p123_socialgroup_test_${process.pid}.db`);

async function freshFg(): Promise<any> {
  try { if (existsSync(DB)) rmSync(DB); } catch { /* 清理失败不阻塞 */ }
  const fg: any = new FamilyGraph(DB);
  await fg.initialize();
  return fg;
}

function seed(fg: any, id: string, name: string, uuid: string, genes: string | null): void {
  fg.run(
    `INSERT INTO nodes (id, type, name, aliases, properties, created_at, updated_at, uuid, social_group_genes)
     VALUES (?,?,?,'[]',?,?,?,?,?)`,
    [id, 'person', name, JSON.stringify({ name }), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', uuid, genes],
  );
}

describe('FamilyGraph · 社团判定三薄委托（P113 §2.3 契约）', () => {
  let fg: any;
  beforeEach(async () => { fg = await freshFg(); });
  afterEach(() => {
    try { fg?.close?.(); } catch { /* 忽略 */ }
    try { if (existsSync(DB)) rmSync(DB); } catch { /* 忽略 */ }
  });

  it('getSocialGroups：uuid 命中 → 编码列表；CO01 实体与 WW 实体', () => {
    seed(fg, 'n1', '甲', 'TXS-T-001', 'CO01');
    seed(fg, 'n2', '乙', 'TXS-T-002', 'WW');
    expect(fg.getSocialGroups('TXS-T-001')).toEqual(['CO01']);
    expect(fg.getSocialGroups('TXS-T-002')).toEqual(['WW']);
  });

  it('getSocialGroups：uuid 不存在 → null（fail-closed）', () => {
    expect(fg.getSocialGroups('TXS-NOPE')).toBeNull();
  });

  it('getSocialGroups：编码列缺失/空 → null', () => {
    seed(fg, 'n3', '丙', 'TXS-T-003', null);
    expect(fg.getSocialGroups('TXS-T-003')).toBeNull();
  });

  it('isSameSocialGroup：同社团 true / 跨社团 false / 无法判定 false', () => {
    seed(fg, 'n1', '甲', 'TXS-T-001', 'CO01');
    seed(fg, 'n2', '乙', 'TXS-T-002', 'CO01');
    seed(fg, 'n4', '丁', 'TXS-T-004', 'WW');
    seed(fg, 'n5', '戊', 'TXS-T-005', 'CO01|SC01');
    expect(fg.isSameSocialGroup('TXS-T-001', 'TXS-T-002')).toBe(true);   // 同社团
    expect(fg.isSameSocialGroup('TXS-T-001', 'TXS-T-004')).toBe(false);  // 跨社团
    expect(fg.isSameSocialGroup('TXS-T-001', 'TXS-NOPE')).toBe(false);   // 一方无法判定
    expect(fg.isSameSocialGroup('TXS-T-001', 'TXS-T-005')).toBe(true);   // 多值交集
  });

  it('getOutsiders：host 同组外 1 人；host 缺码 → 全员', () => {
    seed(fg, 'n1', '甲', 'TXS-T-001', 'CO01');
    seed(fg, 'n2', '乙', 'TXS-T-002', 'CO01');
    seed(fg, 'n4', '丁', 'TXS-T-004', 'WW');
    const all = ['TXS-T-001', 'TXS-T-002', 'TXS-T-004'];
    expect(fg.getOutsiders(all, 'TXS-T-001')).toEqual(['TXS-T-004']);
    expect(fg.getOutsiders(all, 'TXS-NOPE')).toEqual(all); // host 缺码 → 全员
  });
});
