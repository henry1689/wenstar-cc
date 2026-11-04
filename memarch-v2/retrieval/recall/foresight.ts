// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / recall/foresight.ts
// 路⑧：前瞻召回（基于对话意图预测下一步可能需要的记忆）
//   - 从 prospective_items 拉 pending 项
//   - intent='prospective' 时权重最高；intent='question' 中等
//   - due_at 临近（<7 天）加权
// =====================================================================

import type Database from 'better-sqlite3';
import type { QueryContext, RawCandidate } from '../types';
import { BaseRecallStrategy } from './base';

export class ForesightRecall extends BaseRecallStrategy {
  readonly name = 'foresight';

  async recall(q: QueryContext): Promise<RawCandidate[]> {
    const now = Date.now();
    const sevenDays = 7 * 24 * 3600 * 1000;

    const sql = `
      SELECT id,
             content,
             due_at,
             trigger_type,
             kind,
             created_at
      FROM prospective_items
      WHERE status = 'pending'
      ORDER BY due_at ASC
      LIMIT 15
    `;
    const rows = this.db.prepare(sql).all() as Array<{
      id: string; content: string | null; due_at: number | null;
      trigger_type: string; kind: string; created_at: number;
    }>;

    const intentBoost = q.intent === 'prospective' ? 0.4 : q.intent === 'question' ? 0.2 : 0.05;

    return rows.map((r) => {
      const dueSoon = r.due_at != null && r.due_at - now < sevenDays ? 0.3 : 0;
      return this.buildCandidate({
        id: r.id,
        text: r.content || `[${r.kind}] due=${new Date(r.due_at ?? now).toISOString()}`,
        source_namespace: 'prospective_items',
        raw_score: 0.3 + intentBoost + dueSoon,
        created_at: r.created_at,
        strength: 0.6,
        activation: 0.6,
      });
    });
  }
}
