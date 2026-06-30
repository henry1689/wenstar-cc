import { describe, it, expect } from 'vitest';
describe('[app/ingestion] 结构守卫', () => {
  it('extractCandidates 可导入', async () => {
    const m = await import('../ConversationIngestionService.js');
    expect(typeof m.extractCandidates).toBe('function');
  });

  it('ingestFromConversation 可导入', async () => {
    const m = await import('../ConversationIngestionService.js');
    expect(typeof m.ingestFromConversation).toBe('function');
  });

});
