/**
 * MemArch-v2.0.0 / M2-OnlineWrite / index
 *
 * 对外导出入口
 * 加固后：仅暴露 MemoryWriter 单一入口，内部模块不对外
 */

export { MemoryWriter } from './MemoryWriter.js';
export { WorkingMemory } from './WorkingMemory.js';
export { EventSegmenter } from './EventSegmenter.js';
export { GateDecider } from './Gate.js';
export { SalienceCalculator } from './SalienceCalculator.js';
export { ProspectiveExtractor } from './ProspectiveExtractor.js';
export { M2_CONFIG } from './config.js';
export type {
  WriteMessageInput,
  WriteResult,
  WorkingEntry,
  Gate,
  SegmentationResult,
  ProspectiveItem,
  WriteHooks,
} from './types.js';
