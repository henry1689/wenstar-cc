/**
 * AutoRec 模块集成测试
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { AutoRecEngine } from '../engine.js';
import { CleanModule } from '../modules/clean.js';
import type { PipelineContext } from '../types.js';

describe('AutoRec 模块集成', () => {
  const engine = new AutoRecEngine();
  const ctx: PipelineContext = {
    traceId: 'test',
    startTime: new Date().toISOString(),
    shared: {},
  };

  it('Clean 模块 — 短文本', async () => {
    const clean = new CleanModule();
    const result = await clean.execute({ rawInput: '在干嘛', sourceType: 'chat' }, ctx);
    expect(result.cleanedText).toBe('在干嘛');
    expect(result.isCasual).toBe(true);
    expect(result.mode).toBe('casual');
  });

  it('Clean 模块 — 知识查询', async () => {
    const clean = new CleanModule();
    const result = await clean.execute({ rawInput: '查一下红楼梦', sourceType: 'chat' }, ctx);
    expect(result.mode).toBe('knowledge_query');
  });

  it('Engine + Clean 串联', async () => {
    engine.registerModule(new CleanModule());
    engine.registerPipeline({
      id: 'ingestion_test',
      name: '素材入库测试',
      modules: ['clean'],
      trigger: { type: 'event', config: {} },
      errorStrategy: 'skip',
    });

    const run = await engine.run('ingestion_test');
    expect(run.status).toBe('completed');
  });
});
