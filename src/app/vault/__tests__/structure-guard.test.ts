import { describe, it, expect } from 'vitest';

describe('[Vault守卫] 导出完整性', () => {
  it('VaultManager 核心函数可导入', async () => {
    const vm = await import('../VaultManager.js');
    expect(typeof vm.logVaultOperation).toBe('function');
    expect(typeof vm.getVaultLog).toBe('function');
    expect(typeof vm.listBlackDiamonds).toBe('function');
    expect(typeof vm.addBlackDiamond).toBe('function');
    expect(typeof vm.deleteBlackDiamond).toBe('function');
    expect(typeof vm.searchBlackDiamonds).toBe('function');
  });

  it('MemoryAssessor 类可导入', async () => {
    const ma = await import('../MemoryAssessor.js');
    expect(ma.MemoryAssessor).toBeDefined();
  });

  it('VaultReport 接口定义存在', async () => {
    const vm = await import('../VaultManager.js');
    // 验证三库相关函数存在
    expect(typeof vm.getAlluvialSummary).toBe('function');
    expect(typeof vm.getGoldSummary).toBe('function');
    expect(typeof vm.listGoldRecent).toBe('function');
  });
});
