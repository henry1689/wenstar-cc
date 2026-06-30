import { describe, it, expect } from 'vitest';

describe('[App守卫] 导出完整性', () => {
  it('createKnowledgeEngine 可导入', async () => {
    const app = await import('../index.js');
    expect(typeof app.createKnowledgeEngine).toBe('function');
  });
});
