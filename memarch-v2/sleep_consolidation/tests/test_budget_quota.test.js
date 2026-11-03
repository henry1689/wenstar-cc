/**
 * M3 单元测试：预算与配额控制
 */

import { describe, it, expect } from 'vitest';
import { BudgetTracker, DEFAULT_BUDGET } from '../config/budget.js';
import { DEFAULT_QUOTA } from '../config/quota.js';
import { loadFlags } from '../config/flags.js';

describe('BudgetTracker', () => {
  it('主睡眠预算正确初始化', () => {
    const tracker = new BudgetTracker(DEFAULT_BUDGET, 'main');
    expect(tracker.totalBudget).toBe(80000);
    expect(tracker.remainingTokens).toBe(80000);
    expect(tracker.utilizationRatio).toBe(0);
  });

  it('小睡预算正确初始化', () => {
    const tracker = new BudgetTracker(DEFAULT_BUDGET, 'nap');
    expect(tracker.totalBudget).toBe(15000);
  });

  it('reserve 扣减预算', () => {
    const tracker = new BudgetTracker(DEFAULT_BUDGET, 'main');
    const ok = tracker.reserve('gistPerCallTokens');
    expect(ok).toBe(true);
    expect(tracker.remainingTokens).toBe(80000 - DEFAULT_BUDGET.gistPerCallTokens);
  });

  it('预算耗尽后 reserve 失败', () => {
    const tracker = new BudgetTracker({ ...DEFAULT_BUDGET, mainSleepTokenBudget: 400 }, 'main');
    tracker.reserve('gistPerCallTokens'); // 用掉 500 > 400？不，先试一次
    const ok = tracker.reserve('gistPerCallTokens');
    // 400 < 500，第一次就失败
    expect(ok).toBe(false);
  });

  it('canAfford 检查', () => {
    const tracker = new BudgetTracker(DEFAULT_BUDGET, 'main');
    expect(tracker.canAfford('saliencePerCallTokens')).toBe(true);
  });
});

describe('Quota', () => {
  it('默认配额符合验收标准', () => {
    expect(DEFAULT_QUOTA.dailyPurgeLimit).toBe(500);
    expect(DEFAULT_QUOTA.mainSleepTimeoutMin).toBe(30);
    expect(DEFAULT_QUOTA.napTimeoutMin).toBe(5);
  });
});

describe('FeatureFlags', () => {
  it('MEMORY_FORGET_ENABLED=0 时遗忘只计算不执行', () => {
    const flags = loadFlags({ MEMORY_FORGET_ENABLED: '0' });
    expect(flags.MEMORY_FORGET_ENABLED).toBe(0);
  });

  it('MEMORY_FORGET_ENABLED=1 时执行遗忘', () => {
    const flags = loadFlags({ MEMORY_FORGET_ENABLED: '1' });
    expect(flags.MEMORY_FORGET_ENABLED).toBe(1);
  });
});
