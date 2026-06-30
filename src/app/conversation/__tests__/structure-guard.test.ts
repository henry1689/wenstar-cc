import { describe, it, expect } from 'vitest';
describe('[app/conversation] 结构守卫', () => {
  it('decideMode 可导入', async () => {
    const m = await import('../MemoryGate.js');
    expect(typeof m.decideMode).toBe('function');
  });

  it('buildGuard 可导入', async () => {
    const m = await import('../MemoryGate.js');
    expect(typeof m.buildGuard).toBe('function');
  });

});
