import { describe, it, expect } from 'vitest';
describe('[app/yuyao-memory] 结构守卫', () => {
  it('YuyaoMemoryService 可导入', async () => {
    const m = await import('../YuyaoMemoryService.js');
    expect(typeof m.YuyaoMemoryService).toBe('function');
  });

});
