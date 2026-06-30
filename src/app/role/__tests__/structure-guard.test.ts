import { describe, it, expect } from 'vitest';
describe('[app/role] 结构守卫', () => {
  it('classify 可导入', async () => {
    const m = await import('../RoleClassifier.js');
    expect(typeof m.classify).toBe('function');
  });

  it('validateRoleOutput 可导入', async () => {
    const m = await import('../RoleGuard.js');
    expect(typeof m.validateRoleOutput).toBe('function');
  });

  it('checkConsistency 可导入', async () => {
    const m = await import('../RoleGuard.js');
    expect(typeof m.checkConsistency).toBe('function');
  });

  it('getFallbackRole 可导入', async () => {
    const m = await import('../RoleGuard.js');
    expect(typeof m.getFallbackRole).toBe('function');
  });

  it('buildRoleSystemPrompt 可导入', async () => {
    const m = await import('../RoleProfiles.js');
    expect(typeof m.buildRoleSystemPrompt).toBe('function');
  });

  it('createInitialState 可导入', async () => {
    const m = await import('../TransitionManager.js');
    expect(typeof m.createInitialState).toBe('function');
  });

  it('evaluateTransition 可导入', async () => {
    const m = await import('../TransitionManager.js');
    expect(typeof m.evaluateTransition).toBe('function');
  });

});
