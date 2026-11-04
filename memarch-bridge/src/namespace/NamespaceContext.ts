/**
 * NamespaceContext.ts — 命名空间上下文（AsyncLocalStorage）
 *
 * 【解决什么问题】
 *   主系统调用链很深（chat.ts → M5Orchestrator → MemoryRetriever → ...），
 *   如果每次都手动传 namespace，容易漏传 → 漏传就串台。
 *
 *   用 AsyncLocalStorage 在入口处 set 一次，整条调用链自动带上，
 *   适配器在调用 M2/M4/M5 前强制取当前 namespace，取不到直接抛错 ——
 *   从工程上杜绝「裸查 default namespace 导致跨角色串台」。
 *
 * 【与 M6 治理对齐】
 *   NamespaceContext 注入的 namespace 会传给 checkPermission()，
 *   M6 accessControl 用 ABAC 校验 subject 是否能访问该 namespace，
 *   双重保险：即使上下文被污染，治理层也会拦截。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface NamespaceScope {
  /** 当前角色命名空间（物理隔离键） */
  namespace: string;
  /** 角色名（玉瑶/诗雨/王全芬...，仅日志用） */
  roleplayChar?: string;
  /** 本次会话 traceId（审计追踪） */
  sessionId: string;
  /** 调用者主体（M6 用） */
  subject: {
    id: string;
    role: 'owner' | 'admin' | 'agent' | 'readOnly' | 'system';
  };
}

const storage = new AsyncLocalStorage<NamespaceScope>();

export const NamespaceContext = {
  /** 进入一个命名空间作用域（主系统入口处调用） */
  run<T>(scope: NamespaceScope, fn: () => Promise<T> | T): Promise<T> | T {
    // 强制命名空间校验：不允许空字符串 / default 裸跑
    if (!scope.namespace || scope.namespace.trim() === '') {
      throw new Error(
        `[memarch-bridge:namespace] 命名空间不能为空。` +
        `角色切换/新会话必须显式指定 namespace（如 ns_yuyao / ns_shiyu）。`
      );
    }
    if (scope.namespace === 'default') {
      throw new Error(
        `[memarch-bridge:namespace] 禁止使用 'default' 命名空间跑业务。` +
        `这是导致跨角色串台的根因。请按角色显式分配 namespace（见 NamespaceManager）。`
      );
    }
    return storage.run(scope, fn);
  },

  /** 获取当前作用域（适配器内部用） */
  current(): NamespaceScope | undefined {
    return storage.getStore();
  },

  /** 必须在作用域内，否则抛错（适配器调用前强制校验） */
  require(): NamespaceScope {
    const s = storage.getStore();
    if (!s) {
      throw new Error(
        `[memarch-bridge:namespace] 当前不在命名空间作用域内。` +
        `主系统入口必须用 NamespaceContext.run({namespace: 'ns_xxx'}, async () => {...}) 包裹。`
      );
    }
    return s;
  },

  /** 当前命名空间（便捷取值） */
  namespace(): string {
    return this.require().namespace;
  },
};
