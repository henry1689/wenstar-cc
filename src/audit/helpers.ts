/**
 * 审计系统 — 工具函数
 */
import type { CheckResult } from './types.js';

export function healthFromScore(score: number): string {
  if (score >= 80) return 'healthy';
  if (score >= 50) return 'degraded';
  return 'critical';
}

export function healthEmoji(h: string): string {
  switch (h) {
    case 'healthy': return '🟢';
    case 'degraded': return '🟡';
    case 'critical': return '🔴';
    default: return '⚪';
  }
}

export function formatMs(ms: number): string {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60) + 'm ' + Math.floor(ms % 60) + 's';
}

export function safeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 时钟 — 返回 {stop: () => number} */
export function clock(): { stop: () => number } {
  const start = Date.now();
  return { stop: () => Date.now() - start };
}

/** 通过 */
export function passed(id: string, name: string, module: string, detail: string, data?: Record<string, any>, ms = 0): CheckResult {
  return { id, name, module, status: 'passed', detail, data, durationMs: ms };
}

/** 失败 */
export function failed(id: string, name: string, module: string, detail: string, data?: Record<string, any>, ms = 0): CheckResult {
  return { id, name, module, status: 'failed', detail, data, durationMs: ms };
}

/** 异常 */
export function error(id: string, name: string, module: string, err: unknown, ms = 0): CheckResult {
  return { id, name, module, status: 'error', detail: '', error: safeErr(err), durationMs: ms };
}

/** 需人工确认 */
export function manual(id: string, name: string, module: string, detail: string, data?: Record<string, any>): CheckResult {
  return { id, name, module, status: 'manual', detail, data, durationMs: 0 };
}

/** API GET 请求 */
export async function apiGet(path: string): Promise<any> {
  const base = 'http://localhost:3000';
  const res = await fetch(base + path);
  if (!res.ok) throw new Error('API ' + res.status + ': ' + path);
  return res.json();
}

/** 查询计数 */
export async function queryCount(sql: string): Promise<number> {
  const d = await apiGet('/api/admin/query?sql=' + encodeURIComponent(sql));
  const rows = (d.rows || []) as Record<string, any>[];
  if (rows.length === 0) return 0;
  const keys = Object.keys(rows[0]);
  if (keys.length === 0) return 0;
  return Number(rows[0][keys[0]]) || 0;
}
