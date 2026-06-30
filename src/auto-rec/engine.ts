/**
 * AutoRec — 流水线引擎核心
 *
 * Pipeline 定义器 + 执行器 + 上下文管理 + 错误处理
 */
import type { AutoRecModule, PipelineContext, PipelineDef, PipelineRun, PipelineModuleRun, HookEvent } from './types.js';

export class AutoRecEngine {
  private modules = new Map<string, AutoRecModule>();
  private pipelines = new Map<string, PipelineDef>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private runs: PipelineRun[] = [];

  /** 注册子模块 */
  registerModule(module: AutoRecModule): void {
    if (this.modules.has(module.id)) {
      console.warn(`[AutoRec] 模块 ${module.id} 已注册，覆盖`);
    }
    this.modules.set(module.id, module);
    console.log(`[AutoRec] 模块已注册: ${module.id} (${module.name})`);
  }

  /** 注册 Pipeline */
  registerPipeline(def: PipelineDef): void {
    for (const modId of def.modules) {
      if (!this.modules.has(modId)) {
        throw new Error(`[AutoRec] Pipeline ${def.id} 依赖未注册的模块: ${modId}`);
      }
    }
    this.pipelines.set(def.id, def);
    console.log(`[AutoRec] Pipeline 已注册: ${def.id} (${def.name})`);
  }

  /** 启动定时 Pipeline */
  startTimer(pipelineId: string): boolean {
    const def = this.pipelines.get(pipelineId);
    if (!def || def.trigger.type !== 'timer' || !def.trigger.config.interval) return false;

    if (this.timers.has(pipelineId)) return true; // 已启动

    const timer = setInterval(() => {
      this.run(pipelineId).catch(err => console.warn(`[AutoRec] ${pipelineId} 执行失败:`, err));
    }, def.trigger.config.interval);

    this.timers.set(pipelineId, timer);

    // 首次执行延迟 5 秒后启动
    setTimeout(() => {
      this.run(pipelineId).catch(err => console.warn(`[AutoRec] ${pipelineId} 首次执行失败:`, err));
    }, 5000);

    console.log(`[AutoRec] 定时器已启动: ${pipelineId} (${def.trigger.config.interval}ms)`);
    return true;
  }

  /** 停止定时 Pipeline */
  stopTimer(pipelineId: string): void {
    const timer = this.timers.get(pipelineId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(pipelineId);
      console.log(`[AutoRec] 定时器已停止: ${pipelineId}`);
    }
  }

  /** 单次执行 Pipeline */
  async run(pipelineId: string, context?: Partial<PipelineContext>): Promise<PipelineRun> {
    const def = this.pipelines.get(pipelineId);
    if (!def) throw new Error(`Pipeline ${pipelineId} 未注册`);

    const run: PipelineRun = {
      id: `${pipelineId}_${Date.now().toString(36)}`,
      pipelineId,
      status: 'running',
      modules: def.modules.map(modId => ({ moduleId: modId, status: 'pending' })),
      startTime: new Date().toISOString(),
    };

    const ctx: PipelineContext = {
      traceId: run.id,
      startTime: run.startTime,
      shared: {},
      hooks: {
        push: (event: HookEvent) => {
          console.log(`[Hook] ${event.operation_type} ${event.status} ${event.duration_ms}ms`);
        },
      },
      ...context,
    };

    for (let i = 0; i < def.modules.length; i++) {
      const modId = def.modules[i];
      const module = this.modules.get(modId);
      if (!module) {
        run.modules[i].status = 'failed';
        run.modules[i].error = `模块 ${modId} 未注册`;
        run.status = 'failed';
        break;
      }

      run.modules[i].status = 'running';
      const modStart = Date.now();

      try {
        const input = ctx.shared[`${modId}_input`] ?? {};
        const output = await module.execute(input, ctx);

        ctx.shared[`${modId}_output`] = output;
        run.modules[i].status = 'completed';
        run.modules[i].durationMs = Date.now() - modStart;
      } catch (err) {
        run.modules[i].status = 'failed';
        run.modules[i].error = (err as Error).message;
        run.modules[i].durationMs = Date.now() - modStart;

        if (def.errorStrategy === 'stop') {
          run.status = 'failed';
          break;
        }
        if (['retry', 'rollback'].includes(def.errorStrategy)) {
          run.status = 'failed';
          break;
        }
        // skip: 继续下一步
      }
    }

    if (run.status === 'running') {
      run.status = 'completed';
    }
    run.endTime = new Date().toISOString();
    this.runs.push(run);
    if (this.runs.length > 100) this.runs.shift();

    return run;
  }

  /** 获取运行历史 */
  getRuns(pipelineId?: string): PipelineRun[] {
    return pipelineId ? this.runs.filter(r => r.pipelineId === pipelineId) : this.runs;
  }
}
