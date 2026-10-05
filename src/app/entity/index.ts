/**
 * entity/ — 多角色超长上下文隔离管理模块
 * =========================================
 * EntityContextManager: UUID 上下文窗口管理 + 隔离 + token预算
 * EntityContextStore:    DB 级持久化 + 跨会话重建 + 情感快照
 * EntityContextStrategy: 【已删除】—— 见 EntityContextStrategy.ts 墓碑；窗口真源收敛为 contextWindowTurns
 * EntityContextCompressor: 三层压缩 (锚点/摘要/归档)
 * EntityIndexMaintainer: UUID 列索引维护
 */
export { EntityContextManager } from './EntityContextManager.js';
export type { EntityContextWindow } from './EntityContextManager.js';
export { EntityContextStore } from './EntityContextStore.js';
export type { EmotionSnapshot } from './EntityContextStore.js';
// 🔴 V35-B(2026-10-05): 不再导出 EntityContextStrategy 的任何符号 —— 该模块的实现已整体删除
//   （computeStrategy 是「窗口」概念的第 7 份实现，压在配置窗口之上再切一刀；其 warmth 与
//    lastInteraction 两个输入从来不可得，实际只靠 category 一维工作）。
//   业主要求：会晤窗口 = MemoryConfig.compaction.contextWindowTurns，不接受第二套窗口政策。
//   墓碑与恢复条件见 ./EntityContextStrategy.ts。窗口真源唯一 = contextWindowTurns。
export { compressContext, buildCompressedText } from './EntityContextCompressor.js';
export type { CompressedContext } from './EntityContextCompressor.js';
export { ensureEntityUUIDIndexes, verifyIndexes } from './EntityIndexMaintainer.js';
