import { describe, it, expect } from 'vitest';
describe('[app/selfreview] 结构守卫', () => {
  it('MemorySelfReview 可导入', async () => {
    const m = await import('../MemorySelfReview.js');
    expect(typeof m.MemorySelfReview).toBe('function');
  });

});
