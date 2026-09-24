/**
 * EntityContextStore — 上下文持久化存储
 * ======================================
 * 以 DB 为唯一真相源，提供跨会话的实体上下文重建。
 *
 * 职责：
 *   1. queryEntityContext(uuid) — 从 conversations 表按 UUID 精准查询（按时间近因，**含已归档原文**）
 *   2. rebuildAllContexts(uuids) — 启动时为所有 FG 实体重建上下文
 *   3. saveEmotionSnapshot(uuid) — 保存会晤结束时的情感快照
 *   4. loadEmotionSnapshot(uuid) — 恢复上次会晤的情感基调
 *
 * 不依赖 conversationHistory RAM 数组。
 *
 * 🔴 V34(2026-09-25) 语义变更：`is_compacted` 不再是本文件的可见性判据。
 *   砂金库的职责是「全量活档案 + 回忆兜底层」，归档只表示"已移出内存窗口"，
 *   不代表"不可见"。把归档标记当过滤器 = 归档即永久失忆（原设计里不存在这个状态）。
 */
import type { ConversationTurn } from '../../m5/types/index.js';
// V23.1(2026-09-13): 上下文窗口下限取自配置唯一事实源（MemoryConfig 为纯配置，无循环依赖）
import { MEMORY_CONFIG } from '../../config/MemoryConfig.js';

export interface EmotionSnapshot {
  pleasure: number;
  arousal: number;
  intimacy: number;
  lastTopic: string;
  savedAt: string;
}

export class EntityContextStore {
  private _sqlite: any;

  constructor(sqlite: any) {
    this._sqlite = sqlite;
  }

  /** 从 conversations 表按 UUID 精准查询实体对话历史。
   *
   *  🔴 V34(2026-09-25) 归档标记与可见性解耦（架构级修复）：
   *   原设计《三库记忆体系完整架构》§三 —— 砂金库是「回忆的兜底层」，
   *   `is_compacted` 只表示**归档管理**（该轮已移出内存窗口），**不是可见性判据**。
   *   实现却把它当成了检索过滤器 ⇒ 归档 = 永久失忆，砂金库变成只进不出的黑洞。
   *   实测（徐诗雨 3457 条记忆 / 2597 轮对话，24 小时内 477 轮全在库里）：
   *   带与不带该过滤返回**完全相同的 40 条，最旧一条只到 0.6 小时前**
   *   —— 不是没存下，是搜不回来。本方法改为**按真实时间近因取回**，归档与否不参与筛选。
   *
   *  @param uuid  实体 UUID
   *  @param limit 条数上限（经 contextWindowTurns 下限保护，见下）
   *  @param _includeCompacted 【已废弃】保留形参只为兼容既有调用点（chat.ts 的两段式兜底会传 false/true
   *         并按内容前缀去重）。本方法现在**恒包含已归档原文**，该参数不再产生任何过滤效果。
   */
  queryEntityContext(uuid: string, limit: number = 200, _includeCompacted: boolean = false): ConversationTurn[] {
    try {
      // 🔴 V23.1(2026-09-13): 下限保护 —— 调用点此前硬编码 40，而"归档保留窗口"是 100（keepFullTurns）。
      //   两者脱节导致"保留了 100 条却只注入 40 条"，余下约 30 轮留而不用，
      //   是"聊久了记不住前面的事"的直接成因之一。
      //   此处按配置下限兜底：调用方传得比它小也按配置取（窗口策略属存储层职责，避免散落在各调用点）。
      const _floor = (() => {
        try { return Number(MEMORY_CONFIG.compaction.contextWindowTurns) || 0; } catch { return 0; }
      })();
      const _limit = _floor > 0 ? Math.max(limit, _floor) : limit;
      // 🔴 2026-09-12 隔离区过滤: is_test=1 的对话永不得进入实体上下文。
      //   用途: 已将洩漏污染型回复标记为 is_test=1（不删数据），此处保证它们不再被当作“聊过的事”回灌给实体。
      //   ⚠️ 这是**唯一**保留的过滤条件 —— is_compacted 已于 V34 撤出可见性判断。
      const visibilityFilter = ' AND (is_test IS NULL OR is_test = 0)';
      const rows = this._sqlite.queryAll(
        `SELECT role, content, timestamp, belong_entity_uuid
         FROM conversations
         WHERE belong_entity_uuid = ? ${visibilityFilter}
         ORDER BY timestamp DESC LIMIT ?`,
        [uuid, _limit],
      );
      if (!rows?.length) return [];
      return rows
        .reverse()
        .map((r: any) => ({
          role: r.role as 'user' | 'assistant',
          content: r.content as string,
          timestamp: r.timestamp as string,
        }));
    } catch (e: any) {
      console.warn('[EntityStore] queryEntityContext 失败:', e?.message);
      return [];
    }
  }

  /** 🔴 记忆召回彻底解决: 分段查询实体对话历史（近期全量 + 早期/中期采样）。
   *  原 queryEntityContext(limit=10) 只取最近 10 条 → 长对话早期记忆 LLM 无感知。
   *  改为近期 recent 条全量 + 最早 early 条 + 中部 mid 条采样，保证时间轴覆盖。 */
  queryEntityContextSegmented(
    uuid: string,
    opts: { recent: number; early: number; mid: number; includeCompacted?: boolean } = { recent: 30, early: 10, mid: 5 },
  ): ConversationTurn[] {
    try {
      const { recent, early, mid, includeCompacted } = opts;
      // 🔴 2026-09-12 隔离区过滤（同 queryEntityContext）: is_test=1 永不进入实体上下文
      // 🔴 V34(2026-09-25): is_compacted 已撤出可见性判断（见 queryEntityContext 注释）。
      //   本方法的分段采样语义**因此才成立** —— 采样的是"全部历史的时间轴"，
      //   此前 unavailable 的那段（已归档）根本不在 total 里，早期/中期槽实际采不到任何东西。
      const visibilityFilter = ' AND (is_test IS NULL OR is_test = 0)';
      const totalRow = this._sqlite.queryAll(
        `SELECT COUNT(*) AS c FROM conversations WHERE belong_entity_uuid = ? ${visibilityFilter}`,
        [uuid],
      ) as any;
      const total = Number(totalRow?.[0]?.c ?? 0);
      if (total <= recent) return this.queryEntityContext(uuid, Math.max(total, recent), includeCompacted ?? false);

      const recentRows = this._sqlite.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? ${visibilityFilter}
         ORDER BY timestamp DESC LIMIT ?`,
        [uuid, recent],
      ) || [];
      const earlyRows = this._sqlite.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? ${visibilityFilter}
         ORDER BY timestamp ASC LIMIT ?`,
        [uuid, early],
      ) || [];
      const _midSpan = Math.max(1, total - recent - early);
      const _midTake = Math.min(mid, _midSpan);
      const _midOffset = early + Math.floor((_midSpan - _midTake) / 2);
      const midRows = this._sqlite.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? ${visibilityFilter}
         ORDER BY timestamp ASC LIMIT ? OFFSET ?`,
        [uuid, _midTake, _midOffset],
      ) || [];

      // 合并去重（时间正序：早期 + 中期 + 近期）
      const seen = new Set<string>();
      const merged: ConversationTurn[] = [];
      const add = (r: any) => {
        const key = (r.role || '') + (r.content || '').substring(0, 24) + (r.timestamp || '');
        if (seen.has(key)) return;
        seen.add(key);
        merged.push({ role: r.role as 'user' | 'assistant', content: r.content as string, timestamp: r.timestamp as string });
      };
      earlyRows.forEach(add);
      midRows.forEach(add);
      recentRows.slice().reverse().forEach(add);
      return merged;
    } catch (e: any) {
      console.warn('[EntityStore] queryEntityContextSegmented 失败:', e?.message);
      return this.queryEntityContext(uuid, opts.recent);
    }
  }

  /** 🔴 记忆召回彻底解决: 按内容关键词检索实体历史对话（用户问具体事时 LIKE 精准召回）。
   *
   *  🔴 V34(2026-09-25): 同 queryEntityContext —— is_compacted 撤出可见性判断。
   *   本方法是"关键词精准召回"，若把已归档原文排除在外，等于**只搜内存窗口里剩下的那几小时**，
   *   用户问三天前聊过的具体事必然落空（实测症状："几天前说的话都记不起来"）。
   *  @param _includeCompacted 【已废弃】保留形参兼容既有调用点，不再产生过滤效果。
   */
  searchEntityContext(uuid: string, keyword: string, limit = 3, _includeCompacted: boolean = false): ConversationTurn[] {
    try {
      const rows = this._sqlite.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? AND (is_test IS NULL OR is_test = 0) AND content LIKE ?
         ORDER BY timestamp DESC LIMIT ?`,
        [uuid, `%${keyword}%`, limit],
      );
      if (!rows?.length) return [];
      return rows.reverse().map((r: any) => ({
        role: r.role as 'user' | 'assistant',
        content: r.content as string,
        timestamp: r.timestamp as string,
      }));
    } catch (e: any) {
      console.warn('[EntityStore] searchEntityContext 失败:', e?.message);
      return [];
    }
  }

  /** 启动时为所有 FG 实体重建上下文（并行） */
  async rebuildAllContexts(
    entityUuids: Array<{ name: string; uuid: string }>,
  ): Promise<Map<string, ConversationTurn[]>> {
    const result = new Map<string, ConversationTurn[]>();
    for (const { name, uuid } of entityUuids) {
      const turns = this.queryEntityContext(uuid, 200);
      if (turns.length > 0) {
        result.set(name, turns);
        console.log(`[EntityStore] ${name}(${uuid}): 恢复 ${turns.length} 条对话`);
      }
    }
    return result;
  }

  /** 查询某实体的对话总数（用于活跃度判断） */
  getEntityTurnCount(uuid: string, sinceDays: number = 7): number {
    try {
      const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
      const rows = this._sqlite.queryAll(
        `SELECT COUNT(*) as cnt FROM conversations WHERE belong_entity_uuid = ? AND timestamp > ?`,
        [uuid, since],
      );
      return (rows?.[0] as any)?.cnt || 0;
    } catch {
      return 0;
    }
  }

  /** 保存会晤结束时的情感快照 */
  saveEmotionSnapshot(uuid: string, snapshot: Omit<EmotionSnapshot, 'savedAt'>): void {
    try {
      this._sqlite.writeRaw(
        `INSERT OR REPLACE INTO entity_context_snapshots (uuid, pleasure, arousal, intimacy, last_topic, saved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuid, snapshot.pleasure, snapshot.arousal, snapshot.intimacy, snapshot.lastTopic, new Date().toISOString()],
      );
    } catch (e: any) {
      console.warn('[EntityStore] saveEmotionSnapshot 失败:', e?.message);
    }
  }

  /** 恢复上次会晤的情感基调 */
  loadEmotionSnapshot(uuid: string): EmotionSnapshot | null {
    try {
      const rows = this._sqlite.queryAll(
        `SELECT pleasure, arousal, intimacy, last_topic, saved_at FROM entity_context_snapshots WHERE uuid = ?`,
        [uuid],
      );
      if (!rows?.length) return null;
      const r = rows[0] as any;
      return {
        pleasure: r.pleasure ?? 0,
        arousal: r.arousal ?? 0,
        intimacy: r.intimacy ?? 0,
        lastTopic: r.last_topic || '',
        savedAt: r.saved_at || '',
      };
    } catch {
      return null;
    }
  }

  /** V12.2: 记录最后活跃实体（供跨重启上下文锚定） */
  saveLastActiveEntity(uuid: string, name: string): void {
    try {
      this._sqlite.writeRaw(
        `INSERT OR REPLACE INTO entity_context_snapshots (uuid, pleasure, arousal, intimacy, last_topic, saved_at)
         VALUES (?, 0, 0, 0, ?, ?)`,
        [uuid, name, new Date().toISOString()],
      );
    } catch { /* 非关键 */ }
  }

  /** V12.2: 获取最后活跃实体（启动时锚定上下文） */
  getLastActiveEntity(): { uuid: string; name: string; savedAt: string } | null {
    try {
      const rows = this._sqlite.queryAll(
        `SELECT uuid, last_topic as name, saved_at FROM entity_context_snapshots ORDER BY saved_at DESC LIMIT 1`,
      );
      if (!rows?.length) return null;
      const r = rows[0] as any;
      return { uuid: r.uuid, name: r.name, savedAt: r.saved_at };
    } catch {
      return null;
    }
  }

  /** V12.2: 保存压缩摘要（跨重启上下文连续性） */
  saveCompressedSummary(uuid: string, summary: string): void {
    try {
      this._sqlite.writeRaw(
        `INSERT OR REPLACE INTO entity_context_snapshots (uuid, pleasure, arousal, intimacy, last_topic, saved_at)
         VALUES (?, 0, 0, 0, ?, ?)`,
        [uuid, summary.substring(0, 500), new Date().toISOString()],
      );
    } catch { /* 非关键 */ }
  }

  /** V12.2: 加载压缩摘要 */
  loadCompressedSummary(uuid: string): string | null {
    try {
      const rows = this._sqlite.queryAll(
        `SELECT last_topic FROM entity_context_snapshots WHERE uuid = ?`,
        [uuid],
      );
      if (!rows?.length) return null;
      const topic = (rows[0] as any).last_topic;
      // longer than 100 chars → likely a compressed summary, not just a topic
      return topic?.length > 50 ? topic : null;
    } catch {
      return null;
    }
  }

  /** 确保快照表存在（幂等） */
  static ensureSchema(sqlite: any): void {
    try {
      sqlite.run(
        `CREATE TABLE IF NOT EXISTS entity_context_snapshots (
          uuid TEXT PRIMARY KEY,
          pleasure REAL DEFAULT 0,
          arousal REAL DEFAULT 0,
          intimacy REAL DEFAULT 0,
          last_topic TEXT DEFAULT '',
          saved_at TEXT NOT NULL
        )`,
      );
    } catch { /* 表已存在 */ }
  }
}
