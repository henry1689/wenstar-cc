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

describe('[cli] health-check flush 检查防回归（批16）', () => {
  const fs = require('fs');
  const healthSrc = fs.readFileSync(__dirname + '/../health-check.ts', 'utf8');
  const adapterSrc = fs.readFileSync(__dirname + '/../../m2/SQLiteAdapter.ts', 'utf8');

  it('🔴 不得比对魔法数（2026-09-20 曾致配置改进后误报 fatal）', () => {
    // 原实现： sqliteContent.includes('_FLUSH_BATCH = 5') / includes('_FLUSH_INTERVAL = 2000')
    // 配置改为 50/150（改进）后检查仍断言旧值 → 误判"系统存在致命问题"
    expect(healthSrc).not.toContain("includes('_FLUSH_BATCH = 5')");
    expect(healthSrc).not.toContain("includes('_FLUSH_INTERVAL = 2000')");
  });

  it('必须用正则提取实际值', () => {
    expect(healthSrc).toContain('_FLUSH_BATCH\\s*=\\s*(\\d+)');
    expect(healthSrc).toContain('_FLUSH_INTERVAL\\s*=\\s*(\\d+)');
  });

  it('🔴 端到端有效性：正则必须能匹配当前 SQLiteAdapter 的真实配置，且值在安全区间内', () => {
    // 这条是"防回归的核心"：若哪天配置改了写法（如去掉空格、加下划线），
    // 本条会先红，而不是等到 health-check 在运维时误报。
    const m1 = adapterSrc.match(/_FLUSH_BATCH\s*=\s*(\d+)/);
    const m2 = adapterSrc.match(/_FLUSH_INTERVAL\s*=\s*(\d+)/);
    expect(m1, '必须能从 SQLiteAdapter 提取 _FLUSH_BATCH').not.toBeNull();
    expect(m2, '必须能从 SQLiteAdapter 提取 _FLUSH_INTERVAL').not.toBeNull();

    // 区间须与 health-check 内声明的安全区间一致（BATCH 1~500 / INTERVAL 50~2000）
    const batch = Number(m1![1]);
    const interval = Number(m2![1]);
    expect(batch, 'batch 下限').toBeGreaterThanOrEqual(1);
    expect(batch, 'batch 上限').toBeLessThanOrEqual(500);
    expect(interval, 'interval 下限(过密拖慢写入)').toBeGreaterThanOrEqual(50);
    // 2026-09-20 校准：上限 2000 → 60000，与 health-check 的 INTERVAL_MAX 保持一致。
    // 依据见 health-check 内注释：落盘层窗口须 ≤ 上层 M9 缓冲窗口（60s），且放大窗口是用户批准的
    // “降写放大”取舍（实测 19→6 次重写/轮、807ms→99ms）。
    expect(interval, 'interval 上限(崩溃丢失窗口)').toBeLessThanOrEqual(60000);
  });

  it('安全区间常量必须在 health-check 中声明（防静默移除）', () => {
    expect(healthSrc).toContain('BATCH_MIN');
    expect(healthSrc).toContain('INTERVAL_MAX');
  });
});
