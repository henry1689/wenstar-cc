import http from 'node:http';

type KnowledgeRouteDeps = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  knowledgeBase: any;
  storage?: any;
  readBody(req: http.IncomingMessage): Promise<string>;
};

export async function handleKnowledgeRoutes(deps: KnowledgeRouteDeps): Promise<boolean> {
  const { req, res, url, knowledgeBase, readBody } = deps;

  if (req.method === 'POST' && url.pathname === '/api/knowledge/reindex') {
    try {
      const count = await knowledgeBase.reindexAll();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, count }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/knowledge/vector-search') {
    const q = url.searchParams.get('q') || '';
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'q required' }));
      return true;
    }
    const engine = knowledgeBase?.engine || knowledgeBase;
    const provider = engine.embedProvider;
    if (!provider?.isAvailable?.()) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ hits: [], note: '嵌入 API 不可用，请设置 DEEPSEEK_API_KEY' }));
      return true;
    }
    const queryVec = await provider.embed(q);
    if (!queryVec.length) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ hits: [], note: '嵌入返回空向量' }));
      return true;
    }
    const hits = engine.vectorSearchDebug(queryVec, 10);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ query: q, hits }));
    return true;
  }

  if (url.pathname === '/api/knowledge') {
    if (req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const keyword = url.searchParams.get('search') || '';
      const interactionType = url.searchParams.get('interaction_type') || '';
      let list;
      if (interactionType) list = knowledgeBase.searchByInteraction(interactionType, limit);
      else if (keyword) list = await knowledgeBase.search(keyword, limit);
      else list = knowledgeBase.list(limit);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ total: list.length, items: list }));
      return true;
    }

    if (req.method === 'POST') {
      // 🔴 2026-09-19 修复（用户可见故障：知识库创建“卡住”+ 连带服务死亡）：
      //   原先这里是**裸 await**，而 `KnowledgeEngine.createKnowledge` 的来源策略守卫会 `throw`
      //   （合法 source_type 仅 FILE_SOURCE_TYPES ∪ ANALYSIS_SOURCE_TYPES，`text` 等一律拒绝）
      //   ⇒ 抛错无处可去 ⇒ **响应永不返回（挂起）** + 未处理 rejection；
      //   每个挂起请求泄漏一个 socket + pending promise，累积会压垮进程。
      //   现改为“可见失败”：已知客户端错误（来源策略/隐私守卫）→ 400，其余 → 500，均记日志。
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.title || !body.content) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'title and content required' }));
          return true;
        }
        const entry = await knowledgeBase.add({
          title: body.title,
          content: body.content,
          source_type: body.source_type ?? 'text',
          source_name: body.source_name ?? null,
          file_size: body.file_size ?? 0,
          tags: body.tags ?? [],
          interaction_type: body.interaction_type,
          scene_tags: body.scene_tags,
          classification: body.classification,
        });
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(entry));
      } catch (e: any) {
        const msg = String(e?.message || e);
        const isClientError = /不可入库|隐私内容不可存/.test(msg);
        // 🔴 2026-09-19：`DEDUP_SKIP` 是**去重守卫的正常拒绝**（内容重复），不是服务错误
        //   ⇒ 映射为 409 Conflict（而不是 500），便于调用方区分“重复”与“真故障”。
        const isDedup = /DEDUP_SKIP/.test(msg);
        const code = isDedup ? 409 : isClientError ? 400 : 500;
        console.error('[server-knowledge] POST /api/knowledge 失败(' + code + '):', msg);
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(isDedup ? { error: msg, dedup: true, existing: (e as any)?.dedup ?? null } : { error: msg }));
      }
      return true;
    }

    if (req.method === 'DELETE') {
      // 🔴 2026-09-19 修复：原先 `knowledgeBase.delete()` **既未 await 也无 catch** ——
      //   若该方法是异步的，失败会变成未处理 rejection；若它抛错则请求挂起。现补 await + 兜底。
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.id) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'id required' }));
          return true;
        }
        const ok = await knowledgeBase.delete(body.id);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: ok ? 'deleted' : 'not_found' }));
      } catch (e: any) {
        console.error('[server-knowledge] DELETE /api/knowledge 失败:', String(e?.message || e));
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(e?.message || e) }));
      }
      return true;
    }
  }

  // 🔴 2026-09-19 修复：原正则只认 `kn_` 前缀，而 `KnowledgeEngine` 生成的 id 实际为
  //   `DNAEncoder.generateGlobalUID('WK', …)` ⇒ `WK5157…` 一类，**永不匹配**
  //   ⇒ PUT（更新）与 GET by-id（单条读取）**恒 404**（功能早已失效）。
  //   另：库内还有 sem_/sysc_/topic_/ps_/kv_/conf_ 等多种前缀（各子系统写入）—— 故改为通用 id 形态；
  //   存在性校验由 `getById()` / `update()` 自身负责（不存在仍返回 404，语义不变）。
  //   ⚠️ 必须**排除保留子路径**（dashboard 在本文件里位于 knMatch 之后、upload/excel-query 由
  //   server-knowledge-file-routes 处理且分发顺序在后）—— 否则会被当成 id 而 404 / 遮蔽。
  const knMatch = url.pathname.match(/^\/api\/knowledge\/(?!dashboard$|upload$|excel-query$)([A-Za-z0-9_]+)$/);
  if (knMatch && req.method === 'GET') {
    const entry = knowledgeBase.getById(knMatch[1]);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(entry));
    return true;
  }

  if (knMatch && req.method === 'PUT') {
    // 🔴 2026-09-19 修复：同 POST —— 裸 await + JSON.parse 均在裸区，抛错即“挂起”。现补兜底。
    try {
      const body = JSON.parse(await readBody(req));
      const ok = await knowledgeBase.update(knMatch[1], {
        title: body.title, content: body.content, tags: body.tags, locked: body.locked,
      });
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: ok ? 'updated' : 'not_found_or_locked' }));
    } catch (e: any) {
      console.error('[server-knowledge] PUT /api/knowledge 失败:', String(e?.message || e));
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return true;
  }

  // ── 知识库仪表盘 ──
  if (req.method === 'GET' && url.pathname === '/api/knowledge/dashboard') {
    try {
      const total = (typeof knowledgeBase.count === 'function') ? knowledgeBase.count() : 0;
      const items = (typeof knowledgeBase.list === 'function') ? knowledgeBase.list(5) : [];
      let growthRate = 0, distillYield = 0, decayRate = 0;
      let growthLog: any[] = [];
      try {
        const { KnowledgeGrowthLogger } = await import('../app/learning/KnowledgeGrowthLogger.js');
        const logger = new KnowledgeGrowthLogger(deps.storage);
        const metrics = await logger.getHealthMetrics();
        growthRate = metrics.growthRate;
        distillYield = metrics.distillYield;
        decayRate = metrics.decayRate;
        growthLog = await logger.query({ limit: 10 });
      } catch (e) { console.warn(`[server-knowledge] 操作失败`, (e as Error)?.message || e); }
      const rows = items.map(function(i: any) {
        return '<tr><td>' + (i.title || '').substring(0, 40) + '</td><td style="color:#7a6a80">' + ((i as any).classification || '-') + '</td></tr>';
      }).join('');
      const isColdStart = total === 0;
      const emptyHint = isColdStart
        ? '<div style="background:#1c1530;border:1px solid #2a1e35;border-radius:8px;padding:20px;margin-bottom:16px;text-align:center"><div style="font-size:28px;margin-bottom:8px">🌱</div><div style="font-size:13px;color:#e8a0b4;font-weight:600;margin-bottom:6px">知识库正在萌芽</div><div style="font-size:10px;color:#7a6a80;line-height:1.6">每一次对话都会自动沉淀知识。<br>和我聊天吧——你的偏好、习惯、回忆，会慢慢长成一片属于你的知识森林。</div></div>'
        : '';
      const tableSection = isColdStart
        ? '<div class="emp">暂无条目 — 聊起来就有了</div>'
        : '<table><tr><th>标题</th><th>分类</th></tr>' + rows + '</table>';
      const rowDisplay = isColdStart ? 0 : items.length;
      const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>知识库 · 生命体征</title>'
        + '<style>body{background:#0d0812;color:#f0e0e8;font-family:-apple-system,"PingFang SC",sans-serif;padding:20px;font-size:13px}'
        + 'h1{font-size:16px;font-weight:600;background:linear-gradient(90deg,#f0e0e8,#e8a0b4);-webkit-background-clip:text;margin-bottom:16px}'
        + '.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px}'
        + '.c{background:#15101e;border:1px solid #2a1e35;border-radius:8px;padding:14px}'
        + '.c .v{font-size:22px;font-weight:700;color:#e8a0b4}.c .l{font-size:9px;color:#7a6a80;margin-top:2px}'
        + 'h2{font-size:11px;font-weight:600;color:#b8a0b0;margin:16px 0 8px}'
        + 'table{width:100%;border-collapse:collapse;font-size:11px}'
        + 'th,td{padding:4px 7px;text-align:left;border-bottom:1px solid #1c1530}'
        + 'th{color:#7a6a80;font-size:8px;text-transform:uppercase}'
        + 'td{color:#d0c0d0}'
        + '.sy{background:#0d0812;border:1px solid #1c1530;border-radius:6px;padding:8px 10px;margin-top:6px;font-size:10px}'
        + '.sy .k{color:#7a6a80;font-size:8px;text-transform:uppercase}.sy .v{color:#d0c0d0;margin-top:2px}'
        + '.hl{border-left:2px solid #e8a0b4;padding-left:8px;font-size:10px;color:#b8a0b0;margin:12px 0;line-height:1.6}'
        + '</style></head><body>'
        + '<h1>&#x1F4CA; 知识库</h1>'
        + '<div class="g"><div class="c"><div class="v">' + total + '</div><div class="l">总条目</div></div>' + '<div class="c"><div class="v">' + items.length + '</div><div class="l">已加载</div></div>' + '<div class="c"><div class="v">' + (growthRate*100).toFixed(1) + '%</div><div class="l">生长速率</div></div>' + '<div class="c"><div class="v">' + distillYield + '</div><div class="l">梦境洞察</div></div></div>'
        + '<div class="c"><div class="v">' + items.length + '</div><div class="l">已加载</div></div></div>'
        + emptyHint + '<h2>&#x1F4DC; 最近</h2>' + tableSection + '<h2>&#x1F4CA; 生长日志</h2>' + (growthLog.length > 0
    ? '<table style="margin-top:6px"><tr><th>阶段</th><th>内容</th><th>时间</th></tr>' + growthLog.map(function(g: any) {
        var gc = ({sprout:'🌱',branch:'🌿',lignify:'🌳',ring:'🪵',prune:'✂️',feedback:'🔄'} as any)[g.event_type] || '📄';
        return '<tr><td style="font-size:12px">' + gc + ' ' + g.event_type + '</td><td>' + g.detail.substring(0,60) + '</td><td style="color:#7a6a80;font-size:9px">' + new Date(g.created_at).toLocaleString().substring(5,16) + '</td></tr>';
    }).join('') + '</table>'
    : '<div class="emp">暂无生长数据 — 聊起来就有了</div>')
        + '<h2>&#x2699;&#xFE0F; 运行时</h2>'
        + '<div class="sy"><div class="k">检索引擎</div><div class="v">BM25 + Zvec HNSW</div></div>'
        + '<div class="sy"><div class="k">情感感知</div><div class="v">32D 扇区加权余弦</div></div>'
        + '<div class="sy"><div class="k">自学习</div><div class="v">AutoLearn V2 &#xB7; 实体 &#xB7; 情感 &#xB7; 冲突</div></div>'
        + '<div class="sy"><div class="k">生命周期</div><div class="v">六阶生长链 &#xB7; 衰减 &#xB7; 反哺 M6</div></div>'
        + '<div class="hl">&#x1F4A1; 知识库是会生长的。</div></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('error'); }
    return true;
  }

  return false;
}
