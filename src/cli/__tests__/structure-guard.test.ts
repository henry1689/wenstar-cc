import { describe, it, expect } from 'vitest';
describe('[cli] 文件存在', () => {
  it('health-check.ts 存在', () => {
    const fs = require('fs');
    expect(fs.existsSync(__dirname + '/../health-check.ts')).toBe(true);
  });
  it('sandbox.ts 存在', () => {
    const fs = require('fs');
    expect(fs.existsSync(__dirname + '/../sandbox.ts')).toBe(true);
  });
});

describe('[cli] health-check 存储底座检查防回归（2026-11-06 迁移后）', () => {
  const fs = require('fs');
  const healthSrc = fs.readFileSync(__dirname + '/../health-check.ts', 'utf8');
  const adapterSrc = fs.readFileSync(__dirname + '/../../m2/SQLiteAdapter.ts', 'utf8');

  /** 剥掉行注释/块注释后再断言，避免迁移说明注释自命中 */
  const codeOnly = (src: string): string =>
    src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('🔴 health-check 不得再用 _FLUSH_* 作为持久化判据（机制已删除）', () => {
    expect(healthSrc).not.toContain('_FLUSH_BATCH\\s*=\\s*(\\d+)');
    expect(healthSrc).not.toContain('BATCH_MIN');
    expect(healthSrc).not.toContain('INTERVAL_MAX');
  });

  it('🔴 health-check 必须有「旧链路残留」守卫（initSqlJs / export() / _FLUSH_*）', () => {
    expect(healthSrc).toContain('legacyExport');
    expect(healthSrc).toMatch(/initSqlJs/);
    expect(healthSrc).toContain('存储底座');
  });

  it('🔴 端到端有效性：当前 SQLiteAdapter 必须真正通过该守卫（剥注释后无残留）', () => {
    // 这条是防回归核心：若有人把整库导出/防抖落盘加回 SQLiteAdapter，
    // 本用例会先红，而不是等到运维巡检时才发现召回腿又被拖垮。
    const code = codeOnly(adapterSrc);
    expect(code).not.toMatch(/initSqlJs/);
    expect(code).not.toMatch(/\.export\(\)/);
    expect(code).not.toMatch(/_FLUSH_BATCH|_FLUSH_INTERVAL/);
    // 且必须经兼容层接入原生驱动
    expect(adapterSrc).toMatch(/from\s*['"]\.\/SqlJsCompat\.js['"]/);
  });
});
