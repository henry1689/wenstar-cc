/**
 * RoleplayProbeReporter — 全链路Hook探针上报
 *
 * 9个标准探针（H15-H23），复用全局HookBus。
 * 数据同步接入健康巡检接口。
 *
 * 🔴 铁律：
 *   - 所有事件统一走 hookMonitor，与主系统探针格式一致
 *   - 性能类/质量类/业务类 全链路覆盖
 */
export type RPProbeID =
  'RP-H01' | 'RP-H02' | 'RP-H03' | 'RP-H04' | 'RP-H05' |
  'RP-H06' | 'RP-H07' | 'RP-H08' | 'RP-H09';

/** 探针定义（供 HOOK_DEFS 使用） */
export const RP_PROBE_DEFS = [
  { id: 'RP-H01' as RPProbeID, name: 'RP·装配总耗时', th: 600000 },
  { id: 'RP-H02' as RPProbeID, name: 'RP·Layer1身份注入', th: 600000 },
  { id: 'RP-H03' as RPProbeID, name: 'RP·Layer2关系注入', th: 600000 },
  { id: 'RP-H04' as RPProbeID, name: 'RP·Layer3记忆召回', th: 600000 },
  { id: 'RP-H05' as RPProbeID, name: 'RP·Layer4知识注入', th: 600000 },
  { id: 'RP-H06' as RPProbeID, name: 'RP·身份层校验', th: 600000 },
  { id: 'RP-H07' as RPProbeID, name: 'RP·事实层校验', th: 600000 },
  { id: 'RP-H08' as RPProbeID, name: 'RP·边界层校验', th: 600000 },
  { id: 'RP-H09' as RPProbeID, name: 'RP·角色生长状态', th: 600000 },
];

let _writer: ((id: RPProbeID, durationMs: number, error?: string) => void) | null = null;

export function setProbeWriter(
  writer: (id: RPProbeID, durationMs: number, error?: string) => void,
): void {
  _writer = writer;
}

export function reportProbe(id: RPProbeID, durationMs: number, error?: string): void {
  if (_writer) _writer(id, durationMs, error);
}

/** 快捷：报告装配性能 */
export function reportAssembly(durationMs: number, layerSizes: Record<string, number>): void {
  reportProbe('RP-H01', durationMs);
  if (layerSizes.layer1) reportProbe('RP-H02', layerSizes.layer1);
  if (layerSizes.layer2) reportProbe('RP-H03', layerSizes.layer2);
  if (layerSizes.layer3) reportProbe('RP-H04', layerSizes.layer3);
  if (layerSizes.layer4) reportProbe('RP-H05', layerSizes.layer4);
}

/** 快捷：报告校验结果 */
export function reportValidation(layer: 'identity' | 'fact' | 'boundary', passed: boolean, detail?: string): void {
  const id: RPProbeID = layer === 'identity' ? 'RP-H06' : layer === 'fact' ? 'RP-H07' : 'RP-H08';
  reportProbe(id, passed ? 1 : 100, passed ? undefined : detail);
}

/** 快捷：报告角色生长 */
export function reportGrowth(turnCount: number): void {
  reportProbe('RP-H09', turnCount);
}
