/**
 * server-brain-routes.ts — 玉瑶第二大脑 HTTP API
 * ================================================
 * 将第二大脑的四大能力暴露为 HTTP 接口。
 *
 * GET  /api/brain/profile    → 用户认知画像（JSON）
 * POST /api/brain/report     → 专题知识报告
 * POST /api/brain/answer     → 大脑增强回答
 * GET  /api/brain/digest     → 画像摘要（自然语言）
 */
import http from 'node:http';
import { BrainOutputService } from '../engine/tianquan/temporal/BrainOutputService.js';

type BrainRouteDeps = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  storage?: any;
  knowledgeBase: any;
  masterProfile?: any;
  readBody(req: http.IncomingMessage): Promise<string>;
};

export async function handleBrainRoutes(deps: BrainRouteDeps): Promise<boolean> {
  const { req, res, url, storage, knowledgeBase, masterProfile, readBody } = deps;

  // ── 用户认知画像 ──
  // ── 用户认知画像 ──
  if (req.method === 'GET' && url.pathname === '/api/brain/profile') {
    try {
      if (!storage) throw new Error('storage 未就绪');
      const sqlite = storage.getSQLite();
      if (!sqlite) throw new Error('SQLite 未就绪');
      const { UserCognitiveProfile } = await import('../app/profile/UserCognitiveProfile.js');
      const profile = new UserCognitiveProfile(sqlite, knowledgeBase);
      const result = await profile.synthesize();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '画像暂不可用', detail: (err as Error).message }));
    }
    return true;
  }

  // ── 专题知识报告 ──
  if (req.method === 'POST' && url.pathname === '/api/brain/report') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.topic) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'topic required' }));
        return true;
      }
      if (!storage) throw new Error('storage 未就绪');
      const sqlite = storage.getSQLite();
      const brain = new BrainOutputService(sqlite, knowledgeBase, masterProfile);
      const report = await brain.generateReport({
        topic: body.topic,
        format: body.format || 'summary',
        maxSources: body.maxSources || 10,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(report));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // ── 大脑增强回答 ──
  if (req.method === 'POST' && url.pathname === '/api/brain/answer') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.query) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'query required' }));
        return true;
      }
      if (!storage) throw new Error('storage 未就绪');
      const sqlite = storage.getSQLite();
      const brain = new BrainOutputService(sqlite, knowledgeBase, masterProfile);
      const answer = await brain.answer(body.query);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ query: body.query, answer, sources: answer ? answer.split('\n').length : 0 }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // ── 画像摘要 ──
  if (req.method === 'GET' && url.pathname === '/api/brain/digest') {
    try {
      if (!storage) throw new Error('storage 未就绪');
      const sqlite = storage.getSQLite();
      const brain = new BrainOutputService(sqlite, knowledgeBase, masterProfile);
      const digest = await brain.generateProfileDigest();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ digest }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ digest: '玉瑶还在了解你的路上，再多聊聊天吧。' }));
    }
    return true;
  }

  // ── V4.0 Phase 4: 玉瑶最近学习 ──
  if (req.method === 'GET' && url.pathname === '/api/brain/recent-learnings') {
    try {
      const sqlite = storage?.getSQLite?.();
      if (!sqlite) { res.writeHead(500); res.end(JSON.stringify({ error: 'storage unavailable' })); return true; }
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const rows = sqlite.queryAll(
        "SELECT id, raw_input, created_at, calcium_score, recall_count, effective_strength FROM memories WHERE source_type = 'knowledge_vault' AND lifecycle_state = 'active' ORDER BY created_at DESC LIMIT ?",
        [limit]
      );
      const items = (rows || []).map((r: any) => ({
        id: r.id, summary: (r.raw_input || '').substring(0, 120),
        createdAt: r.created_at, calcium: r.calcium_score,
        recalled: r.recall_count, strength: r.effective_strength,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ total: items.length, items }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
    return true;
  }

  return false;
}
