/**
 * AutoRec 引擎单元测试
 */
import { describe, it, expect } from 'vitest';
import { AutoRecEngine } from '../engine.js';
import type { AutoRecModule, PipelineContext } from '../types.js';

class TestModule implements AutoRecModule<{ value: number }, { doubled: number }> {
  id = 'test';
  name = '测试模块';
  async execute(input: { value: number }, ctx: PipelineContext) {
    return { doubled: input.value * 2 };
  }
}

describe('AutoRecEngine', () => {
  it('注册模块和执行 Pipeline', async () => {
    const engine = new AutoRecEngine();
    engine.registerModule(new TestModule());
    engine.registerPipeline({
      id: 'test_pipeline',
      name: '测试流水线',
      modules: ['test'],
      trigger: { type: 'event', config: {} },
      errorStrategy: 'skip',
    });

    const result = await engine.run('test_pipeline');
    expect(result.status).toBe('completed');
    expect(result.modules[0].status).toBe('completed');
  });

  it('未注册的 Pipeline 应报错', async () => {
    const engine = new AutoRecEngine();
    await expect(engine.run('nonexistent')).rejects.toThrow('未注册');
  });

  it('依赖未注册模块应报错', () => {
    const engine = new AutoRecEngine();
    expect(() => engine.registerPipeline({
      id: 'bad',
      name: '有问题的流水线',
      modules: ['missing_module'],
      trigger: { type: 'event', config: {} },
      errorStrategy: 'stop',
    })).toThrow('未注册的模块');
  });
});
