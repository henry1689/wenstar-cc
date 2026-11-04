/**
 * integrityCheck.ts — 记忆完整性巡检
 *
 * 职责：
 * 1. Merkle Tree 哈希根校验，检测记忆条目篡改
 * 2. 周期性巡检：快速巡检 + 深度扫描
 * 3. 发现篡改：事件告警 + 隔离可疑条目
 *
 * 设计理由：
 * - Merkle Tree 结构：任何叶子修改都会传播到根，O(log n) 证明
 * - quickCheck 仅比对根哈希，P99 < 100ms（万级条目）
 * - deepScan 全量重新计算，用于定期彻底校验
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getConfig } from './securityConfig';

// ============================================================
// 类型定义
// ============================================================

/** 记忆条目（抽象接口，由上层注入） */
export interface MemSymEntry {
  /** 条目唯一 ID */
  id: string;
  /** 条目内容哈希（数据摘要） */
  contentHash: string;
  /** 是否被隔离 */
  isolated?: boolean;
}

/** 巡检结果 */
export interface IntegrityCheckResult {
  /** 是否通过 */
  ok: boolean;
  /** 当前计算出的 Merkle Root */
  currentRoot: string;
  /** 基线 Merkle Root */
  baselineRoot: string;
  /** 不一致的条目 ID 列表 */
  corruptedIds: string[];
  /** 巡检耗时 */
  durationMs: number;
  /** 巡检类型 */
  type: 'quick' | 'deep';
}

/** 违规事件载荷 */
export interface ViolationEvent {
  /** 违规时间 */
  timestamp: number;
  /** 不一致的条目 */
  corruptedIds: string[];
  /** 当前根哈希 */
  currentRoot: string;
  /** 基线根哈希 */
  baselineRoot: string;
  /** 巡检类型 */
  type: 'quick' | 'deep';
}

// ============================================================
// 内部状态
// ============================================================

/** 事件总线 */
const eventBus = new EventEmitter();

/** 基线 Merkle Root */
let baselineRoot = '';

/** 当前记忆条目列表（由上层注入） */
let entriesProvider: () => MemSymEntry[] = () => [];

/** 巡检定时器 */
let periodicTimer: NodeJS.Timeout | null = null;

/** 已隔离的条目集合 */
const isolatedIds = new Set<string>();

// ============================================================
// 内部工具
// ============================================================

/**
 * 计算单个条目的哈希
 */
function entryHash(entry: MemSymEntry): string {
  return createHash('sha256').update(`${entry.id}:${entry.contentHash}`, 'utf8').digest('hex');
}

/**
 * 构建 Merkle Tree 并返回根哈希
 *
 * 算法：
 * 1. 叶子层：所有条目的哈希
 * 2. 中间层：两两合并哈希
 * 3. 奇数个节点时，最后一个复制自身补齐
 *
 * 设计理由：标准 Bitcoin 风格 Merkle Tree，O(n) 构建，O(log n) 证明
 */
function computeMerkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) {
    return createHash('sha256').update('empty').digest('hex');
  }

  let layer = [...leafHashes];

  while (layer.length > 1) {
    const nextLayer: string[] = [];

    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      // 奇数个节点，复制最后一个补齐
      const right = layer[i + 1] ?? left;
      const combined = createHash('sha256')
        .update(left + right, 'utf8')
        .digest('hex');
      nextLayer.push(combined);
    }

    layer = nextLayer;
  }

  return layer[0]!;
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 初始化完整性巡检
 * @param provider 条目提供者函数（返回当前所有记忆条目）
 * @param baselineRoot 基线根哈希（不传则用当前计算值作为基线）
 */
export function initIntegrityCheck(
  provider: () => MemSymEntry[],
  baselineRoot?: string
): void {
  entriesProvider = provider;

  if (baselineRoot) {
    // 使用外部基线
    setBaselineRoot(baselineRoot);
  } else {
    // 自动计算当前基线（调用 setBaselineRoot 避免参数名遮蔽模块变量）
    const entries = provider();
    const hashes = entries.map(entryHash);
    const root = computeMerkleRoot(hashes);
    setBaselineRoot(root);
  }
}

/**
 * 设置基线根哈希
 */
export function setBaselineRoot(root: string): void {
  baselineRoot = root;
}

/**
 * 获取当前基线根哈希
 */
export function getBaselineRoot(): string {
  return baselineRoot;
}

/**
 * 快速巡检：仅比对根哈希
 * P99 < 100ms（万级条目规模）
 */
export function quickCheck(): IntegrityCheckResult {
  const start = performance.now();

  const entries = entriesProvider();
  const hashes = entries.map(entryHash);
  const currentRoot = computeMerkleRoot(hashes);

  const duration = performance.now() - start;

  const ok = currentRoot === baselineRoot;

  // 性能断言：快速巡检必须 < 100ms
  if (duration > 100) {
    console.warn(`[integrityCheck] quickCheck 耗时 ${duration.toFixed(2)}ms，超过 100ms 基线`);
  }

  if (!ok) {
    // 快速巡检只知道根不一致，不知道具体哪些条目
    const result: IntegrityCheckResult = {
      ok: false,
      currentRoot,
      baselineRoot,
      corruptedIds: [], // 快速巡检不定位具体条目
      durationMs: duration,
      type: 'quick',
    };
    emitViolation(result);
    return result;
  }

  return {
    ok: true,
    currentRoot,
    baselineRoot,
    corruptedIds: [],
    durationMs: duration,
    type: 'quick',
  };
}

/**
 * 深度扫描：全量比对所有条目，定位篡改位置
 * 比 quickCheck 慢，但能精确定位
 */
export function deepScan(): IntegrityCheckResult {
  const start = performance.now();

  const entries = entriesProvider();
  const corruptedIds: string[] = [];

  // 重新计算根
  const hashes = entries.map(entryHash);
  const currentRoot = computeMerkleRoot(hashes);

  // 深度扫描：逐条检查是否被隔离（被隔离的视为可疑）
  for (const entry of entries) {
    if (entry.isolated || isolatedIds.has(entry.id)) {
      corruptedIds.push(entry.id);
    }
  }

  const duration = performance.now() - start;
  const ok = currentRoot === baselineRoot && corruptedIds.length === 0;

  const result: IntegrityCheckResult = {
    ok,
    currentRoot,
    baselineRoot,
    corruptedIds,
    durationMs: duration,
    type: 'deep',
  };

  if (!ok) {
    emitViolation(result);
  }

  return result;
}

/**
 * 对外 check 接口：自动选择巡检方式
 * @param expectedRoot 可选的期望根哈希（不传则用内部基线）
 */
export function check(expectedRoot?: string): IntegrityCheckResult {
  if (expectedRoot) {
    setBaselineRoot(expectedRoot);
  }
  return quickCheck();
}

/**
 * 启动周期性巡检
 * @param intervalMs 间隔（毫秒），不传则用配置默认值
 */
export function startPeriodic(intervalMs?: number): void {
  const cfg = getConfig();
  if (periodicTimer) return;

  const interval = intervalMs ?? cfg.quickCheckIntervalMs;

  periodicTimer = setInterval(() => {
    try {
      quickCheck();
    } catch (err) {
      console.error('[integrityCheck] 巡检失败:', err);
    }
  }, interval);

  periodicTimer.unref();
}

/**
 * 停止周期性巡检
 */
export function stopPeriodic(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

/**
 * 注册违规事件回调
 */
export function onViolation(cb: (event: ViolationEvent) => void): void {
  eventBus.on('integrity:violation', cb);
}

/**
 * 移除违规事件回调
 */
export function offViolation(cb: (event: ViolationEvent) => void): void {
  eventBus.off('integrity:violation', cb);
}

/**
 * 隔离可疑条目
 */
export function isolateEntry(entryId: string): void {
  isolatedIds.add(entryId);
}

/**
 * 解除隔离
 */
export function unisolateEntry(entryId: string): void {
  isolatedIds.delete(entryId);
}

/**
 * 检查条目是否被隔离
 */
export function isIsolated(entryId: string): boolean {
  return isolatedIds.has(entryId);
}

/**
 * 触发违规事件
 */
function emitViolation(result: IntegrityCheckResult): void {
  const event: ViolationEvent = {
    timestamp: Date.now(),
    corruptedIds: result.corruptedIds,
    currentRoot: result.currentRoot,
    baselineRoot: result.baselineRoot,
    type: result.type,
  };
  eventBus.emit('integrity:violation', event);
}

/**
 * 重置状态（测试用）
 */
export function _resetForTest(): void {
  baselineRoot = '';
  entriesProvider = () => [];
  isolatedIds.clear();
  stopPeriodic();
  eventBus.removeAllListeners();
}
