/**
 * 步骤3：RAW_ONLY 复评
 * 对 M2 阶段标记为 RAW_ONLY 的条目，带上上下文再编码
 * 决定是否晋升为 WRITE（正式写入 memories 表）
 */

import type { StepContext, RawOnlyTrace } from '../types.js';
import { BaseStep, type StepDeps } from './StepBase.js';

export class ReevalRawOnlyStep extends BaseStep {
  readonly name = 'reeval_raw_only' as const;
  readonly description = 'RAW_ONLY 条目带上下文复评';

  constructor(deps: StepDeps) { super(deps); }

  shouldSkipInNap(): boolean { return false; }

  protected async execute(ctx: StepContext): Promise<{ itemsProcessed: number; llmCalls: number; tokensUsed: number }> {
    // 查询 conversations 表中 gate=RAW_ONLY 的条目（M2 阶段写入的 wm_buffer 或 conversations）
    const rawOnlyRows = this.deps.db.prepare(`
      SELECT c.id, c.message_id, c.content, c.ts_utc, c.episode_id, c.namespace
      FROM conversations c
      WHERE c.lifecycle_state = 'raw_only'
        AND c.namespace = ?
      ORDER BY c.ts_utc ASC
      LIMIT ?
    `).all(this.deps.namespace, this.deps.quota.maxRawReevalPerCycle) as RawOnlyRow[];

    let llmCalls = 0;
    let tokensUsed = 0;
    const promoted: string[] = [];

    for (const row of rawOnlyRows) {
      // 复评逻辑：检查上下文是否有足够支撑晋升
      // 规则版：如果同 episode 内已有 WRITE 条目，且当前内容相关 → 晋升
      const contextCount = this.deps.db.prepare(`
        SELECT COUNT(*) as cnt FROM conversations
        WHERE episode_id = ? AND lifecycle_state = 'fresh'
      `).get(row.episode_id) as { cnt: number };

      // 简单规则：同 episode 已有 ≥2 条正式记忆，则该 RAW_ONLY 晋升
      const shouldPromote = contextCount.cnt >= 2;

      if (shouldPromote) {
        // 晋升：创建 memories 记录（走 M1 WriteQueue 接口约定）
        const traceId = `trace_${row.message_id}`;
        this.createMemoryTrace(traceId, row);
        // 更新 conversations 状态
        this.deps.db.prepare(`
          UPDATE conversations SET lifecycle_state = 'fresh' WHERE id = ?
        `).run(row.id);
        promoted.push(traceId);
      } else {
        // 仍保留为 raw_only，等下一个周期再评
      }
    }

    ctx.reevaluatedTraces = promoted;
    return {
      itemsProcessed: rawOnlyRows.length,
      llmCalls,
      tokensUsed,
    };
  }

  private createMemoryTrace(traceId: string, row: RawOnlyRow): void {
    const now = Date.now();
    this.deps.db.prepare(`
      INSERT OR IGNORE INTO memories (
        id, namespace, raw_input, summary, consolidation,
        n_refs, first_ref_at, created_at, lifecycle_state,
        episode_id
      ) VALUES (?, ?, ?, NULL, 0.1, 1, ?, ?, 'fresh', ?)
    `).run(traceId, row.namespace, row.content, row.ts_utc, now, row.episode_id ?? null);
  }
}

interface RawOnlyRow {
  id: number;
  message_id: string;
  content: string;
  ts_utc: number;
  episode_id: string | null;
  namespace: string;
}
