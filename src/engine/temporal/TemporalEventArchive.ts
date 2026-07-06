/**
 * TemporalEventArchive — 时序事件档案管理器
 *
 * 核心职责：
 * - 时序事件全生命周期 CRUD
 * - 循环事件自动续期
 * - 时序合规校验（对外公共API）
 * - 嵌套事件关联管理
 * - DNA根码绑定溯源
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import { EVENT_COMMON_SENSE } from './TemporalConfig.js';

export interface TemporalEvent {
  event_id: string;
  belong_entity_id: string;
  event_type: 'phys_cycle' | 'trip' | 'heal' | 'custom';
  parent_event_id: string | null;
  event_raw_text: string;
  start_ts: number;
  end_ts: number | null;
  cycle_ms: number;
  is_cyclic: boolean;
  dna_root_id: string;
  status: 'running' | 'completed' | 'canceled' | 'warning';
  create_at: number;
}

export interface TemporalEventRecord {
  belongEntityId: string;
  eventType: TemporalEvent['event_type'] | string;
  eventRawText: string;
  startTs?: number;
  endTs?: number;
  cycleMs?: number;
  dnaRootId: string;
  parentEventId?: string;
}

export class TemporalEventArchive {
  private sqlite: SQLiteAdapter;

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
  }

  private uid(): string {
    return 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
  }

  createEvent(params: TemporalEventRecord): TemporalEvent {
    const now = Date.now();
    const event: TemporalEvent = {
      event_id: this.uid(),
      belong_entity_id: params.belongEntityId,
      event_type: (params.eventType as TemporalEvent['event_type']) || 'custom',
      parent_event_id: params.parentEventId || null,
      event_raw_text: params.eventRawText,
      start_ts: params.startTs ?? now,
      end_ts: params.endTs ?? null,
      cycle_ms: params.cycleMs ?? 0,
      is_cyclic: (params.cycleMs ?? 0) > 0,
      dna_root_id: params.dnaRootId,
      status: 'running',
      create_at: now,
    };
    this.sqlite.writeRaw(
      `INSERT INTO temporal_events (event_id, belong_entity_id, event_type, parent_event_id, event_raw_text, start_ts, end_ts, cycle_ms, is_cyclic, dna_root_id, status, create_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.event_id, event.belong_entity_id, event.event_type, event.parent_event_id,
       event.event_raw_text, event.start_ts, event.end_ts, event.cycle_ms,
       event.is_cyclic ? 1 : 0, event.dna_root_id, event.status, event.create_at],
    );
    return event;
  }

  getEvent(eventId: string): TemporalEvent | null {
    const rows = this.sqlite.queryAll('SELECT * FROM temporal_events WHERE event_id = ? LIMIT 1', [eventId]);
    if (rows.length === 0) return null;
    return this.rowToEvent(rows[0] as any);
  }

  getRunningEvents(entityId: string): TemporalEvent[] {
    const rows = this.sqlite.queryAll(
      'SELECT * FROM temporal_events WHERE belong_entity_id = ? AND status = \'running\' ORDER BY start_ts ASC',
      [entityId],
    );
    return rows.map(r => this.rowToEvent(r as any));
  }

  getExpiredEvents(nowTs: number): TemporalEvent[] {
    const rows = this.sqlite.queryAll(
      'SELECT * FROM temporal_events WHERE status = \'running\' AND end_ts IS NOT NULL AND end_ts <= ? ORDER BY end_ts ASC',
      [nowTs],
    );
    return rows.map(r => this.rowToEvent(r as any));
  }

  updateStatus(eventId: string, status: TemporalEvent['status']): void {
    this.sqlite.writeRaw('UPDATE temporal_events SET status = ? WHERE event_id = ?', [status, eventId]);
  }

  cancelEvent(eventId: string): void {
    this.sqlite.writeRaw('UPDATE temporal_events SET status = \'canceled\' WHERE event_id = ?', [eventId]);
  }

  renewCyclicEvent(eventId: string): TemporalEvent | null {
    const event = this.getEvent(eventId);
    if (!event || !event.is_cyclic || event.cycle_ms <= 0) return null;

    const newStart = (event.end_ts || Date.now()) + 1;
    const newEnd = event.cycle_ms > 0 ? newStart + event.cycle_ms : null;
    const newId = this.uid();
    this.sqlite.writeRaw(
      `INSERT INTO temporal_events (event_id, belong_entity_id, event_type, parent_event_id, event_raw_text, start_ts, end_ts, cycle_ms, is_cyclic, dna_root_id, status, create_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      [newId, event.belong_entity_id, event.event_type, event.parent_event_id,
       event.event_raw_text, newStart, newEnd, event.cycle_ms,
       event.is_cyclic ? 1 : 0, event.dna_root_id, Date.now()],
    );
    this.updateStatus(eventId, 'completed');
    return this.getEvent(newId);
  }

  checkEventCompliance(targetEvent: string, durationMs?: number): { valid: boolean; reason?: string } {
    if (/怀孕|生孩子|分娩|妊娠|生宝宝/.test(targetEvent)) {
      if (durationMs !== undefined && durationMs < EVENT_COMMON_SENSE.pregnancyDays * 86400000) {
        return { valid: false, reason: `孕育新生命需要${EVENT_COMMON_SENSE.pregnancyDays}天（约10个月），当前设定时间不足` };
      }
    }
    if (/例假|生理期|月经/.test(targetEvent)) {
      if (durationMs !== undefined && durationMs < 20 * 86400000) {
        return { valid: false, reason: '生理周期间隔不能少于20天' };
      }
    }
    if (/感冒|发烧|生病|咳嗽|受伤/.test(targetEvent)) {
      if (durationMs !== undefined && durationMs < EVENT_COMMON_SENSE.coldRecoveryDays * 86400000) {
        return { valid: false, reason: `伤病恢复需要至少${EVENT_COMMON_SENSE.coldRecoveryDays}天，不应该提前完成` };
      }
    }
    return { valid: true };
  }

  calcRemainingTime(eventId: string): { remainingMs: number; remainingText: string } | null {
    const event = this.getEvent(eventId);
    if (!event || !event.end_ts) return null;
    const remaining = event.end_ts - Date.now();
    if (remaining <= 0) return { remainingMs: 0, remainingText: '已到期' };
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    const days = Math.floor(hours / 24);
    if (days > 0) return { remainingMs: remaining, remainingText: `${days}天${hours % 24}小时` };
    if (hours > 0) return { remainingMs: remaining, remainingText: `${hours}小时${minutes}分钟` };
    return { remainingMs: remaining, remainingText: `${minutes}分钟` };
  }

  getChildEvents(parentId: string): TemporalEvent[] {
    const rows = this.sqlite.queryAll(
      'SELECT * FROM temporal_events WHERE parent_event_id = ? ORDER BY start_ts ASC',
      [parentId],
    );
    return rows.map(r => this.rowToEvent(r as any));
  }

  getStats(): { total: number; running: number; cyclic: number } {
    const total = (this.sqlite.queryAll('SELECT COUNT(*) as c FROM temporal_events')[0] as any)?.c ?? 0;
    const running = (this.sqlite.queryAll("SELECT COUNT(*) as c FROM temporal_events WHERE status = 'running'")[0] as any)?.c ?? 0;
    const cyclic = (this.sqlite.queryAll("SELECT COUNT(*) as c FROM temporal_events WHERE is_cyclic = 1 AND status = 'running'")[0] as any)?.c ?? 0;
    return { total, running, cyclic };
  }

  private rowToEvent(r: any): TemporalEvent {
    return {
      event_id: r.event_id,
      belong_entity_id: r.belong_entity_id,
      event_type: r.event_type,
      parent_event_id: r.parent_event_id,
      event_raw_text: r.event_raw_text,
      start_ts: r.start_ts,
      end_ts: r.end_ts,
      cycle_ms: r.cycle_ms,
      is_cyclic: r.is_cyclic === 1 || r.is_cyclic === true,
      dna_root_id: r.dna_root_id,
      status: r.status,
      create_at: r.create_at,
    };
  }
}
