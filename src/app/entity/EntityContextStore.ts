/**
 * EntityContextStore — 上下文持久化存储
 * ======================================
 * 以 DB 为唯一真相源，提供跨会话的实体上下文重建。
 *
 * 职责：
 *   1. queryEntityContext(uuid) — 从 conversations 表按 UUID 精准查询
 *   2. rebuildAllContexts(uuids) — 启动时为所有 FG 实体重建上下文
 *   3. saveEmotionSnapshot(uuid) — 保存会晤结束时的情感快照
 *   4. loadEmotionSnapshot(uuid) — 恢复上次会晤的情感基调
 *
 * 不依赖 conversationHistory RAM 数组。
 */
import type { ConversationTurn } from '../../m5/types/index.js';

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
   *  includeCompacted=true 时包含已压缩对话（用于兜底补充，避免老实体上下文为零）。
   *  调用方负责去重合并，未压缩优先。
   */
  queryEntityContext(uuid: string, limit: number = 200, includeCompacted: boolean = false): ConversationTurn[] {
    try {
      const compactedFilter = includeCompacted ? '' : 'AND is_compacted = 0';
      const rows = this._sqlite.queryAll(
        `SELECT role, content, timestamp, belong_entity_uuid
         FROM conversations
         WHERE belong_entity_uuid = ? ${compactedFilter}
         ORDER BY timestamp DESC LIMIT ?`,
        [uuid, limit],
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
      const compactedFlag = includeCompacted ? 1 : 0;
      const compactedFilter = compactedFlag ? '' : 'AND is_compacted = 0';
      const totalRow = this._sqlite.queryAll(
        `SELECT COUNT(*) AS c FROM conversations WHERE belong_entity_uuid = ? ${compactedFilter}`,
        [uuid],
      ) as any;
      const total = Number(totalRow?.[0]?.c ?? 0);
      if (total <= recent) return this.queryEntityContext(uuid, Math.max(total, recent), includeCompacted ?? false);

      const recentRows = this._sqlite.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? ${compactedFilter}
         ORDER BY timestamp DESC LIMIT ?`,
        [uuid, recent],
      ) || [];
      const earlyRows = this._sqlite.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? ${compactedFilter}
         ORDER BY timestamp ASC LIMIT ?`,
        [uuid, early],
      ) || [];
      const _midSpan = Math.max(1, total - recent - early);
      const _midTake = Math.min(mid, _midSpan);
      const _midOffset = early + Math.floor((_midSpan - _midTake) / 2);
      const midRows = this._sqlite.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? ${compactedFilter}
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

  /** 🔴 记忆召回彻底解决: 按内容关键词检索实体历史对话（用户问具体事时 LIKE 精准召回） */
  searchEntityContext(uuid: string, keyword: string, limit = 3, includeCompacted: boolean = false): ConversationTurn[] {
    try {
      const compactedFilter = includeCompacted ? '' : 'AND is_compacted = 0';
      const rows = this._sqlite.queryAll(
        `SELECT role, content, timestamp FROM conversations
         WHERE belong_entity_uuid = ? ${compactedFilter} AND content LIKE ?
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
