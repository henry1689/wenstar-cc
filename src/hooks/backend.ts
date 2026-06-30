/**
 * Hooks 后台 — 数据接收 + 存储 + 分析 + 指令管理
 *
 * S4 核心交付：闭环
 *  采集 → hooks_events 入库 → 规则分析 → hooks_commands → AutoRec 消费 → 回写
 */
import type { HookEvent } from './types.js';
import type { SQLiteAdapter } from '../m2/SQLiteAdapter.js';
import { randomUUID } from 'node:crypto';

// ════════════════════════════════════════════════════════════════════
// 事件入库
// ════════════════════════════════════════════════════════════════════

export function insertEvent(sqlite: SQLiteAdapter, event: HookEvent): string {
  const id = `hook_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  sqlite.writeRaw(
    `INSERT OR IGNORE INTO hooks_events (id, dna_code, operation_type, duration_ms, status, input_tags, source_tier, target_tier, payload_size, match_count, error_info, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, event.dna_code || null, event.operation_type, event.duration_ms, event.status,
    event.input_tags ? JSON.stringify(event.input_tags) : null,
    event.source_tier || null, event.target_tier || null,
    event.payload_size || 0, event.match_count || 0,
    event.error_info || null, event.timestamp || new Date().toISOString(),
  );
  return id;
}

export function insertEvents(sqlite: SQLiteAdapter, events: HookEvent[]): number {
  let count = 0;
  for (const ev of events) {
    try { insertEvent(sqlite, ev); count++; } catch {}
  }
  return count;
}

// ════════════════════════════════════════════════════════════════════
// 指令管理
// ════════════════════════════════════════════════════════════════════

export interface Command {
  id: string;
  command_type: 'promote' | 'demote' | 'clean' | 'reindex' | 'none';
  target_dna?: string;
  target_module?: string;
  status: 'pending' | 'dispatched' | 'done' | 'failed';
  source_analysis?: string;
  payload?: any;
  created_at: string;
  dispatched_at?: string;
  done_at?: string;
}

export function createCommand(
  sqlite: SQLiteAdapter,
  type: Command['command_type'],
  targetDna?: string,
  analysis?: string,
  payload?: any,
): Command {
  const cmd: Command = {
    id: `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    command_type: type,
    target_dna: targetDna,
    status: 'pending',
    source_analysis: analysis,
    payload,
    created_at: new Date().toISOString(),
  };
  sqlite.writeRaw(
    `INSERT INTO hooks_commands (id, command_type, target_dna, status, source_analysis, payload, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    cmd.id, cmd.command_type, cmd.target_dna || null,
    cmd.source_analysis || null,
    cmd.payload ? JSON.stringify(cmd.payload) : null,
    cmd.created_at,
  );
  return cmd;
}

export function getPendingCommands(sqlite: SQLiteAdapter): Command[] {
  const rows = sqlite.queryAll(
    "SELECT * FROM hooks_commands WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20",
  ) as any[];
  return rows.map(r => ({
    id: r.id as string,
    command_type: r.command_type as Command['command_type'],
    target_dna: r.target_dna as string | undefined,
    target_module: r.target_module as string | undefined,
    status: r.status as Command['status'],
    source_analysis: r.source_analysis as string | undefined,
    payload: r.payload ? JSON.parse(r.payload as string) : undefined,
    created_at: r.created_at as string,
    dispatched_at: r.dispatched_at as string | undefined,
    done_at: r.done_at as string | undefined,
  }));
}

export function updateCommandStatus(
  sqlite: SQLiteAdapter,
  id: string,
  status: Command['status'],
): void {
  const now = new Date().toISOString();
  if (status === 'done') {
    sqlite.writeRaw("UPDATE hooks_commands SET status = ?, done_at = ? WHERE id = ?", status, now, id);
  } else if (status === 'dispatched') {
    sqlite.writeRaw("UPDATE hooks_commands SET status = ?, dispatched_at = ? WHERE id = ?", status, now, id);
  } else {
    sqlite.writeRaw("UPDATE hooks_commands SET status = ? WHERE id = ?", status, id);
  }
}

// ════════════════════════════════════════════════════════════════════
// 规则分析引擎
// ════════════════════════════════════════════════════════════════════

export interface AnalysisResult {
  commands: Command[];
  summary: string;
}

/**
 * 执行规则分析 —— 基于 hooks_events 数据，产出调度指令
 *
 * 规则列表：
 *   ① 高频调用 + 高钙化 → 金库→黑钻晋升
 *   ② 0 召回 + 超过 30 天 → 过期清理
 *   ③ 检索耗时 > 200ms → 重索引
 */
export function analyze(sqlite: SQLiteAdapter): AnalysisResult {
  const commands: Command[] = [];
  const now = new Date().toISOString();

  // ① 高频高钙记忆 → 黑钻晋升
  try {
    const promote = sqlite.queryAll(`
      SELECT m.id, m.raw_input, m.calcium_score, m.recall_count
      FROM memories m
      WHERE m.calcium_score >= 4.5 AND (m.promoted_to_diamond IS NULL OR m.promoted_to_diamond = 0)
      ORDER BY m.calcium_score DESC LIMIT 3
    `) as any[];
    for (const p of promote) {
      const cmd = createCommand(sqlite, 'promote', p.id,
        `钙化分 ${p.calcium_score}，召回 ${p.recall_count} 次，自动晋升黑钻`,
        { memoryId: p.id, calciumScore: p.calcium_score },
      );
      commands.push(cmd);
    }
  } catch {}

  // ② 过期砂金清理
  try {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const expired = sqlite.queryAll(
      `SELECT id, raw_input FROM memories WHERE created_at < ? AND recall_count = 0 AND promoted_to_diamond IS NULL LIMIT 5`,
      [cutoff],
    ) as any[];
    if (expired.length > 0) {
      const ids = expired.map((r: any) => r.id);
      const cmd = createCommand(sqlite, 'clean', undefined,
        `${expired.length} 条记忆超过 30 天无召回，自动清理`,
        { memoryIds: ids },
      );
      commands.push(cmd);
    }
  } catch {}

  // ③ 慢查询检测 → 重索引建议
  try {
    const slowCount = sqlite.queryAll(
      `SELECT COUNT(*) as c FROM hooks_events WHERE operation_type = 'module_vector_align' AND duration_ms > 200 AND created_at > ?`,
      [new Date(Date.now() - 3600000).toISOString()],
    ) as any[];
    if ((slowCount[0]?.c || 0) > 3) {
      const cmd = createCommand(sqlite, 'reindex', undefined,
        `最近 1 小时有 ${slowCount[0]?.c} 次慢查询 > 200ms，建议重索引`,
        { reason: 'slow_query' },
      );
      commands.push(cmd);
    }
  } catch {}

  return {
    commands,
    summary: `分析完成: 晋升 ${commands.filter(c => c.command_type === 'promote').length}, 清理 ${commands.filter(c => c.command_type === 'clean').length}, 重索引 ${commands.filter(c => c.command_type === 'reindex').length}`,
  };
}
