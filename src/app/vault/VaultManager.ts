/**
 * VaultManager — 三库管理器 · 景幻仙姑
 *
 * 管理三个记忆库的全生命周期：
 *   砂金库 (Alluvial)  — 原始对话历史，可压缩
 *   金库   (Gold)      — 24D情感记忆，日常检索
 *   黑钻库 (BlackDiamond) — 精选歌单，永恒珍藏
 *
 * 景幻仙姑的职责：
 *   - 巡检三库健康状态
 *   - 从金库→黑钻库提炼
 *   - 响应管理员指令
 *   - 生成健康报告
 */
import type { FusionStorageAdapter } from '../../m2/FusionStorageAdapter.js';
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import type { ConversationTurn } from '../../m5/types/index.js';
import { MEMORY_CONFIG } from '../../config/MemoryConfig.js';
// V12.4 阶段B 根除24D: perception_json 列已删，金库写入用 40D 默认向量 / 提炼读 40D 列
import { encodeEmptyPerceptionV40, decodePerceptionV40 } from '../../m2/PerceptionVector40DCodec.js';
// 2026-09-13 ②-1补漏: 归属脏值净化唯一入口（本文件原有 2 处 `x || null` 回查透传，挡不住字符串 'null'）
import { sanitizeBelongUuid } from './belong-uuid.js';
import { isMetaDiscourse } from '../../config/ingestion-guard.js';

// ─── 类型定义 ───

export interface AlluvialEntry {
  /** 对话轮次文本摘要 */
  content: string;
  role: 'user' | 'assistant';
  timestamp?: string;
}

export interface GoldEntry {
  id: string;
  summary: string;
  calcium_level: number;
  effective_strength: number;
  recall_count: number;
  emotion_tag?: string;
  created_at: string;
}

export interface BlackDiamondEntry {
  id: string;
  summary: string;
  emotion_tag: string | null;
  source_id: string | null;
  calcium_level: number;
  recall_count: number;
  tags: string[];
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface VaultReport {
  timestamp: string;
  alluvial: { total: number; oldestAgeHours: number; compressible: boolean; compressedAt: string | null };
  gold: { total: number; avgStrength: number; highCalciumCount: number; topTags: string[] };
  blackDiamond: { total: number; recentEntries: string[] };
  overall: string;
  trends?: {
    gold_growth_7d: number;
    promote_count_7d: number;
    avg_strength_change: number;
    health_score: number;
    health_status: string;
    narrative: string;
  };
  alerts?: string[];
}

export interface DiamondPromotionDecision {
  eligible: boolean;
  reason: string | null;
  targetState: 'candidate' | 'promoted';
}

type DiamondDuplicateMatch = {
  id: string;
  summary: string;
  emotion_tag: string | null;
  tags: string[];
  notes: string;
  calcium_level: number;
};

// ─── 操作日志 ───

/** 记录三库操作（景幻仙姑审计日志） */
export function logVaultOperation(
  sqlite: SQLiteAdapter,
  operation: string,
  sourceType?: string,
  sourceId?: string,
  targetId?: string,
  detail?: string,
  contentMd?: string,
  belongEntityUuid?: string | null,
): void {
  // 🔴 2026-09-16 数据卫生: 元对话/自我陈述不进金库日志
  //    本函数是金库写入唯一收口，任何路径（自动晋升/批量操作/巡检提炼）必经此处。
  if (isMetaDiscourse(detail) || isMetaDiscourse(contentMd)) {
    console.log('[VaultManager] 金库写入拦截: 命中元对话规则，不入 vault_log');
    return;
  }
  const id = 'vl_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
  // V13: 写入 belong_entity_uuid — 确保金库记忆可被 UUID 检索系统找到
  // ②-1补漏(2026-09-13): 入参与回查值都过净化 —— 原 `x || null` 挡不住字符串 'null'（真值），
  //   源记忆带脏值时会把 'null' 原样搬进 vault_log。
  let euuid = sanitizeBelongUuid(belongEntityUuid) ?? null;
  if (!euuid && sourceId) {
    try {
      const mem = sqlite.queryAll("SELECT belong_entity_uuid FROM memories WHERE id = ?", [sourceId]) as any[];
      if (mem.length > 0) euuid = sanitizeBelongUuid(mem[0]?.belong_entity_uuid) ?? null;
    } catch { /* 回查失败不阻塞 */ }
  }
  sqlite.writeRaw(
    'INSERT INTO vault_log (id, operation, source_type, source_id, target_id, detail, content_md, created_at, belong_entity_uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, operation, sourceType || null, sourceId || null, targetId || null, detail || null, contentMd || null, new Date().toISOString(), euuid,
  );
}

/** 获取操作日志 */
export function getVaultLog(sqlite: SQLiteAdapter, limit = 20): any[] {
  return sqlite.queryAll('SELECT * FROM vault_log ORDER BY created_at DESC LIMIT ?', [limit]);
}

// ─── 黑钻库数据访问 ───

/** 列出黑钻库所有条目 */
export function listBlackDiamonds(sqlite: SQLiteAdapter, limit = 20, offset = 0): BlackDiamondEntry[] {
  const rows = sqlite.queryAll(
    'SELECT * FROM black_diamond ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset],
  );
  return rows.map(rowToBlackDiamond);
}

/** 按ID查黑钻条目 */
export function getBlackDiamond(sqlite: SQLiteAdapter, id: string): BlackDiamondEntry | null {
  const rows = sqlite.queryAll('SELECT * FROM black_diamond WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0 ? rowToBlackDiamond(rows[0]) : null;
}

/**
 * dna_root_id 脏值净化（与 belong 同一口径）。
 * 🔴 2026-09-19 批 4：原先只净化了「回查分支」，**调用方显式传入的 params.dna_root_id 没过净化**
 *   → 源记忆带字符串 'null'/'undefined'/空串时仍会落库（与同文件 :215-217 记录的 belong 脏值事故同源）。
 *   现两个分支共用本函数。
 */
function sanitizeDnaRootId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' || s === 'null' || s === 'undefined' ? null : s;
}

/** 新增黑钻条目 */
export function addBlackDiamond(
  sqlite: SQLiteAdapter,
  params: {
    summary: string;
    emotion_tag?: string;
    source_id?: string;
    calcium_level?: number;
    tags?: string[];
    notes?: string;
    emotion_vector?: string;
    dna_root_id?: string | null;
    promotion_reason?: string;
    namespace?: string;
  },
): BlackDiamondEntry {
  // 🔴 2026-09-16 数据卫生: 元对话/自我陈述不允许固化进黑钻（fail-closed 最后防线）
  if (isMetaDiscourse(params.summary) || isMetaDiscourse(params.notes)) {
    console.warn('[VaultManager] 黑钻写入拦截: 命中元对话规则，拒绝固化');
    throw new Error('META_DISCOURSE_REJECTED: 元对话/自我陈述不允许固化进黑钻');
  }
  const id = `bd_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();
  const tags = params.tags || [];
  // 黑钻上限（从配置读取）：超出时淘汰钙化分最低的
  try {
    const total = (sqlite.queryAll('SELECT COUNT(*) as cnt FROM black_diamond') as any[])?.[0]?.cnt || 0;
    if (total >= MEMORY_CONFIG.blackDiamond.maxCount) {
      const lowest = sqlite.queryAll('SELECT id, calcium_level FROM black_diamond ORDER BY CAST(calcium_level AS REAL) ASC, created_at ASC LIMIT 1') as any[];
      if (lowest.length > 0) {
        const demotedId = lowest[0].id;
        sqlite.writeRaw(
          `UPDATE memories
           SET promoted_to_diamond = 0,
               lifecycle_state = 'active',
               promotion_reason = NULL
           WHERE id = (SELECT source_id FROM black_diamond WHERE id = ?)`,
          demotedId,
        );
        sqlite.writeRaw('DELETE FROM black_diamond WHERE id = ?', demotedId);
        console.log('[Vault] 黑钻超出上限(200)，降级: ' + demotedId);
      }
    }
  } catch (_) { /* 上限检测不阻塞晋升 */ }
  if (params.source_id) {
    sqlite.writeRaw(
      `UPDATE memories
       SET promoted_to_diamond = 1,
           lifecycle_state = 'promoted',
           promotion_reason = ?,
           last_verified_at = ?
       WHERE id = ?`,
      params.promotion_reason || 'black_diamond_promotion', now, params.source_id,
    );
  }
  // 🔧 V10.1: 从 emotion_vector JSON 实时计算 l2_norm
  let _l2norm: number | null = null;
  if (params.emotion_vector) {
    try {
      const _vec = JSON.parse(params.emotion_vector as string);
      if (Array.isArray(_vec) && _vec.length >= 24) {
        let _sq = 0;
        for (let _i = 0; _i < 24; _i++) { const _v = Number(_vec[_i]) || 0; _sq += _v * _v; }
        _l2norm = Math.round(Math.sqrt(_sq) * 10000) / 10000;
      }
    } catch { /* 解析失败则 l2_norm=NULL */ }
  }
  // V13: 回查 memories.belong_entity_uuid 确保黑钻标注实体归属
  // 🔴 ②-1补漏(2026-09-13): 实测传播点 —— 原 `memRow[0]?.belong || null` 挡不住字符串 'null'，
  //   源记忆带脏值时黑钻继承 'null'（取证：4 条脏黑钻的 source_id 全部回查为 typeof=text 的 'null'；
  //   清库后重启即重现，正是此处再次回查所致）。
  let _bdeuuid: string | null = null;
  // 🔴 2026-09-19 批 2：回查**一次取两列** —— 归属与溯源锚点同源继承。
  //   dna_root_id 原不在列清单里 → 实测全库 0/390（其中 251 行有 source_id、247 行可从源记忆回填）。
  //   注意区分：fg_sync 路径（FamilyGraph 同步）的 source_id 恒 null，dna 本就无从获取，
  //   那是**合法 unowned**，由 D8v2 的 column-present 豁免（entry_channel 指纹）识别，不是本条。
  let _bdDnaRootId: string | null = null;
  if (params.source_id) {
    try {
      const memRow = sqlite.queryAll('SELECT belong_entity_uuid, dna_root_id FROM memories WHERE id = ?', [params.source_id]) as any[];
      _bdeuuid = sanitizeBelongUuid(memRow?.[0]?.belong_entity_uuid) ?? null;
      // 与 belong 同一脏值净化口径：源记忆带字符串 'null'/空串时不继承
      const _rawDna = memRow?.[0]?.dna_root_id;
      _bdDnaRootId = (_rawDna === null || _rawDna === undefined || String(_rawDna).trim() === '' || String(_rawDna).trim() === 'null')
        ? null
        : String(_rawDna);
    } catch { /* 回查不阻塞 */ }
  }
  sqlite.writeRaw(
    `INSERT INTO black_diamond (id, summary, emotion_tag, source_id, calcium_level, recall_count, tags, notes, created_at, updated_at, emotion_vector, l2_norm, namespace, belong_entity_uuid, dna_root_id)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    params.summary,
    params.emotion_tag || null,
    params.source_id || null,
    params.calcium_level ?? 1,
    JSON.stringify(tags),
    params.notes || '',
    now,
    now,
    params.emotion_vector || null,
    _l2norm,
    params.namespace || 'default',
    _bdeuuid,
    // 用户裁决 A′（2026-09-19）：补真实写入 + 保留 D8v2 登记。
    //   索引 idx_black_diamond_dna_root_id 已由 MigrationManager 显式创建（schema 作者已定此列可查），
    //   当前仅「消费方待落地」—— 不得因此放任 0/390 永存。
    //   🔴 批 4：调用方分支补上净化（原先只有回查分支净化 ⇒ 显式传入的脏值会直接落库）。
    sanitizeDnaRootId(params.dna_root_id) ?? _bdDnaRootId,
  );
  return getBlackDiamond(sqlite, id)!;
}

/** 更新黑钻条目 */
export function updateBlackDiamond(
  sqlite: SQLiteAdapter,
  id: string,
  params: { summary?: string; emotion_tag?: string; tags?: string[]; notes?: string },
): boolean {
  const existing = getBlackDiamond(sqlite, id);
  if (!existing) return false;
  const now = new Date().toISOString();
  sqlite.writeRaw(
    `UPDATE black_diamond SET summary=?, emotion_tag=?, tags=?, notes=?, updated_at=? WHERE id=?`,
    params.summary ?? existing.summary,
    params.emotion_tag ?? existing.emotion_tag,
    JSON.stringify(params.tags ?? existing.tags),
    params.notes ?? existing.notes,
    now,
    id,
  );
  return true;
}

/** 删除黑钻条目 */
export function deleteBlackDiamond(sqlite: SQLiteAdapter, id: string): boolean {
  const existing = getBlackDiamond(sqlite, id);
  if (!existing) return false;
  if (existing.source_id) {
    sqlite.writeRaw(
      `UPDATE memories
       SET promoted_to_diamond = 0,
           lifecycle_state = 'active',
           promotion_reason = NULL
       WHERE id = ?`,
      existing.source_id,
    );
  }
  sqlite.writeRaw('DELETE FROM black_diamond WHERE id = ?', id);
  return true;
}

/** 搜索黑钻库 */
const KNOWN_EMOTION_TAGS = MEMORY_CONFIG.knownEmotionTags;

export function searchBlackDiamonds(sqlite: SQLiteAdapter, keyword: string, limit = 10): BlackDiamondEntry[] {
  // P4: Fast path - exact emotion_tag match (uses idx_black_diamond_emotion index)
  const tagMatch = KNOWN_EMOTION_TAGS.find(t => keyword.includes(t));
  if (tagMatch) {
    const rows = sqlite.queryAll(
      `SELECT * FROM black_diamond WHERE emotion_tag = ? ORDER BY created_at DESC LIMIT ?`,
      [tagMatch, limit],
    );
    if (rows.length > 0) return rows.map(rowToBlackDiamond);
  }

  // Fallback: LIKE scan (existing behavior)
  const rows = sqlite.queryAll(
    `SELECT * FROM black_diamond WHERE summary LIKE ? OR emotion_tag LIKE ? OR tags LIKE ? ORDER BY created_at DESC LIMIT ?`,
    [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, limit],
  );
  return rows.map(rowToBlackDiamond);
}

// ─── 金库（memories表）访问 ───

// ═══════════════════════════════════════════════════════
//  V4.0 Phase 3: 第二大脑→金库写入
// ═══════════════════════════════════════════════════════

/**
 * 从第二大脑（知识库 MD）萃取的内容写入金库（memories 表）。
 * 标记 source_type='knowledge_vault' 以区别于对话产生的记忆。
 *
 * @returns 写入的记忆条目 ID，失败返回 null
 */
export function addGoldEntryFromKnowledgeVault(
  sqlite: SQLiteAdapter,
  params: {
    sourcePath: string;
    sourceUuid: string;
    sourceHash: string;
    summary: string;
    tags?: string[];
    confidence?: string;
  },
): string | null {
  try {
    const entryId = `kv_${params.sourceUuid}_${Date.now().toString(36)}`.substring(0, 64);
    const now = new Date().toISOString();

    // 🔴 memories 表有很多 NOT NULL 约束，必须全部提供
    // seq_pos: 使用负数避免与正常对话的 seq_pos 冲突
    // 🔴 2026-09-19 批 5：不再用 `-(Date.now() % 1000000)`（值域周期 ≈16.7 min ⇒ 可撞 UNIQUE(seq_pos)，
    //   在 INSERT OR REPLACE 下会静默删行）。改为从**负值带单调向下**分配（保持原排序语义）。
    const seqPos = Number(
      (sqlite.queryAll('SELECT COALESCE(MIN(seq_pos), 0) - 1 AS mn FROM memories') as any[])?.[0]?.mn ?? -1,
    );
    const locusPath = 'knowledge_vault';
    const leafZone = 'language_semantic_zone';
    // V12.4 阶段B 根除24D: perception_json 列已删，知识卷宗写默认 40D v2（全零，语义等价旧 '{}'）
    const perception40D = encodeEmptyPerceptionV40();

    // 🔴 2026-09-19 批 2：收口到唯一公共写入口 SQLiteAdapter.writeMemory()。
    //   原实现手写 16 列 INSERT（缺 dna_root_id / entity_genes / fg_entity_names / global_uid /
    //   belong_entity_uuid / location_fingerprint 六列）—— 本函数是 memories 的**第二套列清单**。
    //   注：本函数为导出但**零调用方**的死代码；不删除（DS-20 禁止删公共函数），而是收口以消除分叉。
    //   id 含时间戳 → 每次落库都是新行，故 writeMemory 的 INSERT OR REPLACE 与原 INSERT OR IGNORE 实际等价。
    const _kvWritten = sqlite.writeMemory({
      id: entryId,
      seqPos,
      createdAt: now,
      perceptionV40: perception40D,
      calciumScore: 0.5,
      calciumLevel: 1,
      locusPath,
      leafZone,
      rawInput: params.summary.substring(0, 500),
      primaryEmotion: '中性',
      memoryType: 'dialog',
      memoryKind: 'knowledge_vault',
      lifecycleState: 'active',
      // 原手写 SQL 写死 source_type='knowledge_vault'；writeMemory 此前**根本没有该列**（走 DEFAULT
      // 'conversation'）→ 先补齐此参才能收口，否则是静默语义退化。
      sourceType: 'knowledge_vault',
      // 原手写 0.5；writeMemory 此前硬编码 1.0 → 同样必须先补参。
      effectiveStrength: 0.5,
      // 知识卷宗源自 MD 文档（非会晤对话），无户籍主体 → unowned（《UUID 户籍管理法》第七条）
      belongEntityUuid: null,
    });
    if (!_kvWritten) {
      console.warn(`[Vault] 金库入库失败(knowledge_vault): ${entryId.substring(0, 20)}... ← ${params.sourcePath}`);
      return entryId;
    }

    console.log(`[Vault] 金库入库(knowledge_vault): ${entryId.substring(0, 20)}... ← ${params.sourcePath}`);
    return entryId;
  } catch (err) {
    console.warn('[Vault] 金库入库失败:', (err as Error).message);
    return null;
  }
}

/** 金库概况 */
export function getGoldSummary(sqlite: SQLiteAdapter): { total: number; avgStrength: number; highCalcium: number } {
  const rows = sqlite.queryAll(
    `SELECT COUNT(*) as total, AVG(effective_strength) as avgStr, SUM(CASE WHEN calcium_level >= 2 THEN 1 ELSE 0 END) as highCal
     FROM memories`,
  );
  const r = rows[0] || { total: 0, avgStr: 0, highCal: 0 };
  return {
    total: Number(r.total) || 0,
    avgStrength: Number(r.avgStr) || 0,
    highCalcium: Number(r.highCal) || 0,
  };
}

/** 金库最近条目 */
export function listGoldRecent(sqlite: SQLiteAdapter, limit = 10): GoldEntry[] {
  const rows = sqlite.queryAll(
    `SELECT id, raw_input, calcium_level, effective_strength, recall_count, created_at, scar_type
     FROM memories ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map((r: any) => ({
    id: r.id as string,
    summary: (r.raw_input as string).substring(0, 80),
    calcium_level: r.calcium_level as number,
    effective_strength: r.effective_strength as number,
    recall_count: r.recall_count as number,
    emotion_tag: (r.scar_type as string) || undefined,
    created_at: r.created_at as string,
  }));
}

// ─── 砂金库（对话历史）访问 ───

/** 砂金库概况 */
export function getAlluvialSummary(
  conversationHistory: ConversationTurn[],
  maxSize: number,
): { total: number; oldestAgeHours: number; compressible: boolean } {
  let oldestAge = 0;
  for (const t of conversationHistory) {
    if (t.timestamp) {
      const age = (Date.now() - new Date(t.timestamp).getTime()) / 3600000;
      if (age > oldestAge) oldestAge = age;
    }
  }
  return {
    total: conversationHistory.length,
    oldestAgeHours: Math.round(oldestAge),
    compressible: conversationHistory.length > maxSize,
  };
}

// ─── 提炼（金库→黑钻库） ───

/**
 * 从金库提炼到黑钻库
 * 钙质≥2 + (recall≥3 或 钙质==3 或 landmark) → 提炼
 */
export function promoteToBlackDiamond(sqlite: SQLiteAdapter, memoryId: string): BlackDiamondEntry | null {
  // 🔴 2026-09-16 数据卫生: 元对话/自我陈述不晋升黑钻（回查原文作为第一道拦截）
  try {
    const _meta = sqlite.queryAll('SELECT raw_input FROM memories WHERE id = ? LIMIT 1', [memoryId]) as any[];
    if (_meta.length > 0 && isMetaDiscourse(_meta[0]?.raw_input)) {
      console.log('[VaultManager] 黑钻晋升拦截: 命中元对话规则，跳过 ' + memoryId);
      return null;
    }
  } catch { /* 回查失败不阻塞，交由 evaluateDiamondPromotion 兜底 */ }
  // 去重：检查是否已存在
  const existing = sqlite.queryAll(
    `SELECT id FROM black_diamond WHERE source_id = ? LIMIT 1`,
    [memoryId],
  );
  if (existing.length > 0) {
    console.log(`[Vault] 跳过重复提炼: ${memoryId}`);
    return null;
  }

  const rows = sqlite.queryAll(
    `SELECT id, raw_input, calcium_score, calcium_level, recall_count, is_landmark,
            scar_type, narrative_tag, perception_40d, lifecycle_state, promoted_to_diamond,
            effective_strength, primary_emotion, namespace
     FROM memories WHERE id = ? LIMIT 1`,
    [memoryId],
  );
  if (rows.length === 0) return null;
  const mem = rows[0] as any;
  const rawInput = (mem.raw_input as string) || '';
  const emotionTag = (mem.scar_type as string) || (mem.narrative_tag as string) || '中性';
  const decision = evaluateDiamondPromotion(mem);
  if (!decision.eligible) return null;
  const duplicate = findDuplicateDiamond(sqlite, rawInput, emotionTag);
  if (duplicate) {
    return mergeIntoExistingDiamond(sqlite, duplicate, mem, decision.reason || 'merged-duplicate');
  }
  const tags = ['gold_提炼', emotionTag];
  if (mem.is_landmark === 1) tags.push('地标');
  if (mem.narrative_tag) tags.push(`tag:${String(mem.narrative_tag).substring(0, 24)}`);
  if (mem.primary_emotion && mem.primary_emotion !== emotionTag) tags.push(`emotion:${String(mem.primary_emotion).substring(0, 24)}`);
  // V12.4 阶段B 根除24D: 黑钻 emotion_vector 改存 40D v2 JSON（_backfillLibs40D 用 decodePerceptionV40 识别，不再清零）
  const emotionVec = mem.perception_40d && decodePerceptionV40(String(mem.perception_40d)) ? String(mem.perception_40d) : undefined;

  const entry = addBlackDiamond(sqlite, {
    summary: rawInput.length > 200 ? rawInput.substring(0, 200) + '…' : rawInput,
    emotion_tag: emotionTag,
    source_id: memoryId,
    calcium_level: mem.calcium_level as number,
    tags: [...new Set(tags)],
    notes: `自动提炼于 ${new Date().toISOString()} · ${decision.reason}`,
    emotion_vector: emotionVec,
    dna_root_id: mem.dna_root_id ? String(mem.dna_root_id) : null,
    promotion_reason: decision.reason || undefined,
    namespace: mem.namespace ? String(mem.namespace) : 'default',
  });
  logVaultOperation(sqlite, 'promote', 'gold', memoryId, entry.id,
    `提炼至黑钻: ${rawInput.substring(0, 30)} (${decision.reason})`,
    entry.summary || rawInput.substring(0, 200));
  return entry;
}

export function evaluateDiamondPromotion(memory: Record<string, any>): DiamondPromotionDecision {
  // 🔴 2026-09-16 数据卫生: 元对话/自我陈述不具备黑钻晋升资格（与钙化分无关）
  if (isMetaDiscourse(memory.raw_input) || isMetaDiscourse(memory.summary)) {
    return { eligible: false, reason: 'meta-discourse', targetState: 'candidate' };
  }
  const calciumScore = Number(memory.calcium_score ?? memory.calcium_level ?? 0);
  const recallCount = Number(memory.recall_count ?? 0);
  const isLandmark = Number(memory.is_landmark ?? 0) === 1 || memory.is_landmark === true;
  const lifecycleState = String(memory.lifecycle_state ?? 'candidate');
  const scarType = memory.scar_type ? String(memory.scar_type) : null;
  const promotedToDiamond = Number(memory.promoted_to_diamond ?? 0) === 1;
  const effectiveStrength = Number(memory.effective_strength ?? 0);
  const hasNarrativeTag = typeof memory.narrative_tag === 'string' && memory.narrative_tag.trim().length > 0;

  if (promotedToDiamond || lifecycleState === 'promoted') {
    return { eligible: false, reason: null, targetState: 'promoted' };
  }
  if (lifecycleState === 'suppressed' && scarType) {
    return { eligible: false, reason: null, targetState: 'candidate' };
  }
  if (isLandmark && calciumScore >= 3.5) {
    return { eligible: true, reason: 'landmark+high-calcium', targetState: 'promoted' };
  }
  if (calciumScore >= 4.5) {
    return { eligible: true, reason: 'native-calcium>=4.5', targetState: 'promoted' };
  }
  if (recallCount >= 5) {
    return { eligible: true, reason: 'recall>=5', targetState: 'promoted' };
  }
  const factors: string[] = [];
  let score = 0;
  if (isLandmark) { score += 2; factors.push('landmark'); }
  if (calciumScore >= 4.0) { score += 3; factors.push('high-calcium'); }
  else if (calciumScore >= 3.5) { score += 2; factors.push('calcium>=3.5'); }
  if (recallCount >= 4) { score += 2; factors.push('recall>=4'); }
  else if (recallCount >= 3) { score += 1; factors.push('recall>=3'); }
  if (effectiveStrength >= 0.72) { score += 2; factors.push('strong-trace'); }
  else if (effectiveStrength >= 0.58) { score += 1; factors.push('stable-trace'); }
  if (scarType) { score += 1; factors.push(`scar:${scarType}`); }
  if (hasNarrativeTag) { score += 1; factors.push('narrative-tag'); }
  if (score >= 5 && factors.length >= 2) {
    return { eligible: true, reason: `multi-factor:${factors.slice(0, 4).join('+')}`, targetState: 'promoted' };
  }
  return { eligible: false, reason: null, targetState: 'candidate' };
}

export function autoPromoteCandidates(sqlite: SQLiteAdapter, limit = 5): BlackDiamondEntry[] {
  return autoPromoteCandidatesV2(sqlite, limit);
}

/**
 * S2-2: 金库→黑钻晋升（新规格）
 * 条件: calcium_score >= 4.5 或 recall_count >= 5
 */
export function autoPromoteCandidatesV2(sqlite: SQLiteAdapter, limit = 5): BlackDiamondEntry[] {
  const alreadyPromoted = new Set(
    (sqlite.queryAll('SELECT source_id FROM black_diamond WHERE source_id IS NOT NULL') as any[])
      .map((r: any) => r.source_id as string)
      .filter(Boolean),
  );

  const candidates = sqlite.queryAll(
    `SELECT id, raw_input, calcium_score, calcium_level, recall_count, narrative_tag,
            dna_root_id, is_landmark, scar_type, lifecycle_state, promoted_to_diamond,
            effective_strength, primary_emotion, namespace
     FROM memories
     WHERE COALESCE(promoted_to_diamond, 0) = 0
       AND lifecycle_state IN ('candidate', 'active', 'healed')
       AND (calcium_score >= 3.5 OR recall_count >= 3 OR is_landmark = 1)
     ORDER BY calcium_score DESC, recall_count DESC, is_landmark DESC
     LIMIT ?`,
    [limit],
  ) as any[];

  const results: BlackDiamondEntry[] = [];
  for (const mem of candidates) {
    if (alreadyPromoted.has(mem.id as string)) continue;
    const decision = evaluateDiamondPromotion(mem);
    if (!decision.eligible) continue;
    const entry = promoteToBlackDiamond(sqlite, mem.id as string);
    if (entry) {
      results.push(entry);
    }
  }
  return results;
}

/**
 * S2-2: 召回钙化分增长（每次 +0.2，上限 10）
 */
export function applyRecallIncrement(sqlite: SQLiteAdapter, memoryId: string): void {
  sqlite.writeRaw(
    `UPDATE memories SET calcium_score = ROUND(MIN(10, COALESCE(calcium_score, 0) + 0.2), 1),
     recall_count = COALESCE(recall_count, 0) + 1,
     last_recalled_at = datetime('now','localtime')
     WHERE id = ?`,
    memoryId,
  );
}

// ─── P2: 批量操作 + 导出 ───

/** 批量删除黑钻（核心安全防护：core_safety > 0.7 需二次确认） */
export function batchDeleteDiamonds(sqlite: SQLiteAdapter, ids: string[]): { deleted: number; protected_: string[] } {
  const protected_: string[] = [];
  let deleted = 0;
  for (const id of ids) {
    // 核心记忆防护
    const mem = sqlite.queryAll('SELECT raw_input, calcium_score FROM memories WHERE id = (SELECT source_id FROM black_diamond WHERE id = ? LIMIT 1)', [id]);
    const isCore = mem.length > 0 && /结婚|救命|重要|第一[次个]|生日|纪念/.test((mem[0] as any)?.raw_input || '') && (mem[0] as any)?.calcium_score > 0.7;
    if (isCore) { protected_.push(id); continue; }
    const ok = deleteBlackDiamond(sqlite, id);
    if (ok) deleted++;
  }
  logVaultOperation(sqlite, 'batch_delete', 'black_diamond', undefined, undefined, `批量删除 ${deleted} 条, ${protected_.length} 条受保护`);
  return { deleted, protected_ };
}

/** 导出黑钻库 */
export function exportDiamonds(sqlite: SQLiteAdapter, format: 'json' | 'csv' = 'json'): string {
  const items = listBlackDiamonds(sqlite, 1000);
  if (format === 'csv') {
    const header = 'id,summary,emotion_tag,calcium_level,recall_count,created_at\n';
    const rows = items.map(function(i) {
      return [i.id, '"' + (i.summary || '').replace(/"/g, '""') + '"', i.emotion_tag || '', i.calcium_level, i.recall_count, i.created_at].join(',');
    }).join('\n');
    return header + rows;
  }
  return JSON.stringify(items, null, 2);
}

// ─── P3: 砂金库操作 ───

/** 压缩砂金库（标记旧数据可清理） */
export function compactAlluvial(sqlite: SQLiteAdapter, cutoffDays = 30): number {
  const cutoff = new Date(Date.now() - cutoffDays * 86400000).toISOString();
  const old = sqlite.queryAll('SELECT COUNT(*) as cnt FROM conversations WHERE timestamp < ? AND is_summary = 0', [cutoff]);
  const count = Number((old[0] as any)?.cnt || 0);
  if (count > 0) {
    sqlite.writeRaw('UPDATE conversations SET is_summary = 1, is_compacted = 1 WHERE timestamp < ? AND is_summary = 0', cutoff);
    logVaultOperation(sqlite, 'compact', 'alluvial', undefined, undefined, `压缩 ${count} 条超过 ${cutoffDays} 天的砂金库对话`);
  }
  return count;
}

// ─── 景幻仙姑 · 三库健康报告 ───

/**
 * 生成三库健康报告（人类可读）
 */
export function generateVaultReport(
  sqlite: SQLiteAdapter,
  conversationHistory: ConversationTurn[],
  compressionThreshold: number,
  lastCompaction: string | null,
): VaultReport {
  const goldSummary = getGoldSummary(sqlite);
  const alluvialSummary = getAlluvialSummary(conversationHistory, compressionThreshold);
  const diamonds = listBlackDiamonds(sqlite, 5);

  // P4: 趋势数据
  const gold7d = sqlite.queryAll("SELECT COUNT(*) as cnt FROM memories WHERE created_at > datetime('now', '-7 days')");
  const promote7d = sqlite.queryAll("SELECT COUNT(*) as cnt FROM vault_log WHERE operation = 'promote' AND created_at > datetime('now', '-7 days')");
  const avgStr7d = sqlite.queryAll("SELECT AVG(effective_strength) as avg FROM memories WHERE created_at > datetime('now', '-7 days')");
  const goldGrowth7d = Number((gold7d[0] as any)?.cnt || 0);
  const promoteCount7d = Number((promote7d[0] as any)?.cnt || 0);
  const avgStrengthChange = Number((avgStr7d[0] as any)?.avg || 0);

  const healthScore = goldSummary.total > 0 ? Math.min(1, goldSummary.avgStrength * goldSummary.total / 10) : 0;
  const healthStatus = healthScore > 0.6 ? '繁茂' : healthScore > 0.3 ? '稳定' : '休耕期';

  // 预警 + 记忆韧性提示
  const alerts: string[] = [];
  if (goldSummary.total === 0) alerts.push('金库为空');
  if (goldSummary.avgStrength < 0.2) alerts.push('当前金库强度偏低，但人类记忆本就有模糊性——正如老照片会褪色，珍贵的褶皱反而更真实');
  if (goldGrowth7d === 0 && promoteCount7d === 0 && goldSummary.total > 0) alerts.push('7天无新记忆, 记忆森林进入休耕期');

  const overallStatus =
    goldSummary.total > 0 && goldSummary.avgStrength > 0.1
      ? '健康'
      : goldSummary.total === 0
        ? '金库空（新系统）'
        : '注意（金库强度偏低）';

  const narrativeMemories = sqlite.queryAll("SELECT raw_input FROM memories WHERE calcium_score > 0.6 ORDER BY created_at DESC LIMIT 3");
  const narrative = `记忆森林正在自然演替：新芽（7日新增金库）：${goldGrowth7d} 条 | 老树（保留黑钻）：${promoteCount7d} 颗 | 当前生态健康度：${healthStatus}`;

  return {
    timestamp: new Date().toISOString(),
    trends: { gold_growth_7d: goldGrowth7d, promote_count_7d: promoteCount7d, avg_strength_change: Math.round(avgStrengthChange * 100) / 100, health_score: Math.round(healthScore * 100) / 100, health_status: healthStatus, narrative },
    alerts,
    alluvial: {
      total: alluvialSummary.total,
      oldestAgeHours: alluvialSummary.oldestAgeHours,
      compressible: alluvialSummary.compressible,
      compressedAt: lastCompaction,
    },
    gold: {
      total: goldSummary.total,
      avgStrength: Math.round(goldSummary.avgStrength * 100) / 100,
      highCalciumCount: goldSummary.highCalcium,
      topTags: [],
    },
    blackDiamond: {
      total: diamonds.length,
      recentEntries: diamonds.slice(0, 5).map((d) => d.summary.substring(0, 40)),
    },
    overall: overallStatus,
  };
}

// ─── 辅助 ───

function rowToBlackDiamond(row: any): BlackDiamondEntry {
  return {
    id: row.id as string,
    summary: row.summary as string,
    emotion_tag: row.emotion_tag as string | null,
    source_id: row.source_id as string | null,
    calcium_level: row.calcium_level as number,
    recall_count: row.recall_count as number,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags as string[] || []),
    notes: row.notes as string || '',
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function normalizeDiamondText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 120);
}

function findDuplicateDiamond(sqlite: SQLiteAdapter, rawInput: string, emotionTag: string): DiamondDuplicateMatch | null {
  const normalized = normalizeDiamondText(rawInput);
  if (normalized.length < 16) return null;
  const rows = sqlite.queryAll(
    `SELECT id, summary, emotion_tag, tags, notes, calcium_level
     FROM black_diamond
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 50`,
  ) as any[];

  for (const row of rows) {
    const summary = String(row.summary ?? '');
    const summaryNormalized = normalizeDiamondText(summary);
    if (!summaryNormalized) continue;
    const sameEmotion = String(row.emotion_tag ?? '') === emotionTag;
    const looksDuplicate =
      summaryNormalized === normalized ||
      summaryNormalized.includes(normalized) ||
      normalized.includes(summaryNormalized);
    if (!looksDuplicate) continue;
    if (!sameEmotion && Math.min(summaryNormalized.length, normalized.length) < 28) continue;
    return {
      id: String(row.id),
      summary,
      emotion_tag: row.emotion_tag == null ? null : String(row.emotion_tag),
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : [],
      notes: String(row.notes ?? ''),
      calcium_level: Number(row.calcium_level ?? 1),
    };
  }
  return null;
}

function mergeIntoExistingDiamond(
  sqlite: SQLiteAdapter,
  duplicate: DiamondDuplicateMatch,
  memory: Record<string, any>,
  reason: string,
): BlackDiamondEntry | null {
  const memoryId = String(memory.id);
  const now = new Date().toISOString();
  const mergedReason = `merged-into:${duplicate.id}`;
  const mergedTags = new Set<string>(duplicate.tags);
  // 🆕 V10.0 P0-7: 逐个添加标签，而非将数组作为单元素加入 Set
  for (const _t of duplicate.tags) mergedTags.add(_t);
  mergedTags.add('merged_gold');
  if (memory.narrative_tag) mergedTags.add(`tag:${String(memory.narrative_tag).substring(0, 24)}`);
  if (memory.primary_emotion) mergedTags.add(`emotion:${String(memory.primary_emotion).substring(0, 24)}`);
  const mergedNotes = [
    duplicate.notes?.trim(),
    `合并来源 ${memoryId} @ ${now} (${reason})`,
  ].filter(Boolean).join('\n');

  sqlite.writeRaw(
    `UPDATE memories
     SET promoted_to_diamond = 1,
         lifecycle_state = 'promoted',
         promotion_reason = ?,
         last_verified_at = ?
     WHERE id = ?`,
    mergedReason, now, memoryId,
  );
  sqlite.writeRaw(
    `UPDATE black_diamond
     SET calcium_level = ?,
         tags = ?,
         notes = ?,
         updated_at = ?
     WHERE id = ?`,
    Math.max(duplicate.calcium_level, Number(memory.calcium_level ?? 1)),
    JSON.stringify([...mergedTags]),
    mergedNotes,
    now,
    duplicate.id,
  );
  logVaultOperation(sqlite, 'merge_promote', 'gold', memoryId, duplicate.id, `合并进已有黑钻: ${duplicate.id} (${reason})`);
  return getBlackDiamond(sqlite, duplicate.id);
}
