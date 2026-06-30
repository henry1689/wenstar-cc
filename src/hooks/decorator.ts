/**
 * Hooks — 通用探针装饰器
 *
 * S3.1 无侵入式 @hook 装饰器
 * - 不修改原函数返回值
 * - 采集失败不影响主流程
 * - 支持同步/异步函数
 *
 * TS 5.0+ 推荐, TS<4.9 需 useDefineForClassFields: true
 */
import type { HookDecoratorConfig } from './types.js';
import { getQueue } from './queue.js';

const queue = getQueue();

/**
 * 探针装饰器工厂
 *
 * @example
 * class MyModule {
 *   @hook('module_execute', { collectInput: true, collectOutput: true })
 *   async execute(input: Input) { ... }
 * }
 */
export function hook(operationType: string, config?: HookDecoratorConfig) {
  return function (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const isAsync = originalMethod.constructor?.name === 'AsyncFunction';

    if (isAsync) {
      descriptor.value = async function (...args: any[]) {
        const start = Date.now();
        try {
          const result = await originalMethod.apply(this, args);
          const event = {
            operation_type: operationType,
            duration_ms: Date.now() - start,
            status: 'success' as const,
            timestamp: new Date().toISOString(),
            payload_size: config?.collectInput ? JSON.stringify(args).length : undefined,
          };
          queue.push(event).catch(() => {});
          return result;
        } catch (err) {
          const event = {
            operation_type: operationType,
            duration_ms: Date.now() - start,
            status: 'error' as const,
            error_info: (err as Error).message,
            timestamp: new Date().toISOString(),
          };
          queue.push(event).catch(() => {});
          throw err;
        }
      };
    } else {
      descriptor.value = function (...args: any[]) {
        const start = Date.now();
        try {
          const result = originalMethod.apply(this, args);
          queue.push({
            operation_type: operationType,
            duration_ms: Date.now() - start,
            status: 'success',
            timestamp: new Date().toISOString(),
          }).catch(() => {});
          return result;
        } catch (err) {
          queue.push({
            operation_type: operationType,
            duration_ms: Date.now() - start,
            status: 'error',
            error_info: (err as Error).message,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
          throw err;
        }
      };
    }

    return descriptor;
  };
}

/**
 * 函数包装器 — 用于静态方法或不宜使用装饰器的场景
 *
 * @example
 * const wrapped = wrapWithHook('feature_extract', originalFn);
 */
export function wrapWithHook<T extends (...args: any[]) => any>(
  operationType: string,
  fn: T,
): (...args: Parameters<T>) => ReturnType<T> {
  return ((...args: Parameters<T>) => {
    const start = Date.now();
    try {
      const result = fn(...args);
      if (result instanceof Promise) {
        return result.then(r => {
          queue.push({
            operation_type: operationType,
            duration_ms: Date.now() - start,
            status: 'success',
            timestamp: new Date().toISOString(),
          }).catch(() => {});
          return r;
        }).catch(err => {
          queue.push({
            operation_type: operationType,
            duration_ms: Date.now() - start,
            status: 'error',
            error_info: err.message,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
          throw err;
        }) as any;
      }
      queue.push({
        operation_type: operationType,
        duration_ms: Date.now() - start,
        status: 'success',
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      return result;
    } catch (err) {
      queue.push({
        operation_type: operationType,
        duration_ms: Date.now() - start,
        status: 'error',
        error_info: (err as Error).message,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      throw err;
    }
  }) as any;
}
