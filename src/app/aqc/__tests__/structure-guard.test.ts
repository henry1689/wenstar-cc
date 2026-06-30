import { describe, it, expect } from 'vitest';
describe('[app/aqc] 结构守卫', () => {
  it('runSandQC 可导入', async () => {
    const m = await import('../AQCEngine.js');
    expect(typeof m.runSandQC).toBe('function');
  });

  it('runGoldQC 可导入', async () => {
    const m = await import('../AQCEngine.js');
    expect(typeof m.runGoldQC).toBe('function');
  });

  it('getAQCReport 可导入', async () => {
    const m = await import('../AQCEngine.js');
    expect(typeof m.getAQCReport).toBe('function');
  });

});
