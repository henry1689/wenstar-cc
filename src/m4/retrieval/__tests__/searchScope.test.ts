/**
 * searchScope.test.ts — Foundation V2.0 UUID 搜索范围硬边界集成测试
 * =====================================================================
 * 验证：
 *   1. strict 模式（会晤）：仅返回当前 UUID 的记忆，拒绝其他实体
 *   2. allow-unowned 模式（户主）：UUID 范围内 + 无归属记录
 *   3. full 模式（离线巡检）：全库搜索
 *   4. 性能：strict 模式使用索引，旧模式 MULTI-INDEX OR
 */

import { describe, it, expect } from 'vitest';
import { buildSqlClause } from '../../../governance/police/UUIDPoliceFilter.js';
import { buildPolicePolicy } from '../adapter.js';

describe('Foundation V2.0: searchScope 硬边界', () => {
  it('strict 模式：仅 UUID IN，无 OR IS NULL', () => {
    const { clause, params } = buildSqlClause({
      visibleUuids: new Set(['TXS-000000007']),
      searchScope: 'strict',
    });
    expect(clause).toBe(' AND belong_entity_uuid IN (?)');
    expect(params).toEqual(['TXS-000000007']);
    expect(clause).not.toContain('IS NULL');
    expect(clause).not.toContain("= ''");
  });

  it('allow-unowned 模式：UUID IN + OR IS NULL + OR =空串', () => {
    const { clause } = buildSqlClause({
      visibleUuids: new Set(['TXS-000000007']),
      searchScope: 'allow-unowned',
    });
    expect(clause).toContain('belong_entity_uuid IN (?)');
    expect(clause).toContain('IS NULL');
    expect(clause).toContain("= ''");
  });

  it('full 模式：空子句，全库搜索', () => {
    const { clause, params } = buildSqlClause({
      visibleUuids: new Set(['TXS-000000007']),
      searchScope: 'full',
    });
    expect(clause).toBe('');
    expect(params).toEqual([]);
  });

  it('默认行为：未指定 searchScope 时降级为 strict', () => {
    const { clause } = buildSqlClause({
      visibleUuids: new Set(['TXS-000000007']),
    });
    expect(clause).toBe(' AND belong_entity_uuid IN (?)');
    expect(clause).not.toContain('IS NULL');
  });

  it('空白名单 + strict → AND 1=0（fail-closed）', () => {
    const { clause } = buildSqlClause({
      visibleUuids: new Set(),
      searchScope: 'strict',
    });
    expect(clause).toBe(' AND 1=0');
  });

  it('空白名单 + allow-unowned → AND 1=0（fail-closed）', () => {
    const { clause } = buildSqlClause({
      visibleUuids: new Set(),
      searchScope: 'allow-unowned',
    });
    expect(clause).toBe(' AND 1=0');
  });

  it('多 UUID 时正确使用多个占位符', () => {
    const { clause, params } = buildSqlClause({
      visibleUuids: new Set(['TXS-000000007', 'TXS-000000001']),
      searchScope: 'strict',
    });
    expect(clause).toBe(' AND belong_entity_uuid IN (?,?)');
    expect(params).toHaveLength(2);
    expect(params).toContain('TXS-000000007');
    expect(params).toContain('TXS-000000001');
  });

  it('buildPolicePolicy 传播 searchScope（会晤 → strict）', () => {
    const policy = buildPolicePolicy({
      activeEntityUuids: ['TXS-000000007'],
      meetingMode: true,
    });
    expect(policy.searchScope).toBe('strict');
    expect(policy.allowUnowned).toBe(false);
  });

  it('buildPolicePolicy 传播 searchScope（户主 → allow-unowned）', () => {
    const policy = buildPolicePolicy({
      activeEntityUuids: ['TXS-000000007'],
      householdUuids: ['TXS-000000001'],
      meetingMode: false,
    });
    expect(policy.searchScope).toBe('allow-unowned');
    expect(policy.allowUnowned).toBe(true);
  });

  it('buildPolicePolicy 传播 searchScope（无白名单 → full）', () => {
    const policy = buildPolicePolicy({
      meetingMode: false,
    });
    expect(policy.searchScope).toBe('full');
    expect(policy.enforce).toBe(false);
  });
});
