/**
 * route-utils.ts — 路由通用工具 (V4.0 Phase 4)
 * =============================================
 * 减少 12 个 route 文件中的重复样板代码。
 *
 * 使用:
 *   import { ok, error, jsonBody } from './route-utils.js';
 *   // 同步 handler
 *   res.writeHead(200, JSON_HEADER); res.end(ok({ data }));
 *   // 异步 handler
 *   try { ...; json(res, 200, data); } catch (e) { jsonErr(res, e); }
 */

import type { ServerResponse } from 'node:http';

export const JSON_HEADER = { 'Content-Type': 'application/json; charset=utf-8' };

/** 构造 JSON 成功响应 */
export function ok<T>(data: T): string {
  return JSON.stringify({ ok: true, ...(data as any) });
}

/** 构造 JSON 错误响应 */
export function err(message: string, code = 500): string {
  return JSON.stringify({ ok: false, error: message, code });
}

/** 快速写入 JSON 响应 */
export function json<T>(res: ServerResponse, status: number, data: T): void {
  res.writeHead(status, JSON_HEADER);
  res.end(JSON.stringify(data));
}

/** 统一异常处理 */
export function jsonErr(res: ServerResponse, e: unknown, context?: string): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (context) console.warn(`[${context}]`, msg);
  res.writeHead(500, JSON_HEADER);
  res.end(err(msg));
}

/** 读取请求 body */

/** Phase 5: 统一路由包装器 — CORS + JSON parse + try/catch → 500
 *  使用: wrapRoute(res, async () => { ... return data; })
 *  或: wrapRoute(res, () => { ... return data; }, '模块名') */
export async function wrapRoute<T>(res: ServerResponse, handler: () => Promise<T> | T, context?: string): Promise<void> {
  try {
    const data = await handler();
    if (data !== undefined) {
      res.writeHead(200, JSON_HEADER);
      res.end(JSON.stringify(data));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (context) console.warn(`[${context}]`, msg);
    res.writeHead(500, JSON_HEADER);
    res.end(err(msg));
  }
}

/** Phase 5: 同步版本 — 提供 JSON 响应 + 自动 CORS/错误处理 */
export function wrapSync<T>(res: ServerResponse, fn: () => T, context?: string): void {
  wrapRoute(res, async () => fn(), context);
}
export function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
