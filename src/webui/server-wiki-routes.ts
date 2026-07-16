/**
 * server-wiki-routes.ts — 第二大脑 Wiki API (V4.0 Phase 4)
 * ==========================================================
 * 对接 SecondBrainGateway，暴露知识库 MD 文件的 CRUD 端点。
 *
 * GET  /api/knowledge-v4/wiki/list         → 文件清单
 * GET  /api/knowledge-v4/wiki/read?path=   → 读取单个文件
 * GET  /api/knowledge-v4/wiki/backlinks?keyword= → 反向链接查询
 * GET  /api/knowledge-v4/wiki/stats        → 索引统计
 */

import type { ServerResponse } from 'node:http';
import { JSON_HEADER } from './route-utils.js';

export interface WikiRouteDeps {
  res: ServerResponse;
  url: URL;
}

export function handleWikiRoutes(deps: WikiRouteDeps): boolean {
  const { res, url } = deps;
  const gw = (globalThis as any).__secondBrainGateway;
  const resolver = (globalThis as any).__wikiLinkResolver;

  // ── 文件清单 ──
  if (url.pathname === '/api/knowledge-v4/wiki/list') {
    if (!gw) { res.writeHead(503, JSON_HEADER); res.end('{"error":"第二大脑未就绪"}'); return true; }
    try {
      const files = gw.scanWikiMDFiles();
      const typeFilter = url.searchParams.get('type');
      const items = files
        .filter((f: any) => !typeFilter || f.type === typeFilter)
        .map((f: any) => ({
          uuid: f.uuid, path: f.path, title: f.title, type: f.type,
          tags: f.tags, updatedAt: f.updatedAt, indexStatus: f.indexStatus,
          confidence: f.confidence,
        }));
      res.writeHead(200, JSON_HEADER);
      res.end(JSON.stringify({ total: items.length, items }));
    } catch (e) { res.writeHead(500, JSON_HEADER); res.end(JSON.stringify({ error: (e as Error).message })); }
    return true;
  }

  // ── 读取单个文件 ──
  if (url.pathname === '/api/knowledge-v4/wiki/read') {
    const filePath = url.searchParams.get('path');
    if (!filePath) { res.writeHead(400, JSON_HEADER); res.end('{"error":"缺少 path 参数"}'); return true; }
    if (!gw) { res.writeHead(503, JSON_HEADER); res.end('{"error":"第二大脑未就绪"}'); return true; }
    try {
      const entry = gw.getWikiEntry(filePath);
      if (!entry) { res.writeHead(404, JSON_HEADER); res.end(JSON.stringify({ error: '文件不存在' })); return true; }
      res.writeHead(200, JSON_HEADER);
      res.end(JSON.stringify({
        manifest: {
          uuid: entry.manifest.uuid, path: entry.manifest.path, title: entry.manifest.title,
          type: entry.manifest.type, tags: entry.manifest.tags, aliases: entry.manifest.aliases,
          sha256: entry.manifest.sha256, createdAt: entry.manifest.createdAt,
          updatedAt: entry.manifest.updatedAt, confidence: entry.manifest.confidence,
          claimType: entry.manifest.claimType, wikilinks: entry.manifest.wikilinks,
        },
        summary: entry.summary,
        content: entry.content.substring(0, 10000), // 前 10KB
        relations: entry.relations,
        backlinks: entry.backlinks,
      }));
    } catch (e) { res.writeHead(500, JSON_HEADER); res.end(JSON.stringify({ error: (e as Error).message })); }
    return true;
  }

  // ── 反向链接查询 ──
  if (url.pathname === '/api/knowledge-v4/wiki/backlinks') {
    const keyword = url.searchParams.get('keyword');
    if (!keyword) { res.writeHead(400, JSON_HEADER); res.end('{"error":"缺少 keyword 参数"}'); return true; }
    try {
      const bls = resolver && typeof resolver.getBacklinks === 'function'
        ? resolver.getBacklinks(keyword)
        : gw ? gw.queryByWikilink(keyword).map((m: any) => m.path) : [];
      res.writeHead(200, JSON_HEADER);
      res.end(JSON.stringify({ keyword, count: bls.length, backlinks: bls }));
    } catch (e) { res.writeHead(500, JSON_HEADER); res.end(JSON.stringify({ error: (e as Error).message })); }
    return true;
  }

  // ── 索引统计 ──
  if (url.pathname === '/api/knowledge-v4/wiki/stats') {
    if (!gw) { res.writeHead(503, JSON_HEADER); res.end('{"error":"第二大脑未就绪"}'); return true; }
    try {
      const stats = gw.getStats();
      res.writeHead(200, JSON_HEADER);
      res.end(JSON.stringify(stats));
    } catch (e) { res.writeHead(500, JSON_HEADER); res.end(JSON.stringify({ error: (e as Error).message })); }
    return true;
  }

  return false;
}
