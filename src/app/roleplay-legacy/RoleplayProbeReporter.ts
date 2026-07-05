/**
 * RoleplayProbeReporter — 角色扮演域全链路探针上报
 *
 * 9 个探针（RP-H01 ~ RP-H09），对应四层结构与校验链路。
 *
 * 🔴 铁律：所有事件统一走 hookMonitor，与主系统探针格式完全一致。
 */
export type RPProbeID =
  'RP-H01' | 'RP-H02' | 'RP-H03' | 'RP-H04' | 'RP-H05' |
  'RP-H06' | 'RP-H07' | 'RP-H08' | 'RP-H09';

export interface RPProbeData {
  callCount: number;
  totalDuration: number;
  errorCount: number;
  lastValue?: number;
  lastLabels?: string;
}

/** 运行时探针数据存储（模块级，桥接 server.ts 的 hookMonitor） */
let _reporter: ((id: RPProbeID, durationMs: number, error?: string) => void) | null = null;

/** 让 server.ts 注入 hookMonitor 写入器 */
export function setProbeWriter(
  writer: (id: RPProbeID, durationMs: number, error?: string) => void,
): void {
  _reporter = writer;
}

/** 探针定义（供 HOOK_DEFS 使用） */
export const RP_PROBE_DEFS = [
  { id: 'RP-H01' as RPProbeID, name: 'RP·装配总耗时', th: 600000 },
  { id: 'RP-H02' as RPProbeID, name: 'RP·Layer1身份层注入', th: 600000 },
  { id: 'RP-H03' as RPProbeID, name: 'RP·Layer2关系层注入', th: 600000 },
  { id: 'RP-H04' as RPProbeID, name: 'RP·Layer3记忆层召回', th: 600000 },
  { id: 'RP-H05' as RPProbeID, name: 'RP·Layer4知识层注入', th: 600000 },
  { id: 'RP-H06' as RPProbeID, name: 'RP·身份层校验通过率', th: 600000 },
  { id: 'RP-H07' as RPProbeID, name: 'RP·事实层校验', th: 600000 },
  { id: 'RP-H08' as RPProbeID, name: 'RP·边界层校验', th: 600000 },
  { id: 'RP-H09' as RPProbeID, name: 'RP·角色生长状态', th: 600000 },
];

/** 通用上报接口（由 RoleplayDomain 管线内调用） */
export function reportProbe(id: RPProbeID, durationMs: number, error?: string): void {
  if (_reporter) _reporter(id, durationMs, error);
}

// ─── 快捷上报方法（RoleplayDomain 管线内使用） ───

export function reportAssembly(id: RPProbeID, durationMs: number, tokenCount: number, cached: boolean): void {
  reportProbe(id, durationMs);
}

export function reportMemoryRecall(count: number, avgScore: number): void {
  reportProbe('RP-H04', count * 10);
}

export function reportValidation(layer: 'identity' | 'fact' | 'boundary', passed: boolean, detail?: string): void {
  const id: RPProbeID = layer === 'identity' ? 'RP-H06' : layer === 'fact' ? 'RP-H07' : 'RP-H08';
  reportProbe(id, passed ? 1 : 100, passed ? undefined : detail);
}

export function reportRoleGrowth(tempCount: number, promotedCount: number): void {
  reportProbe('RP-H09', tempCount + promotedCount);
}
