import { describe, it, expect } from 'vitest';
describe('[app/profile] 结构守卫', () => {
  it('MasterProfileService 可导入', async () => {
    const m = await import('../MasterProfileService.js');
    expect(typeof m.MasterProfileService).toBe('function');
  });

});
