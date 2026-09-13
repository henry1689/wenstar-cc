/**
 * WorkRepository — 作品仓库（works 表）
 * ============================================================
 * 作品（小说/文章）作为一级实体存储：标题/类型/摘要/全文/归属UUID/摘要向量。
 * 为"那篇小说"这类指称词提供元数据桥。
 *
 * 评审修订（V2）：
 *   - 续写合并（dialog_group_id 关联，append 不新建行）
 *   - 手动触发重建 works 的管理接口
 *   - 语义摘要向量（异步，由 OnnxEmbeddingEngine 生成）
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import { filterRows as policeFilterRows, type PolicePolicy } from '../../governance/police/UUIDPoliceFilter.js';
// 2026-09-13 ②-1补漏: 归属脏值净化唯一入口（回填时不得把 conversations 的字符串 'null' 搬进 works）
import { sanitizeBelongUuid } from '../vault/belong-uuid.js';

export interface WorkRecord {
  work_id: string;
  title: string;
  work_type: 'novel' | 'story' | 'article' | 'rp_setting';
  first_sentence: string;
  summary: string;
  full_text: string;
  belong_entity_uuid: string | null;
  dna_root_id: string | null;
  source_conversation_ids: string;
  dialog_group_id: string | null;
  semantic_vector: string | null;  // JSON 512维 摘要向量
  created_at: string;
  updated_at: string;
}

/** 分块大小（长文按 800 字切块） */
export const WORK_CHUNK_SIZE = 800;

export class WorkRepository {
  private sqlite: SQLiteAdapter;

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
  }

  /**
   * 创建或更新作品。
   * 若 dialog_group_id 已关联作品 → 续写合并（更新 full_text，不新建行）。
   */
  async upsertWork(params: {
    title: string;
    workType: 'novel' | 'story' | 'article' | 'rp_setting';
    fullText: string;
    belongEntityUuid?: string | null;
    dnaRootId?: string | null;
    sourceConversationIds?: string[];
    dialogGroupId?: string | null;
    summary?: string;
    firstSentence?: string;
  }): Promise<WorkRecord> {
    const now = new Date().toISOString();
    const id = `wk_${cryptoRandom(12)}`;

    // 续写合并：同一 dialog_group_id 已有关联作品
    let existing: WorkRecord | null = null;
    if (params.dialogGroupId) {
      existing = this.findByDialogGroup(params.dialogGroupId);
    }
    if (existing) {
      // append：合并全文
      const mergedText = existing.full_text + '\n' + params.fullText;
      this.sqlite.writeRaw(
        `UPDATE works SET full_text=?, summary=?, updated_at=? WHERE work_id=?`,
        mergedText, params.summary || existing.summary, now, existing.work_id,
      );
      return this.findById(existing.work_id)!;
    }

    // 新建
    this.sqlite.writeRaw(
      `INSERT OR IGNORE INTO works
       (work_id, title, work_type, first_sentence, summary, full_text, belong_entity_uuid,
        dna_root_id, source_conversation_ids, dialog_group_id, semantic_vector, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      id, params.title, params.workType, params.firstSentence || params.title,
      params.summary || '', params.fullText, params.belongEntityUuid ?? null,
      params.dnaRootId ?? null,
      JSON.stringify(params.sourceConversationIds || []),
      params.dialogGroupId ?? null, now, now,
    );
    return this.findById(id)!;
  }

  /** 按 work_id 查 */
  findById(workId: string): WorkRecord | null {
    const rows = this.sqlite.queryAll(`SELECT * FROM works WHERE work_id = ?`, [workId]) as any[];
    return rows && rows.length > 0 ? rows[0] : null;
  }

  /** 按 dialog_group_id 查（续写合并） */
  findByDialogGroup(dialogGroupId: string): WorkRecord | null {
    const rows = this.sqlite.queryAll(
      `SELECT * FROM works WHERE dialog_group_id = ? LIMIT 1`, [dialogGroupId],
    ) as any[];
    return rows && rows.length > 0 ? rows[0] : null;
  }

  /** 找最新作品（按实体 + 时间倒序，时间衰减优先） */
  findLatestWork(entityUuid?: string | null, workType?: string): WorkRecord | null {
    let sql = `SELECT * FROM works WHERE 1=1`;
    const params: any[] = [];
    if (entityUuid) { sql += ` AND belong_entity_uuid = ?`; params.push(entityUuid); }
    if (workType) { sql += ` AND work_type = ?`; params.push(workType); }
    sql += ` ORDER BY created_at DESC LIMIT 1`;
    const rows = this.sqlite.queryAll(sql, params) as any[];
    return rows && rows.length > 0 ? rows[0] : null;
  }

  /** 标题模糊匹配 */
  findWorkByTitleFuzzy(keyword: string, entityUuid?: string | null): WorkRecord | null {
    let sql = `SELECT * FROM works WHERE title LIKE ?`;
    const params: any[] = [`%${keyword}%`];
    if (entityUuid) { sql += ` AND belong_entity_uuid = ?`; params.push(entityUuid); }
    sql += ` ORDER BY created_at DESC LIMIT 1`;
    const rows = this.sqlite.queryAll(sql, params) as any[];
    return rows && rows.length > 0 ? rows[0] : null;
  }

  /** 按户籍策略列出作品（行级 deny-by-default） */
  listWorks(policy: PolicePolicy): WorkRecord[] {
    const rows = this.sqlite.queryAll(`SELECT * FROM works ORDER BY created_at DESC LIMIT 50`) as any[];
    return policeFilterRows(rows as any, policy) as unknown as WorkRecord[];
  }

  /** 长文切块（供 search_index 分块索引） */
  chunkLongText(text: string, size: number = WORK_CHUNK_SIZE): string[] {
    if (!text) return [];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.substring(i, i + size));
    }
    return chunks;
  }

  /** 更新语义摘要向量（异步） */
  async setSemanticVector(workId: string, vector: number[]): Promise<void> {
    if (!vector || vector.length === 0) return;
    this.sqlite.writeRaw(
      `UPDATE works SET semantic_vector = ? WHERE work_id = ?`,
      JSON.stringify(vector), workId,
    );
  }

  /** 存量回填（幂等，扫描长消息生成作品） */
  backfillExisting(): number {
    // 扫描 conversations 长消息（≥500 且含叙事标记）
    const rows = this.sqlite.queryAll(
      `SELECT id, content, belong_entity_uuid, dialog_group_id FROM conversations WHERE LENGTH(content) >= 500`,
    ) as any[];
    let count = 0;
    for (const row of rows) {
      const text = (row.content || '').trim();
      if (!/小说|故事|第一章|正文|尾声|番外|续写|连载|人物设定|角色|章节/.test(text)) continue;
      if (this.findByTitleHash(text)) continue;  // 幂等去重
      this.sqlite.writeRaw(
        `INSERT OR IGNORE INTO works
         (work_id, title, work_type, first_sentence, summary, full_text, belong_entity_uuid,
          source_conversation_ids, created_at, updated_at)
         VALUES (?, ?, 'story', ?, ?, ?, ?, ?, ?, ?)`,
        `wk_${cryptoRandom(12)}`, _titleFrom(text), _firstSent(text),
        _summaryOf(text), text.substring(0, 5000), sanitizeBelongUuid(row.belong_entity_uuid) ?? null,
        JSON.stringify([row.id]), new Date().toISOString(), new Date().toISOString(),
      );
      count++;
    }
    return count;
  }

  private findByTitleHash(text: string): boolean {
    // 按首句去重（幂等）
    const first = _firstSent(text);
    const rows = this.sqlite.queryAll(`SELECT 1 FROM works WHERE first_sentence = ? LIMIT 1`, [first]) as any[];
    return rows && rows.length > 0;
  }
}

/** 随机 id */
function cryptoRandom(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function _titleFrom(text: string): string {
  const m = text.match(/《([^》]{2,20})》/) || text.match(/^(.{1,24}[。！？]?)/);
  return m ? m[1] : `作品_${new Date().toISOString().slice(5, 10)}`;
}

function _firstSent(text: string): string {
  const m = text.match(/^(.{1,24}[。！？]?)/);
  return m ? m[1] : text.substring(0, 24);
}

function _summaryOf(text: string): string {
  const parts: string[] = [];
  const firstTwo = text.match(/^(.{1,60}[。！？!?]){1,2}/);
  if (firstTwo) parts.push(firstTwo[0]);
  return parts.join(' ').substring(0, 600);
}
