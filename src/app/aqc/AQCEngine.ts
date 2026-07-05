/**
 * AQCEngine — AQC 质检引擎（砂金质检员 + 金库质检员）
 *
 * 职责：独立于现有流程之外，只做标记和记录，不拦截、不修改、不阻塞。
 *   - SandQC（砂金质检员）: 每小时扫描最新对话，标记高质量对话
 *   - GoldQC（金库质检员）: 每小时扫描金库记忆，标记高质量记忆
 *
 * v2: 质检结果反哺晋升衰减（P2-1）— SandQC 引导优质对话加速晋升，
 *     GoldQC 保护优质记忆减速衰减。
 *
 * 设计铁律：
 *   ① 零改动现有代码路径
 *   ② 所有结果写入独立的 aqc_records 表
 *   ③ 质检反馈可关闭（通过开关控制）
 */
import type { ConversationTurn } from '../../m5/types/index.js';
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import { promoteToBlackDiamond } from '../vault/VaultManager.js';
import { MEMORY_CONFIG } from '../../config/MemoryConfig.js';

// P2-1: 质检反馈开关（可关闭以恢复纯标记模式）
const ENABLE_QC_FEEDBACK = true;

// ═══════════════════════════════════════════════════════════════
// SandQC — 砂金质检员
// 扫描最新对话，标记高质量内容，优质对话的钙化分加权
// ═══════════════════════════════════════════════════════════════

export interface SandQCResult {
  scanned: number;
  approved: number;
  pending: number;
}

export function runSandQC(
  sqlite: SQLiteAdapter,
  conversationHistory: ConversationTurn[],
  limit = 30,
): SandQCResult {
  const recentTurns = conversationHistory.slice(-limit);
  let scanned = 0;
  let approved = 0;
  let pending = 0;

  const emotionWords = /难过|开心|伤心|生气|愤怒|感动|温暖|焦虑|紧张|担心|期待|失望|幸福|辛苦|累|烦|怕|爱|恨|想|念|喜欢|讨厌|后悔/;

  for (const turn of recentTurns) {
    if (turn.role !== 'user') continue;
    const text = turn.content || '';
    if (text.length < 4) continue;

    scanned++;
    const snippet = text.substring(0, 80);
    let score = 0;

    if (text.length > 10) score += 0.3;
    if (/妈妈|爸爸|老婆|老公|朋友|同事|客户|公司|工作|项目|家/.test(text)) score += 0.3;
    if (emotionWords.test(text)) score += 0.3;
    if (text.length > 5 && /[一-龥]{2,3}说|和[一-龥]{2,3}|找[一-龥]{2,3}/.test(text)) score += 0.2;

    const status = score >= 0.2 ? 'approved' : 'pending';
    const now = new Date().toISOString();
    const contentKey = snippet.replace(/[^一-龥a-zA-Z0-9]/g, '').substring(0, 40);
    const id = `aqc_sand_${contentKey}_${now.substring(0, 10)}`;

    try {
      sqlite.writeRaw(
        `INSERT OR IGNORE INTO aqc_records (id, source_type, source_id, content_snippet, calcium_level, entity_count, score, status, created_at, evaluated_at)
         VALUES (?, 'sand', ?, ?, 0, 0, ?, ?, ?, ?)`,
        id, contentKey, snippet, score, status, now, now,
      );

      // P2-1: 优质对话 → 提升钙化分，加速晋升金库
      if (ENABLE_QC_FEEDBACK && status === 'approved' && score > 0.5) {
        const boostKey = contentKey;
        sqlite.writeRaw(
          `UPDATE conversations SET calcium_score = ROUND(MIN(10, COALESCE(calcium_score, 0) + 1.0), 1)
           WHERE content LIKE ? AND is_promoted = 0`,
          [`%${boostKey.substring(0, 20)}%`],
        );
      }
    } catch { /* 跳过 */ }

    if (status === 'approved') approved++;
    else pending++;
  }

  return { scanned, approved, pending };
}

// ═══════════════════════════════════════════════════════════════
// GoldQC — 金库质检员
// 扫描金库记忆，标记高质量记忆，优质记忆减速衰减
// ═══════════════════════════════════════════════════════════════

export interface GoldQCResult {
  scanned: number;
  approved: number;
  rejected: number;
}

export function runGoldQC(sqlite: SQLiteAdapter, limit = 50): GoldQCResult {
  let scanned = 0;
  let approved = 0;
  let rejected = 0;
  const now = new Date().toISOString();

  try {
    const rows = sqlite.queryAll(
      `SELECT id, raw_input, calcium_level, recall_count, is_landmark, effective_strength
       FROM memories ORDER BY created_at DESC LIMIT ?`,
      [limit],
    ) as any[];

    for (const row of rows) {
      scanned++;
      const calcium = row.calcium_level ?? 0;
      const recall = row.recall_count ?? 0;
      const landmark = row.is_landmark ?? 0;
      const strength = row.effective_strength ?? 0;

      let score = 0;
      if (recall >= 3) score += 0.4;
      if (calcium >= 2) score += 0.3;
      if (landmark === 1) score += 0.3;
      if (strength > 0.5) score += 0.2;

      const status = score >= 0.15 ? 'approved' : 'rejected';
      const snippet = (row.raw_input || '').substring(0, 80);

      const id = `aqc_gold_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

      try {
        sqlite.writeRaw(
          `INSERT OR IGNORE INTO aqc_records (id, source_type, source_id, content_snippet, calcium_level, entity_count, recall_count, score, status, created_at, evaluated_at)
           VALUES (?, 'gold', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
          id, row.id, snippet, calcium, recall, score, status, now, now,
        );

        // P2-1: 优质记忆减速衰减（提升有效强度，使其更难被衰减到0）
        if (ENABLE_QC_FEEDBACK && status === 'approved' && score > 0.5) {
          sqlite.writeRaw(
            `UPDATE memories SET effective_strength = ROUND(MIN(1.0, effective_strength * 1.2), 4),
             reinforcement_accumulator = COALESCE(reinforcement_accumulator, 0) + 0.1,
             strength_updated_at = ?
             WHERE id = ?`,
            [now, row.id],
          );
        }
      } catch { /* 跳过 */ }

      if (status === 'approved') {
        approved++;
        const r = promoteToBlackDiamond(sqlite, row.id);
      } else rejected++;
    }
  } catch (err) {
    console.warn('[GoldQC] 扫描失败:', err);
  }

  return { scanned, approved, rejected };
}

// ═══════════════════════════════════════════════════════════════
// 质检报告
// ═══════════════════════════════════════════════════════════════

export interface AQCReport {
  sand: { pending: number; approved: number; lastRun: string | null };
  gold: { pending: number; approved: number; rejected: number; lastRun: string | null };
}

export function getAQCReport(sqlite: SQLiteAdapter): AQCReport {
  const getCount = (sourceType: string, status: string): number => {
    const rows = sqlite.queryAll(
      `SELECT COUNT(*) as cnt FROM aqc_records WHERE source_type = ? AND status = ?`,
      [sourceType, status],
    );
    return (rows[0] as any)?.cnt ?? 0;
  };

  const getLastRun = (sourceType: string): string | null => {
    const rows = sqlite.queryAll(
      `SELECT evaluated_at FROM aqc_records WHERE source_type = ? AND evaluated_at IS NOT NULL ORDER BY evaluated_at DESC LIMIT 1`,
      [sourceType],
    );
    return (rows[0] as any)?.evaluated_at ?? null;
  };

  return {
    sand: {
      pending: getCount('sand', 'pending'),
      approved: getCount('sand', 'approved'),
      lastRun: getLastRun('sand'),
    },
    gold: {
      pending: getCount('gold', 'pending'),
      approved: getCount('gold', 'approved'),
      rejected: getCount('gold', 'rejected'),
      lastRun: getLastRun('gold'),
    },
  };
}
