import { describe, it, expect } from 'vitest';
describe('[app/persona] 结构守卫', () => {
  it('PersonaRegistry 可导入', async () => {
    const m = await import('../PersonaRegistry.js');
    expect(typeof m.PersonaRegistry).toBe('object');
  });

});
