/**
 * index.ts — M6 治理与安全模块统一出口
 *
 * 对外只暴露本文件的公开 API，内部模块不允许外部直接 import。
 * 这是加固方案的一部分：内部实现封装，只暴露稳定接口。
 */

// ============================================================
// 模块导出
// ============================================================

export * from './securityConfig';
export * from './policyEngine';
export * from './accessControl';
export * from './auditLog';
export * from './integrityCheck';
// 🔴 四个模块各自定义了测试钩子 `_resetForTest`，`export *` 同时展开必然歧义
//    （TS2308）。显式导出优先级高于星号导出，这里指定以 securityConfig 的为准。
//    各模块的测试直接 `from '../src/<module>'` 导入自己的钩子，不依赖本出口。
export { _resetForTest } from './securityConfig';

// ============================================================
// 统一初始化工厂
// ============================================================

import { initSecurityConfig, type SecurityConfig, type ConfigPatch } from './securityConfig';
import { setDefaultDecision } from './policyEngine';
import { startPeriodicFlush } from './auditLog';
import { startPeriodic, type MemSymEntry } from './integrityCheck';

/** 治理子系统初始化配置 */
export interface GovernanceInitConfig {
  /** 签名密钥（生产环境必须传入） */
  signingKey?: string;
  /** 配置覆盖项 */
  configOverrides?: ConfigPatch;
  /** 记忆条目提供者（用于完整性巡检） */
  entriesProvider?: () => MemSymEntry[];
  /** 是否启动周期性巡检 */
  startPeriodicCheck?: boolean;
  /** 是否启动审计日志定时刷盘 */
  startAuditFlush?: boolean;
}

/** 治理子系统句柄 */
export interface GovernanceSystem {
  /** 重新校验配置签名 */
  verifyConfigSignature: () => boolean;
  /** 停止所有后台任务 */
  shutdown: () => void;
}

/**
 * 初始化治理与安全子系统
 * 一次性完成所有模块的初始化
 */
export function initGovernance(config: GovernanceInitConfig = {}): GovernanceSystem {
  // 1. 初始化安全配置中心
  initSecurityConfig({
    signingKey: config.signingKey,
    overrides: config.configOverrides,
  });

  // 2. 设置默认决策为 deny-all（安全默认）
  const secConfig = getConfig();
  setDefaultDecision(!secConfig.defaultDenyAll);

  // 3. 初始化完整性巡检（如果提供了条目提供者）
  if (config.entriesProvider) {
    // 延迟初始化：第一次调用 quickCheck 时自动建立基线
  }

  // 4. 启动审计日志定时刷盘
  if (config.startAuditFlush !== false) {
    startPeriodicFlush();
  }

  // 5. 启动周期性完整性巡检
  if (config.startPeriodicCheck && config.entriesProvider) {
    startPeriodic();
  }

  return {
    verifyConfigSignature,
    shutdown: () => {
      stopPeriodic();
      stopPeriodicFlush();
    },
  };
}

// ============================================================
// 便捷导出（从各模块重新导出常用函数）
// ============================================================

import { getConfig, verifyConfigSignature } from './securityConfig';
import { stopPeriodic } from './integrityCheck';
import { stopPeriodicFlush } from './auditLog';

/** 模块版本 */
export const VERSION = '2.0.0';

/** 模块名称 */
export const MODULE_NAME = '@wenstar/governance';
