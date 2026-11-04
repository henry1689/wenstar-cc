/**
 * OldConfigAdapter.ts — 旧 MemoryConfig → 新系统配置视图
 *
 * 【适配关系】
 *   旧：src/config/MemoryConfig.ts（全局配置单例）
 *   新：M2_CONFIG / M4 DegradeBudget / M5 PresentationConfig
 *
 * 【说明】
 *   不删旧 MemoryConfig，本适配器做合并视图：
 *   - key 命中新系统 → 走新 config
 *   - key 未命中 → fallback 到旧 config
 *   - 主系统读写 config 都通过本适配器，新旧切换无感知
 */

import type { MemoryConfigPort } from '../core/MemoryPort.js';

export interface LegacyConfig {
  get<T = unknown>(key: string): T;
  set(key: string, value: unknown): void;
}

export class OldConfigAdapter implements MemoryConfigPort {
  private v2Overrides = new Map<string, unknown>();

  constructor(private readonly legacyConfig: LegacyConfig) {}

  get<T = unknown>(key: string): T {
    if (this.v2Overrides.has(key)) return this.v2Overrides.get(key) as T;
    return this.legacyConfig.get<T>(key);
  }

  set(key: string, value: unknown): void {
    this.v2Overrides.set(key, value);
    // 同步写一份到旧 config（保持灰度期两边配置一致）
    this.legacyConfig.set(key, value);
  }

  getAll(): Record<string, unknown> {
    return Object.fromEntries(this.v2Overrides);
  }
}
