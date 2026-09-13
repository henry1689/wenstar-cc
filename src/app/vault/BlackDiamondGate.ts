/**
 * BlackDiamondGate.ts — 黑钻库手动准入门控 (V4.0 Phase 5)
 * =========================================================
 * 通道B：手动强制准入，高权限管控。
 *
 * 规则:
 *   - 配额上限：手动条目不得超过黑钻库总条目的 10%
 *   - 密码校验：用户自定义校验密码，二次确认
 *   - 风控弹窗：入库前警告"该内容将长期固化，修改删除成本极高"
 *   - 反向移除：同样需要密码校验
 *   - 审计日志：所有手动操作记录到 vault_log 表
 *
 * 使用:
 *   const gate = new BlackDiamondGate(sqlite);
 *   const result = gate.manualAdd(summary, content, tags, password);
 *   // → { success, reason, entry? }
 */

import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
// 2026-09-13 ②-1补漏: 归属脏值净化唯一入口（审计日志回查黑钻归属时不得透传字符串 'null'）
import { sanitizeBelongUuid } from './belong-uuid.js';

export interface ManualAddResult {
  success: boolean;
  reason: string;
  entryId?: string;
  quotaConsumed?: boolean;
}

export interface ManualRemoveResult {
  success: boolean;
  reason: string;
}

export class BlackDiamondGate {
  private sqlite: SQLiteAdapter;

  /** 手动条目最大占比 */
  private readonly MAX_MANUAL_RATIO = 0.10;

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
  }

  /**
   * 手动准入（通道B）
   *
   * @param summary 条目标题/摘要
   * @param content 完整内容
   * @param tags 标签列表
   * @param password 用户校验密码
   * @param expectedPassword 系统中存储的正确密码（从 engine_store 读取）
   * @param entryReason 入库原因（用户备注）
   */
  manualAdd(
    summary: string,
    content: string,
    tags: string[],
    password: string,
    expectedPassword: string,
    entryReason: string,
  ): ManualAddResult {
    // ① 密码校验
    if (!password || password !== expectedPassword) {
      return { success: false, reason: '密码错误，操作已拒绝' };
    }

    // ② 配额检查
    const totalCount = this._countAll();
    const manualCount = this._countManual();
    const maxManual = Math.max(1, Math.floor(totalCount * this.MAX_MANUAL_RATIO));

    if (manualCount >= maxManual) {
      return {
        success: false,
        reason: `手动固化配额已满（当前 ${manualCount}/最大 ${maxManual}），请先移除部分手动条目或等待自动晋升条目增加后扩充配额。`,
      };
    }

    // ③ 写入黑钻库
    try {
      const entryId = `bd_manual_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
      const now = new Date().toISOString();
      const tagsJson = JSON.stringify([...tags, 'manual_entry']);

      this.sqlite.writeRaw(
        `INSERT INTO black_diamond (id, summary, emotion_tag, source_id, calcium_level,
         recall_count, tags, notes, created_at, updated_at, entry_channel, entry_reason,
         stabilization_score, manual_quota_consumed, status, belong_entity_uuid)
         VALUES (?, ?, NULL, NULL, 5, 0, ?, ?, ?, ?, 'manual', ?, 1.0, 1, 'active', NULL)`,
        [entryId, summary.substring(0, 200), tagsJson, content.substring(0, 500), now, now, entryReason],
      );

      // 审计日志
      this._logOperation('manual_add_diamond', entryId, `手动固化: ${summary.substring(0, 40)} | 原因: ${entryReason}`);

      return {
        success: true,
        reason: '已成功固化到黑钻库',
        entryId,
        quotaConsumed: true,
      };
    } catch (err) {
      return { success: false, reason: `写入失败: ${(err as Error).message}` };
    }
  }

  /**
   * 手动移除（反向操作，同样需要密码校验）
   */
  manualRemove(
    entryId: string,
    password: string,
    expectedPassword: string,
    removeReason: string,
  ): ManualRemoveResult {
    // ① 密码校验
    if (!password || password !== expectedPassword) {
      return { success: false, reason: '密码错误，操作已拒绝' };
    }

    // ② 检查条目是否存在
    const rows = this.sqlite.queryAll(
      "SELECT id, entry_channel FROM black_diamond WHERE id = ? AND status = 'active' LIMIT 1",
      [entryId],
    );
    if (!rows?.length) {
      return { success: false, reason: '条目不存在或已被移除' };
    }

    // ③ 标记为 removed（不物理删除）
    try {
      const now = new Date().toISOString();
      this.sqlite.writeRaw(
        "UPDATE black_diamond SET status = 'removed', notes = ?, updated_at = ? WHERE id = ?",
        [`手动移除: ${removeReason}`, now, entryId],
      );

      // 审计日志
      this._logOperation('manual_remove_diamond', entryId, `手动移除: ${removeReason}`);

      return { success: true, reason: '已从黑钻库移除' };
    } catch (err) {
      return { success: false, reason: `移除失败: ${(err as Error).message}` };
    }
  }

  /**
   * 获取配额状态
   */
  getQuotaStatus(): { total: number; manual: number; maxManual: number; remaining: number } {
    const total = this._countAll();
    const manual = this._countManual();
    const maxManual = Math.max(1, Math.floor(total * this.MAX_MANUAL_RATIO));
    return {
      total,
      manual,
      maxManual,
      remaining: Math.max(0, maxManual - manual),
    };
  }

  /**
   * 校验密码（供前端调用，不暴露实际密码内容）
   */
  verifyPassword(input: string, expected: string): boolean {
    return input === expected;
  }

  /** 获取存储的校验密码（从 engine_store 读取） */
  getStoredPassword(): string {
    try {
      const rows = this.sqlite.queryAll(
        "SELECT value FROM engine_store WHERE key = 'black_diamond_password' LIMIT 1",
      );
      if (rows?.length) {
        return (rows[0] as any).value || '';
      }
    } catch { /* 降级 */ }
    return '';
  }

  /** 设置/更新校验密码 */
  setPassword(password: string): void {
    this.sqlite.writeRaw(
      "INSERT OR REPLACE INTO engine_store (key, value) VALUES ('black_diamond_password', ?)",
      [password],
    );
  }

  // ─── 内部 ───

  private _countAll(): number {
    try {
      const rows = this.sqlite.queryAll(
        "SELECT COUNT(*) as cnt FROM black_diamond WHERE status = 'active'",
      );
      return rows?.[0] ? (rows[0] as any).cnt || 0 : 0;
    } catch { return 0; }
  }

  private _countManual(): number {
    try {
      const rows = this.sqlite.queryAll(
        "SELECT COUNT(*) as cnt FROM black_diamond WHERE entry_channel = 'manual' AND status = 'active'",
      );
      return rows?.[0] ? (rows[0] as any).cnt || 0 : 0;
    } catch { return 0; }
  }

  private _logOperation(operation: string, targetId: string, detail: string): void {
    try {
      const id = `vd_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 4)}`;
      // V13: 回查 black_diamond.belong_entity_uuid 确保审计日志可被 UUID 检索
      // ②-1补漏(2026-09-13): 原 `bd[0]?.belong || null` 挡不住字符串 'null'，会把它搬进 vault_log
      let euuid: string | null = null;
      try {
        const bd = this.sqlite.queryAll('SELECT belong_entity_uuid FROM black_diamond WHERE id = ?', [targetId]) as any[];
        if (bd.length > 0) euuid = sanitizeBelongUuid(bd[0]?.belong_entity_uuid) ?? null;
      } catch { /* 回查不阻塞 */ }
      this.sqlite.writeRaw(
        `INSERT INTO vault_log (id, operation, source_type, target_id, detail, created_at, belong_entity_uuid)
         VALUES (?, ?, 'black_diamond', ?, ?, ?, ?)`,
        [id, operation, targetId, detail, new Date().toISOString(), euuid],
      );
    } catch { /* 审计日志不阻塞 */ }
  }
}
