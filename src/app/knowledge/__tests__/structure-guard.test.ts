import { describe, it, expect } from 'vitest';
describe('[app/knowledge] 结构守卫', () => {
  it('KnowledgeMonitor 可导入', async () => {
    const m = await import('../KnowledgeMonitor.js');
    expect(typeof m.KnowledgeMonitor).toBe('function');
  });

  it('createLocalEmbedding 可导入', async () => {
    const m = await import('../EmbeddingProvider.js');
    expect(typeof m.createLocalEmbedding).toBe('function');
  });

  it('getEmbeddingStats 可导入', async () => {
    const m = await import('../EmbeddingProvider.js');
    expect(typeof m.getEmbeddingStats).toBe('function');
  });

  it('syncFamilyGraphToKnowledgeBase 可导入', async () => {
    const m = await import('../FamilyGraphSync.js');
    expect(typeof m.syncFamilyGraphToKnowledgeBase).toBe('function');
  });

});
