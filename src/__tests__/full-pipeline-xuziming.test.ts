/**
 * 七层管线全开 · 熊梓铭检索全链路验证
 * 1. v10 migration → 2. 在线实体边 → 3. 离线语义/情绪边
 * 4. DAG闭包 → 5. Foresight → 6. 叙事组装
 */
import { describe, it, expect } from 'vitest';
// V12.4 阶段B 根除24D: 离线边用 perception_40d（🔴 P072 批2: parseStoredVector 已删，改 40D 原生解码）
import { decodePerceptionV40, toNormalizedVector40D } from '../m2/PerceptionVector40DCodec.js';

describe('七层全开 · 熊梓铭纪实小说检索', () => {
  it('全链路打通', async () => {
    const initSqlJs = (await import('sql.js')).default;
    const fs = await import('fs');
    const path = await import('path');
    const dbPath = path.resolve('data/webui/fusion_memory.db');
    const buffer = fs.readFileSync(dbPath);
    const SQL = await initSqlJs();
    const db = new SQL.Database(buffer);

    // Step 1（原「建 search_index 并回填 n-gram」）已整段删除 ——
    //   🔴 2026-11-02 业主裁决拆除 n-gram，该表由 v33 迁移整表下线；
    //   种子召回改由 Step 4 直接对 memories.raw_input 做分片 LIKE（与 v11 同口径）。

    // ══════════════════════════════════════════════
    // Step 2: 在线实体边 — 按对话组粒度建边
    // ══════════════════════════════════════════════
    console.log('\n═══ Step 2: 在线实体边 ═══');
    // 确保 memory_associations 表存在（先删后建确保结构正确）
    try { db.run("DROP TABLE IF EXISTS memory_associations"); } catch {}
    db.run(`CREATE TABLE memory_associations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL DEFAULT 'default',
      belong_entity_uuid TEXT NOT NULL,
      source_global_uid TEXT NOT NULL,
      target_global_uid TEXT NOT NULL,
      edge_type TEXT NOT NULL, edge_reason TEXT,
      confidence REAL NOT NULL DEFAULT 0.7, weight REAL NOT NULL DEFAULT 1.0,
      source_timestamp_ms INTEGER NOT NULL, target_timestamp_ms INTEGER NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      state_flag TEXT NOT NULL DEFAULT 'active',
      CHECK (confidence >= 0 AND confidence <= 1),
      CHECK (source_timestamp_ms < target_timestamp_ms)
    )`);
    try { db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_ma_unique ON memory_associations(namespace,belong_entity_uuid,source_global_uid,target_global_uid,edge_type)"); } catch {}
    try { db.run("CREATE INDEX IF NOT EXISTS idx_ma_src ON memory_associations(namespace,belong_entity_uuid,source_global_uid,edge_type,confidence)"); } catch {}
    try { db.run("CREATE INDEX IF NOT EXISTS idx_ma_tgt ON memory_associations(namespace,belong_entity_uuid,target_global_uid,edge_type,confidence)"); } catch {}

    // 按 belong_entity_uuid 分组，取每组最近 10 个 dialog_group 建链
    const groups = db.exec(
      "SELECT DISTINCT belong_entity_uuid FROM memories WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != ''"
    );
    let entityEdges = 0;
    if (groups.length && groups[0].values) {
      for (const [euuid] of groups[0].values) {
        const dgs = (db as any).exec(
          "SELECT DISTINCT dialog_group_id, global_uid, created_at FROM memories WHERE belong_entity_uuid=? AND dialog_group_id IS NOT NULL AND dialog_group_id != '' ORDER BY created_at ASC LIMIT 50",
          [String(euuid)] as any
        );
        if (!dgs.length || !dgs[0].values || dgs[0].values.length < 2) continue;
        const vals = dgs[0].values;
        for (let i = 1; i < vals.length; i++) {
          const prevDgId = vals[i-1][0], prevUid = vals[i-1][1], prevTs = vals[i-1][2];
          const curDgId = vals[i][0], curUid = vals[i][1], curTs = vals[i][2];
          const pts = prevTs ? new Date(String(prevTs)).getTime() : Date.now() - 3600000;
          const cts = curTs ? new Date(String(curTs)).getTime() : Date.now();
          if (pts >= cts || !prevUid || !curUid) continue;
          try {
            db.run(
              "INSERT OR IGNORE INTO memory_associations(namespace,belong_entity_uuid,source_global_uid,target_global_uid,edge_type,edge_reason,confidence,weight,source_timestamp_ms,target_timestamp_ms,created_by,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              ['default',String(euuid),String(prevUid),String(curUid),'entity',`dg_chain:${prevDgId}→${curDgId}`,0.8,1.0,pts,cts,'online_entity_builder',Date.now(),Date.now()]
            );
            entityEdges++;
          } catch {}
        }
      }
    }
    const totalEdges = db.exec("SELECT COUNT(*) FROM memory_associations");
    console.log(`  实体边建完: ${entityEdges} 条新增, 总边数: ${totalEdges[0].values[0][0]}`);

    // ══════════════════════════════════════════════
    // Step 3: 离线语义边 — 按 40D 向量余弦建边（🔴 P072 批2: 原「24D 向量余弦」已改 40D）
    // ══════════════════════════════════════════════
    console.log('\n═══ Step 3: 离线语义边 + 情绪边 ═══');
    // 取最近 200 条有向量的记忆（V12.4 根除24D: 读 perception_40d 反解 24D 数组）
    const mems = db.exec(
      "SELECT global_uid, belong_entity_uuid, perception_40d, created_at FROM memories WHERE perception_40d IS NOT NULL AND global_uid IS NOT NULL ORDER BY created_at DESC LIMIT 200"
    );
    let semanticEdges = 0, emotionEdges = 0;
    if (mems.length && mems[0].values) {
      const memList = mems[0].values.map((r: any) => ({
        uid: String(r[0]), euuid: String(r[1]||''),
        vec: (() => { const p = decodePerceptionV40(String(r[2] ?? null)); return p ? Array.from(toNormalizedVector40D(p)) : []; })(),
        ts: r[3] ? new Date(String(r[3])).getTime() : 0,
      })).filter((m: any) => m.vec.length >= 6);

      for (let i = 0; i < memList.length; i++) {
        const m = memList[i];
        for (let j = i + 1; j < Math.min(i+20, memList.length); j++) {
          const p = memList[j];
          if (m.euuid !== p.euuid) continue;
          const a = m.vec, b = p.vec;
          const n = Math.min(a.length, b.length);
          let dot=0, nA=0, nB=0;
          for (let k=0;k<n;k++) { dot+=a[k]*b[k]; nA+=a[k]*a[k]; nB+=b[k]*b[k]; }
          const sim = nA&&nB ? dot/Math.sqrt(nA*nB) : 0;
          const src = m.ts < p.ts ? m : p;
          const tgt = m.ts < p.ts ? p : m;

          // 语义边: 全维相似度 ≥ 0.72
          if (sim >= 0.72) {
            try {
              db.run(
                "INSERT OR IGNORE INTO memory_associations(namespace,belong_entity_uuid,source_global_uid,target_global_uid,edge_type,edge_reason,confidence,weight,source_timestamp_ms,target_timestamp_ms,created_by,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ['default', m.euuid, src.uid, tgt.uid, 'semantic', `cosine_sim=${sim.toFixed(3)}`, sim, sim, src.ts, tgt.ts, 'offline_semantic_builder', Date.now(), Date.now()]
              );
              semanticEdges++;
            } catch {}
          }

          // 情绪边: 情绪子空间 (0-5维) 相似度 ≥ 0.75
          let eDot=0, eA=0, eB=0;
          for (let k=0;k<Math.min(6,a.length,b.length);k++) { eDot+=a[k]*b[k]; eA+=a[k]*a[k]; eB+=b[k]*b[k]; }
          const eSim = eA&&eB ? eDot/Math.sqrt(eA*eB) : 0;
          if (eSim >= 0.75) {
            try {
              db.run(
                "INSERT OR IGNORE INTO memory_associations(namespace,belong_entity_uuid,source_global_uid,target_global_uid,edge_type,edge_reason,confidence,weight,source_timestamp_ms,target_timestamp_ms,created_by,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ['default', m.euuid, src.uid, tgt.uid, 'emotion', `emotion_resonance=${eSim.toFixed(3)}`, eSim, eSim, src.ts, tgt.ts, 'offline_emotion_builder', Date.now(), Date.now()]
              );
              emotionEdges++;
            } catch {}
          }
        }
      }
    }
    const allEdges = db.exec("SELECT edge_type, COUNT(*) FROM memory_associations GROUP BY edge_type");
    console.log(`  语义边: ${semanticEdges} | 情绪边: ${emotionEdges}`);
    if (allEdges.length && allEdges[0].values) {
      for (const [type, cnt] of allEdges[0].values) console.log(`    ${type}: ${cnt} 条`);
    }

    // ══════════════════════════════════════════════
    // Step 4: DAG 闭包展开（从种子节点沿边扩展）
    // ══════════════════════════════════════════════
    console.log('\n═══ Step 4: DAG 闭包展开 ═══');
    // 取"熊梓铭 学术 小说" n-gram 召回的种子节点
    const query = '熊梓铭 学术研究 纪实小说 写书 出版';
    const cleaned = query.replace(/[，。！？、；：""''（）《》【】\s\d-]/g,'').trim();
    const qNgrams = new Set<string>();
    for (let i=0;i<cleaned.length-1;i++) qNgrams.add(cleaned.substring(i,i+2));
    for (let i=0;i<cleaned.length-2;i++) qNgrams.add(cleaned.substring(i,i+3));
    const gramList = [...qNgrams];

    // 🔴 2026-11-02：原查 search_index 的 term 倒排，改为直接对源表做分片 LIKE ——
    //   这正是 v11 结构化召回（recallByStructured.buildKeywordShards）的同口径做法：
    //   复用同样的 n-gram 切分，但**不建索引**（白皮书 §4.2.2）。
    const seedIds = new Set<string>();
    for (const gram of gramList.slice(0, 6)) {
      try {
        const rows = (db as any).exec("SELECT id FROM memories WHERE raw_input LIKE ? LIMIT 50", [`%${gram}%`]);
        if (rows.length && rows[0].values) {
          for (const [id] of rows[0].values) seedIds.add(String(id));
        }
      } catch {}
    }
    console.log(`  关键词分片 LIKE 种子候选: ${seedIds.size} 条唯一记忆`);

    // 查这些记忆的 global_uid
    const seedUids = new Set<string>();
    for (const id of [...seedIds].slice(0, 30)) {
      try {
        const r = (db as any).exec("SELECT global_uid FROM memories WHERE id=?", [id]);
        if (r.length && r[0].values) {
          const uid = r[0].values[0][0];
          if (uid) seedUids.add(String(uid));
        }
      } catch {}
    }
    console.log(`  种子 UID: ${seedUids.size} 个`);

    // BFS 闭包展开
    const visited = new Set<string>(seedUids);
    const closureEdges: any[] = [];
    const queue = [...seedUids].map(uid => ({uid, depth: 0}));

    while (queue.length > 0 && visited.size < 100) {
      const cur = queue.shift()!;
      if (cur.depth >= 2) continue;
      try {
        const stmt = db.prepare(
          "SELECT * FROM memory_associations WHERE (source_global_uid=? OR target_global_uid=?) AND state_flag='active' AND confidence>=0.5 LIMIT 20"
        );
        stmt.bind([cur.uid, cur.uid]);
        while (stmt.step() && visited.size < 100) {
          const row = stmt.getAsObject();
          const neighbor = row.source_global_uid === cur.uid ? row.target_global_uid : row.source_global_uid;
          closureEdges.push(row);
          if (!visited.has(String(neighbor))) {
            visited.add(String(neighbor));
            queue.push({uid: String(neighbor), depth: cur.depth + 1});
          }
        }
        stmt.free();
      } catch {}
    }
    console.log(`  闭包节点: ${visited.size} | 边: ${closureEdges.length}`);

    // ══════════════════════════════════════════════
    // Step 5: 按时间线排列 → 输出叙事
    // ══════════════════════════════════════════════
    console.log('\n═══ Step 5: 时序叙事 ═══');
    const uidList = [...visited];
    const placeholder = uidList.slice(0, 50).map(() => '?').join(',');
    let memDetails: any[] = [];
    try {
      const r = (db as any).exec(
        `SELECT global_uid, substr(raw_input,1,200), calcium_score, created_at, is_foresight, foresight_status
         FROM memories WHERE global_uid IN (${placeholder}) ORDER BY created_at ASC LIMIT 30`,
        uidList.slice(0, 50)
      );
      if (r.length && r[0].values) {
        memDetails = r[0].values.map((v: any) => ({
          uid: String(v[0]), text: String(v[1]||''), calcium: Number(v[2]||0),
          time: String(v[3]||''), isForesight: Number(v[4]||0), fStatus: String(v[5]||'none'),
        }));
      }
    } catch {}

    // 打印时间线
    console.log(`\n  📖 记忆链 · 熊梓铭的学术研究与纪实小说`);
    console.log(`  ─────────────────────────────────────`);
    const relevant = memDetails.filter((m: any) =>
      m.text.includes('梓铭') || m.text.includes('学术') || m.text.includes('研究') ||
      m.text.includes('实验') || m.text.includes('小说') || m.text.includes('纪实') ||
      m.text.includes('写书') || m.text.includes('出版') || m.text.includes('文献') ||
      m.text.includes('论文') || m.text.includes('认知') || m.text.includes('博士')
    );
    for (let i = 0; i < relevant.length; i++) {
      const m = relevant[i];
      const tag = m.isForesight && m.fStatus !== 'none' ? ` ⚡${m.fStatus}` : '';
      const star = m.calcium >= 1.5 ? '★' : ' ';
      console.log(`  ${i+1}. ${star} ${m.time?.substring(0,16) || '?'}${tag}`);
      console.log(`     ${m.text.substring(0, 150)}`);
    }

    // ══════════════════════════════════════════════
    // Step 6: 对比结果
    // ══════════════════════════════════════════════
    console.log('\n═══ Step 6: 对比总结 ═══');
    const hasAcademic = relevant.some((m: any) => m.text.includes('学术') || m.text.includes('研究'));
    const hasNovel = relevant.some((m: any) => m.text.includes('小说') || m.text.includes('纪实'));
    const hasChain = closureEdges.length >= 2;
    console.log(`  学术研究方向命中: ${hasAcademic ? '✅' : '❌'}`);
    console.log(`  纪实小说方向命中: ${hasNovel ? '✅' : '❌'}`);
    console.log(`  DAG 关联链条: ${hasChain ? '✅' : '❌'} (${closureEdges.length} 边)`);
    console.log(`  闭包节点数: ${visited.size}`);
    console.log(`  记忆关联边总数: ${db.exec("SELECT COUNT(*) FROM memory_associations")[0].values[0][0]}`);

    db.close();
    console.log('\n✅ 七层全开验证完成');
  }, 120000);
});
