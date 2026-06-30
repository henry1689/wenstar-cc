import { describe, it, expect } from 'vitest';
describe('[app/task-agent] 结构守卫', () => {
  it('TaskAgentEngine 可导入', async () => {
    const m = await import('../index.js');
    expect(typeof m.TaskAgentEngine).toBe('function');
  });

  it('plan 可导入', async () => {
    const m = await import('../TaskPlanner.js');
    expect(typeof m.plan).toBe('function');
  });

  it('ToolRegistry 可导入', async () => {
    const m = await import('../ToolRegistry.js');
    expect(typeof m.ToolRegistry).toBe('object');
  });

});
