/**
 * server-tianquan-routes.ts — 天权域 API 端点 (从 server.ts 拆出)
 * /api/tianquan/status | dispatch | lint | arch | sql-audit | snapshot | specs
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MasterHarris, SpecLoadResult } from '../tianquan/index.js';

export interface TianquanRouteDeps {
  masterHarris: MasterHarris | null;
  specLoadResults: SpecLoadResult[];
  projectRoot: string;
  readBody: (req: IncomingMessage) => Promise<string>;
}

export async function handleTianquanRoutes(deps: TianquanRouteDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { masterHarris, specLoadResults, projectRoot, readBody } = deps;

  // ── 状态 ──
  if (req.method === 'GET' && url.pathname === '/api/tianquan/status') {
    if (!masterHarris) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'initializing', error: 'MasterHarris 启动中，请等待30秒后刷新', tianquanReady: false, busConnected: false }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(masterHarris.getStatus()));
    return true;
  }

  // ── 调度 ──
  if (req.method === 'POST' && url.pathname === '/api/tianquan/dispatch') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.message) { res.writeHead(400); res.end(JSON.stringify({ error: 'message 必填' })); return true; }
      if (!masterHarris) { res.writeHead(503); res.end(JSON.stringify({ error: '天权离线' })); return true; }
      const result = await masterHarris.dispatch({ userMessage: body.message, description: body.description, constraints: body.constraints, projectRoot: body.project_root || projectRoot });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
    return true;
  }

  // ── lint ──
  if (req.method === 'POST' && url.pathname === '/api/tianquan/lint') {
    try {
      if (!masterHarris?.tianquanReady) { res.writeHead(503); res.end(JSON.stringify({ error: '天权离线' })); return true; }
      const body = JSON.parse(await readBody(req));
      const report = await masterHarris.lintCheck(body.project_root || projectRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
    return true;
  }

  // ── arch ──
  if (req.method === 'POST' && url.pathname === '/api/tianquan/arch') {
    try {
      if (!masterHarris?.tianquanReady) { res.writeHead(503); res.end(JSON.stringify({ error: '天权离线' })); return true; }
      const body = JSON.parse(await readBody(req));
      const report = await masterHarris.archParse(body.project_root || projectRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
    return true;
  }

  // ── sql-audit ──
  if (req.method === 'POST' && url.pathname === '/api/tianquan/sql-audit') {
    try {
      if (!masterHarris?.tianquanReady) { res.writeHead(503); res.end(JSON.stringify({ error: '天权离线' })); return true; }
      const body = JSON.parse(await readBody(req));
      const report = await masterHarris.sqlAudit({ sql_text: body.sql_text, file_path: body.file_path });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
    return true;
  }

  // ── snapshot ──
  if (req.method === 'POST' && url.pathname === '/api/tianquan/snapshot') {
    try {
      if (!masterHarris?.tianquanReady) { res.writeHead(503); res.end(JSON.stringify({ error: '天权离线' })); return true; }
      const body = JSON.parse(await readBody(req));
      const snap = await masterHarris.generateSnapshot(body.project_root || projectRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snap));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
    return true;
  }

  // ── specs ──
  if (req.method === 'GET' && url.pathname === '/api/tianquan/specs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ spec_load_results: specLoadResults }));
    return true;
  }

  return false; // not a tianquan route
}
