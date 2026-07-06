/**
 * server-observability-routes — 可观测性路由
 *
 * 从 server.ts 拆分，wenstar-cx 风格：单个对象参数，统一 return boolean
 * 包含：/events, /api/status, /api/health, /api/alignment,
 *       /api/inductions, /api/landscape, /api/mirror, /api/modules
 */
import http from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bionic } from '../adapter/bionic-adapter.js';

export type ObservabilityRouteDeps = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  storage: any;
  familyGraph: any;
  conversationHistory: any[];
  maintenance: any;
  m6: any;
  m7: any;
  m8: any;
  clueTracker: any;
  topicTracker: any;
  alignmentGuard: any;
  inductionScheduler: any;
  masterProfile: any;
  getSelfModel: () => any;
  sseClients: Set<http.ServerResponse>;
  /** 🏗️ 防复发第二层: 角色扮演状态 */
  getRoleplayStatus?: () => { active: boolean; role: string | null; class: string | null; turns: number };
  orchestrator?: { getMode: () => string } | null;
  hybridSearch?: { getDiagnostics?: () => { ready: boolean; embedderStatus: string }; isReady?: () => boolean } | null;
  enableNewArch?: boolean;
};

export async function handleObservabilityRoutes(
  deps: ObservabilityRouteDeps,
): Promise<boolean> {
  const {
    req, res, url,
    storage, familyGraph, conversationHistory, maintenance,
    m6, m7, m8, clueTracker, topicTracker, alignmentGuard,
    inductionScheduler, masterProfile, getSelfModel, sseClients,
    orchestrator, hybridSearch, enableNewArch,
  } = deps;

  // ── SSE 实时推送 ──
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('event: connected\ndata: {"status":"ok"}\n\n');
    sseClients.add(res);
    req.on('close', function() { sseClients.delete(res); });
    return true;
  }

  // ── 系统状态 ──
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const storageStatus = await storage.getStatus().catch(() => null);
    const familySummary = await familyGraph.getFamilySummary().catch(() => ({ members: [], locations: [] }));
    const hybrid = hybridSearch?.getDiagnostics?.() ?? {
      ready: hybridSearch?.isReady?.() ?? false,
      embedderStatus: 'unknown',
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'running', version: '0.1.0',
      conversation_turns: Math.floor(conversationHistory.length / 2),
      runtime: {
        enable_new_arch: !!enableNewArch,
        orchestrator_mode: orchestrator?.getMode?.() ?? null,
        hybrid_search: hybrid,
      },
      storage: storageStatus ? {
        total_records: storageStatus.totalRecords,
        zone_counts: storageStatus.zoneCounts,
        seq_pos: storageStatus.currentSeqPos,
      } : null,
      family: { members: familySummary.members.map((m: any) => ({ name: m.name, relation: m.relation_to_user })), total: familySummary.members.length },
    }));
    return true;
  }

  // ── 健康检查（含持久化健康度 + 文件健康度监控，改造③+⑥）──
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const health = maintenance.getHealth();
    const storageStatus = await storage.getStatus().catch(() => null);
    if (storageStatus) health.storage.totalRecords = storageStatus.totalRecords;
    const decayStats = storage.getDecayStats();
    const m8st = storage.getSQLite().getStatus();
    let alignmentSummary: { score: number; status: string } | null = null;
    try {
      const _ar = alignmentGuard.getCachedReport();
      if (_ar) alignmentSummary = { score: _ar.score, status: _ar.status };
    } catch (e: any) { console.error('[Observability] error:', e?.message); }
    let _pSimple: any = { userCount: 0, assistantCount: 0, ratio: '0' };
    let _chatAlert: string | null = null;
    try {
      const _mdb = storage.getSQLite();
      const _uc = _mdb.queryAll('SELECT COUNT(*) as cnt FROM memories WHERE leaf_zone=?', ['user']);
      const _ac = _mdb.queryAll('SELECT COUNT(*) as cnt FROM memories WHERE leaf_zone=?', ['assistant']);
      const uc = Number((_uc[0] as any)?.cnt ?? 0);
      const ac = Number((_ac[0] as any)?.cnt ?? 0);
      _pSimple = { userCount: uc, assistantCount: ac, ratio: ac > 0 ? (uc / ac).toFixed(2) : '0' };
      const _oFile = fileURLToPath(import.meta.url);
      const _chatPath = join(dirname(dirname(_oFile)), 'webui', 'chat.ts');
      if (existsSync(_chatPath) && statSync(_chatPath).size > 100 * 1024) {
        _chatAlert = 'chat.ts 超过100KB';
      }
    } catch (_pe) { /* stats not critical */ }
    // 🏗️ 防复发第二层: 角色扮演健康状态
    let _rpStatus: any = { active: false };
    try {
      if (deps.getRoleplayStatus) {
        const _rps = deps.getRoleplayStatus();
        _rpStatus = { active: _rps.active, role: _rps.role, class: _rps.class, turns: _rps.turns };
      }
    } catch (_rpe) { /* roleplay status not critical */ }
    const hybrid = hybridSearch?.getDiagnostics?.() ?? {
      ready: hybridSearch?.isReady?.() ?? false,
      embedderStatus: 'unknown',
    };
    let bionicStatus = bionic.getHealthSnapshot();
    if (bionicStatus.reachable === null) {
      const reachable = await bionic.health().catch(() => false);
      bionicStatus = {
        reachable,
        cached: true,
        lastCheckedAt: Date.now(),
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ...health,
      alignment: alignmentSummary,
      memory: { ...health.memory, decay: decayStats, landmarks: m8st.landmarks, entities: m8st.totalEntities },
      persistence: _pSimple,
      chatFileAlert: _chatAlert,
      roleplay: _rpStatus,
      runtime: {
        enableNewArch: !!enableNewArch,
        orchestratorMode: orchestrator?.getMode?.() ?? null,
        hybridSearch: hybrid,
        bionic: bionicStatus,
      },
    }));
    return true;
  }

  // ── 向量对齐巡检 ──
  if (req.method === 'GET' && url.pathname === '/api/alignment') {
    try {
      alignmentGuard.registerDependencies({
        getSqlite: () => storage.getSQLite() as any,
        getMemoriesCount: () => { try { const sql = storage.getSQLite(); const r = sql.queryAll('SELECT COUNT(*) as c FROM memories'); return (r[0] as any)?.c || 0; } catch { return 0; } },
        getConversationHistoryLen: () => conversationHistory.length,
      });
      const repair = req.url?.includes('repair=true') || req.url?.includes('auto=true');
      let result = alignmentGuard.fullCheck();
      if (repair && result.status !== 'healthy') {
        const fixed = alignmentGuard.autoRepair();
        result = alignmentGuard.fullCheck();
        result.recommendations.unshift('🛠️ 自动修复: ca_level=' + fixed.caLevelFixed + ', strength=' + fixed.strengthFixed);
      }
      const verbose = !!req.url?.includes('verbose=true');
      const payload: any = { ...result };
      if (verbose) { payload.auditLog = alignmentGuard.getAuditLogs(20); payload.turnCounter = alignmentGuard.getTurnCounter(); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
    }
    return true;
  }

  // ── 归纳历史 ──
  if (req.method === 'GET' && url.pathname === '/api/inductions') {
    const inductions = inductionScheduler?.getInductions() ?? [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ total: inductions.length, inductions }));
    return true;
  }

  // ── 情感地形图 ──
  if (req.method === 'GET' && url.pathname === '/api/landscape') {
    const landscape = storage.getEmotionalLandscape();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(landscape));
    return true;
  }

  // ── 主人镜像 ──
  if (req.method === 'GET' && url.pathname === '/api/mirror') {
    const result: Record<string, any> = {};
    try {
      result.profile = storage.getSQLite().queryAll('SELECT category, content, confidence FROM master_profile ORDER BY confidence DESC LIMIT 20');
      result.affairs = storage.getSQLite().queryAll("SELECT title, category, status FROM master_affairs WHERE status != 'abandoned' ORDER BY updated_at DESC LIMIT 10");
      result.network = storage.getSQLite().queryAll('SELECT person_name, relation_type, organization FROM master_network ORDER BY importance DESC LIMIT 10');
      result.events = storage.getSQLite().queryAll('SELECT title, event_type, date FROM master_events ORDER BY created_at DESC LIMIT 10');
      result.about_you = masterProfile.retrieveAboutYou(10);
    } catch (err) { result.error = (err as Error).message; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return true;
  }

  // ── M6-M8 模块数据 ──
  if (req.method === 'GET' && url.pathname === '/api/modules') {
    const m6Model = m6?.getModel();
    const m6Traits = m6?.getTraits() ?? getSelfModel().traits;
    const m6Prefs = m6?.getPreferences() ?? [];
    const m6Bounds = m6?.getBoundaries() ?? [];
    const m6Layers = m6?.getNarrativeLayers() ?? [];
    const m7Pending = m7?.queue?.getPending() ?? [];
    const m7All = m7?.queue?.getByStatus?.('confirmed') ?? [];
    const m7Logs = clueTracker?.getLogs() ?? [];
    const dreamDiamondCount = storage.getSQLite().queryAll("SELECT COUNT(*) as c FROM black_diamond WHERE tags LIKE '%dream_%'") as any[];
    const dreamTags = storage.getSQLite().queryAll("SELECT id, summary, emotion_tag FROM black_diamond WHERE tags LIKE '%dream_%' ORDER BY created_at DESC LIMIT 5") as any[];
    const landscape = storage.getEmotionalLandscape();
    const m8Status = storage.getSQLite().getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      m6: { traits: m6Traits, preferences: m6Prefs.slice(0, 10), boundaries: m6Bounds.slice(0, 10), narrative_layers: m6Layers.slice(0, 5), version: m6Model?.version ?? '1.0' },
      m7: { pending_dreams: m7Pending.slice(0, 10), total_pending: m7Pending.length, total_confirmed: m7All.length, interaction_logs: m7Logs.slice(-10), total_logs: m7Logs.length, research_stats: topicTracker?.getStats?.() ?? {}, dream_analysis: { total_dream_entries: dreamDiamondCount?.[0]?.c ?? 0, recent_entries: (dreamTags ?? []).map((r: any) => ({ id: r.id, summary: (r.summary || '').substring(0, 80), emotion: r.emotion_tag || '未分类' })) } },
      m8: { total_entries: m8Status.landmarks, total_scars: landscape.scars.length, healed_scars: 0, unhealed_scars: landscape.scars.length, recent_entries: landscape.peaks.slice(0, 5).map((p: any) => ({ id: p.id, sensory_anchor: p.snippet?.substring(0, 20) ?? '', created_at: p.created_at, narrative_tag: p.narrative_tag ?? '日常', calcium: p.calcium })) },
    }));
    return true;
  }

  return false;
}
