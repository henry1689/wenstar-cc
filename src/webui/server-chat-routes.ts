/**
 * server-chat-routes.ts — Chat/重置/状态 API 端点 (从 server.ts 拆出)
 * /api/chat | recall | purge-test | prefer-candidate | stream | clear |
 * /api/reset | status | conversation
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';
import type { FamilyGraph } from '../m4/household/FamilyGraph.js';
import type { ChatResponse, ChatContext } from './chat.js';

export interface ChatRouteDeps {
  processChat: (message: string, clientMsgId?: string | null, testMode?: boolean) => Promise<ChatResponse>;
  resetPipeline: () => Promise<void>;
  conversationHistory: any[];
  conversationDB: any;
  storage: FusionStorageAdapter;
  familyGraph: FamilyGraph;
  m6: any;
  maintenance: any;
  DATA_DIR: string;
  PROJECT_ROOT: string;
  PROJECT_DIR: string;
  saveConversationHistory: () => void;
  listApiKeys: () => any[];
  setApiKey: (name: string, value: string) => void;
  deleteApiKey: (name: string) => void;
  getApiKey: (name: string) => string | undefined;
}

export async function handleChatRoutes(deps: ChatRouteDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { processChat, resetPipeline, conversationHistory, conversationDB, storage, familyGraph, m6, maintenance, DATA_DIR, PROJECT_ROOT, PROJECT_DIR } = deps;

  // ── 聊天 ──
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const body = JSON.parse(await readBody(req));
    if (!body.message || typeof body.message !== 'string') { res.writeHead(400); res.end(JSON.stringify({ error: 'message required' })); return true; }
    const _rpMsg = body.message.trim();
    const _rpM = _rpMsg.match(/(?:扮演(?:一下)?|模仿|演一下|cos)[了]?([一-龥]{2,8})/);
    let _rpPass = body.client_msg_id;
    if (_rpM && _rpM[1].trim().length >= 2) {
      _rpPass = '【角色扮演】' + _rpM[1].replace(/[吧呗了试试看看一下玩玩]$/, '').trim() + '||' + (_rpPass || '');
    }
    const result = await processChat(_rpMsg, _rpPass, body.test_mode === true);

    // TTS 生成
    let audio_url: string | null = null;
    const reply = result.reply || '';
    if (body.tts !== false && reply && reply.length < 500 && reply.length > 1) {
      try {
        const _fn = 'tts_' + Date.now().toString(36) + '.mp3';
        const _fp = path.join(DATA_DIR, 'audio', _fn);
        const _env = { ...process.env, NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' };
        await execFileAsync('edge-tts', ['--text', reply, '--voice', 'zh-CN-XiaoxiaoNeural', '--write-media', _fp], { timeout: 30000, env: _env });
        if (fs.existsSync(_fp)) { audio_url = '/audio/' + _fn; }
      } catch { /* TTS optional */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...result, audio_url }));
    return true;
  }

  // ── 撤回消息 ──
  if (req.method === 'POST' && url.pathname === '/api/chat/recall') {
    try {
      const body = JSON.parse(await readBody(req));
      const messageId = body.message_id;
      if (!messageId) { res.writeHead(400); res.end(JSON.stringify({ error: 'message_id required', ok: false })); return true; }
      const idx = (conversationHistory as any[]).findIndex((t: any) => t.id === messageId);
      if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: '消息不存在或已撤回', ok: false })); return true; }
      const entry = (conversationHistory as any)[idx];
      if (Date.now() - new Date(entry.timestamp).getTime() > 30000) { res.writeHead(410); res.end(JSON.stringify({ error: '超过30秒，无法撤回', ok: false })); return true; }
      if (entry.role !== 'user') { res.writeHead(400); res.end(JSON.stringify({ error: '只能撤回自己的消息', ok: false })); return true; }
      conversationHistory.splice(idx, 1);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message, ok: false })); }
    return true;
  }

  // ── 清除测试对话 ──
  if (req.method === 'POST' && url.pathname === '/api/chat/purge-test') {
    try {
      const sqlite = storage.getSQLite();
      if (sqlite) {
        sqlite.writeRaw("BEGIN");
        sqlite.writeRaw("DELETE FROM conversations WHERE is_test=1");
        const result = sqlite.queryAll("SELECT changes() as cnt");
        const count = (result[0]?.cnt || 0) as number;
        try {
          const rows = sqlite.queryAll("SELECT role, content, timestamp FROM conversations WHERE is_test = 0 OR is_test IS NULL ORDER BY rowid DESC LIMIT 100");
          sqlite.writeRaw("COMMIT");
          if (rows.length > 0) {
            deps.conversationHistory.length = 0;
            deps.conversationHistory.push(...rows.reverse().map(r => ({ role: r.role as 'user' | 'assistant', content: r.content as string, timestamp: r.timestamp as string })));
          }
        } catch (e) { sqlite.writeRaw("ROLLBACK"); throw e; }
        res.writeHead(200); res.end(JSON.stringify({ ok: true, deleted: count }));
      } else { res.writeHead(200); res.end(JSON.stringify({ ok: true, deleted: 0 })); }
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err), ok: false })); }
    return true;
  }

  // ── 候选回复偏好 ──
  if (req.method === 'POST' && url.pathname === '/api/chat/prefer-candidate') {
    try {
      const body = JSON.parse(await readBody(req));
      if (m6 && body.tags && Array.isArray(body.tags)) {
        for (const tag of body.tags) { m6.prefs.recordMention(tag, 0.8); }
      }
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (err) { res.writeHead(200); res.end(JSON.stringify({ ok: false })); }
    return true;
  }

  // ── 聊天 SSE 流式 ──
  if (req.method === 'GET' && url.pathname === '/api/chat/stream') {
    const rawMessage = url.searchParams.get('message') || '';
    if (!rawMessage) { res.writeHead(400); res.end(JSON.stringify({ error: 'message required' })); return true; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write(`: keepalive\n\n`);
    res.flushHeaders?.();
    const result = await processChat(rawMessage.trim());
    const rps = result.reply || '';
    const sentences = rps.split(/(?<=[。！？\n])/g).filter(Boolean).map((s: string) => s.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(sentences.length, 3); i++) {
      res.write(`data: ${JSON.stringify({ type: 'text', content: sentences[i] })}\n\n`);
      await new Promise(r => setTimeout(r, 400 + Math.random() * 200));
    }
    if (sentences.length > 3) {
      res.write(`data: ${JSON.stringify({ type: 'text', content: sentences.slice(3).join('') })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: 'done', content: rps })}\n\n`);
    res.end();
    return true;
  }

  // ── 清除对话历史（仅清前端缓存，不动数据库） ──
  if (req.method === 'POST' && url.pathname === '/api/chat/clear') {
    try {
      // 只清内存中的 conversationHistory，不删数据库
      deps.conversationHistory.length = 0;
      deps.saveConversationHistory();
      console.log('[Clear] 前端缓存已清除');
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
    return true;
  }

  // ── 重置 ──
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    maintenance.stop();
    await resetPipeline();
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok', message: '已重置' }));
    return true;
  }

  // ── 状态 ──
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const storageStatus = await storage.getStatus().catch(() => null);
    const familySummary = await familyGraph.getFamilySummary().catch(() => ({ members: [], locations: [] }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'running', version: '0.1.0',
      conversation_turns: Math.floor(conversationHistory.length / 2),
      storage: storageStatus ? { total_records: storageStatus.totalRecords, zone_counts: storageStatus.zoneCounts, seq_pos: storageStatus.currentSeqPos } : null,
      family: { members: familySummary.members.map((m: any) => ({ name: m.name, relation: m.relation_to_user })), total: familySummary.members.length },
    }));
    return true;
  }

  // ── 对话历史（优先返回 conversationHistory，被清除后返回空） ──
  if (req.method === 'GET' && url.pathname === '/api/conversation') {
    try {
      // 🔑 优先返回内存中的 conversationHistory（尊重用户清除操作）
      //    如果内存为空（用户点过清除按钮或新窗口），不再回退到数据库
      if (deps.conversationHistory.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ turns: [] }));
        return true;
      }
      const turns = deps.conversationHistory
        .filter((t: any) => t.role === 'user' || t.role === 'assistant')
        .map((t: any) => ({ role: t.role, content: t.content, timestamp: t.timestamp }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ turns }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message })); }
    return true;
  }

  return false;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
