/**
 * temporal_event_hook — 第15号时序事件监控Hook探针
 *
 * 三色状态：绿=正常运行 黄=即将到期/嵌套临近上限 红=时序冲突/异常终止
 * 接入现有 hooks_events 表，不新增表
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import { insertEvent } from '../../hooks/backend.js';
import type { TemporalEventArchive } from './TemporalEventArchive.js';

export function snapshotTemporalEvents(sqlite: SQLiteAdapter, archive: TemporalEventArchive): void {
  const stats = archive.getStats();

  let status: 'success' | 'fail' = 'success';
  let errorInfo = '';
  if (stats.running === 0) {
    status = 'success';
    errorInfo = '无运行中事件';
  }

  insertEvent(sqlite, {
    operation_type: 'temporal_event_snapshot',
    duration_ms: 0,
    status,
    dna_code: undefined,
    input_tags: [`running:${stats.running}`, `cyclic:${stats.cyclic}`],
    source_tier: 'temporal',
    error_info: errorInfo,
    timestamp: new Date().toISOString(),
  });
}

export function recordEventViolation(sqlite: SQLiteAdapter, eventText: string, reason: string): void {
  insertEvent(sqlite, {
    operation_type: 'temporal_event_violation',
    duration_ms: 0,
    status: 'error',
    error_info: `违规: ${reason} | 内容: ${eventText.substring(0, 60)}`,
    input_tags: ['violation', 'blocked'],
    timestamp: new Date().toISOString(),
  });
}
