/**
 * server-memory-routes — 记忆/提醒路由
 *
 * 从 server.ts 拆分。wenstar-cx 风格。
 * 包含：/api/memory (CRUD), /api/memory/reminders, /api/memory/ack-reminder,
 *       /api/memory/stats, /api/memory/lock, /api/memory/tag,
 *       /api/memory/emotion/:emotion, /api/memory/search
 */
import http from 'node:http';
import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';
import type { YuyaoMemoryService } from '../app/yuyao-memory/YuyaoMemoryService.js';

type MemoryRouteDeps = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  storage: FusionStorageAdapter;
  yuyaoMemory: YuyaoMemoryService;
  readBody(req: http.IncomingMessage): Promise<string>;
};

export async function handleMemoryRoutes(deps: MemoryRouteDeps): Promise<boolean> {
  const { req, res, url, storage, yuyaoMemory, readBody } = deps;

  // ── 记忆写入（存储/提醒/事实） ──
  if (req.method === 'POST' && url.pathname === '/api/memory') {
    try {
      const body = JSON.parse(await readBody(req));
      const { type, key, value, remind_at, repeat_rule } = body;
      if (!type || !key || !value) { res.writeHead(400); res.end(JSON.stringify({ error: 'type, key, value required' })); return true; }
      switch (type) {
        case 'object_location': yuyaoMemory.storeObjectLocation(key, value); break;
        case 'fact': yuyaoMemory.storeFact(key, value); break;
        case 'reminder': yuyaoMemory.setReminder(value, remind_at || new Date(Date.now() + 3600000).toISOString(), repeat_rule); break;
        default: res.writeHead(400); res.end(JSON.stringify({ error: 'unknown type' })); return true;
      }
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message })); }
    return true;
  }

  // ── 记忆搜索 ──
  if (req.method === 'GET' && url.pathname === '/api/memory') {
    try {
      const q = url.searchParams.get('q') || '';
      const results = yuyaoMemory.search(q);
      res.writeHead(200); res.end(JSON.stringify({ results }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message })); }
    return true;
  }

  // ── 待触发提醒列表 ──
  if (req.method === 'GET' && url.pathname === '/api/memory/reminders') {
    try {
      const reminders = yuyaoMemory.getPendingReminders();
      res.writeHead(200); res.end(JSON.stringify({ reminders }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message })); }
    return true;
  }

  // ── 确认提醒 ──
  if (req.method === 'POST' && url.pathname === '/api/memory/ack-reminder') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.id) { res.writeHead(400); res.end(JSON.stringify({ error: 'id required' })); return true; }
      yuyaoMemory.markReminded(body.id);
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message })); }
    return true;
  }

  // ── 金库统计 ──
  if (req.method === 'GET' && url.pathname === '/api/memory/stats') {
    const stats = storage.getSQLite().getGoldStats();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(stats));
    return true;
  }

  // ── 按ID获取记忆 ──
  if (req.method === 'GET' && url.pathname.startsWith('/api/memory/') && url.pathname !== '/api/memory/stats' && !url.pathname.startsWith('/api/memory/emotion/') && !url.pathname.startsWith('/api/memory/search') && url.pathname !== '/api/memory/reminders') {
    const id = decodeURIComponent(url.pathname.substring('/api/memory/'.length));
    const mem = storage.getSQLite().getMemoryById(id);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(mem || { error: 'not found' }));
    return true;
  }

  // ── 锁定记忆 ──
  if (req.method === 'POST' && url.pathname === '/api/memory/lock') {
    try { const body = JSON.parse(await readBody(req)); const r = storage.getSQLite().lockMemory(body.id); res.writeHead(200); res.end(JSON.stringify({ ok: r })); }
    catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message })); }
    return true;
  }

  // ── 标记记忆 ──
  if (req.method === 'POST' && url.pathname === '/api/memory/tag') {
    try { const body = JSON.parse(await readBody(req)); const r = storage.getSQLite().tagMemory(body.id, body.tag); res.writeHead(200); res.end(JSON.stringify({ ok: r })); }
    catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message })); }
    return true;
  }

  // ── 删除记忆 ──
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/memory/')) {
    const id = decodeURIComponent(url.pathname.substring('/api/memory/'.length));
    const r = storage.getSQLite().deleteMemory(id);
    res.writeHead(200); res.end(JSON.stringify({ ok: r }));
    return true;
  }

  // ── 按情感查找记忆 ──
  if (req.method === 'GET' && url.pathname.startsWith('/api/memory/emotion/')) {
    const emotion = decodeURIComponent(url.pathname.substring('/api/memory/emotion/'.length));
    const mems = storage.getSQLite().findByEmotion(emotion, 20);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ count: mems.length, memories: mems }));
    return true;
  }

  // ── 记忆全文搜索 ──
  if (req.method === 'GET' && url.pathname === '/api/memory/search') {
    const keyword = url.searchParams.get('q') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 100);
    const mems = storage.getSQLite().queryAll('SELECT id, raw_input, primary_emotion, calcium_score, calcium_level, effective_strength, created_at FROM memories WHERE raw_input LIKE ? ORDER BY created_at DESC LIMIT ?', ['%' + keyword + '%', limit]);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ count: mems.length, memories: mems }));
    return true;
  }

  return false;
}
