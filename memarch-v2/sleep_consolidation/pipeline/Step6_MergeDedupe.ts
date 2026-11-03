/**
 * 步骤6：合并去重
 * 相似记忆合并，n_refs 累加，版本链更新
 * 幂等：同一条目重复执行不产生重复记录
 */

import type { StepContext } from '../types.js';
import { BaseStep, type StepDeps } from './StepBase.js';

export class MergeDedupeStep extends BaseStep {
  readonly name = 'merge_dedupe' as const;
  readonly description = '相似记忆合并去重';

  constructor(deps: StepDeps) { super(deps); }

  shouldSkipInNap(): boolean { return true; }

  protected async execute(ctx: StepContext): Promise<{ itemsProcessed: number; llmCalls: number; tokensUsed: number }> {
    // 简化版合并：基于 raw_input 文本相似度（哈希近似 + 前缀匹配）
    // 生产环境应使用向量余弦相似度（vec0），此处为规则兜底
    const candidates = this.deps.db.prepare(`
      SELECT id, raw_input, summary, n_refs, consolidation, created_at, namespace
      FROM memories
      WHERE namespace = ?
        AND suppressed = 0
        AND lifecycle_state NOT IN ('purged', 'tombstone')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(this.deps.namespace, 5000) as MemoryRow[];

    const merged: string[] = [];
    const now = Date.now();
    const mergeBatch = this.deps.quota.mergeBatchSize;

    // 按文本前缀分组做近似去重（简化版）
    const groups = this.groupBySimilarity(candidates);

    for (const group of groups) {
      if (group.length < 2) continue;
      if (merged.length >= mergeBatch) break;

      // 保留最新的一条，其余合并
      const primary = group[0];
      const others = group.slice(1);

      const tx = this.deps.db.transaction(() => {
        let totalRefs = primary.n_refs;
        let maxConsolidation = primary.consolidation;

        for (const other of others) {
          totalRefs += other.n_refs;
          maxConsolidation = Math.max(maxConsolidation, other.consolidation);

          // 将旧条目标记为被合并（suppressed + 记录 supersedes）
          this.deps.db.prepare(`
            UPDATE memories
            SET suppressed = 1, supersedes_id = ?, version = version + 1
            WHERE id = ?
          `).run(primary.id, other.id);
        }

        // 更新主条目的引用数和巩固度
        this.deps.db.prepare(`
          UPDATE memories SET n_refs = ?, consolidation = ? WHERE id = ?
        `).run(totalRefs, maxConsolidation, primary.id);

        merged.push(primary.id);
      });

      tx();
    }

    ctx.mergedTraces = merged;
    return {
      itemsProcessed: merged.length,
      llmCalls: 0,
      tokensUsed: 0,
    };
  }

  /** 简化相似度分组：按前 30 字符前缀分组 */
  private groupBySimilarity(rows: MemoryRow[]): MemoryRow[][] {
    const map = new Map<string, MemoryRow[]>();
    for (const row of rows) {
      const text = (row.summary ?? row.raw_input ?? '').trim();
      if (!text) continue;
      const prefix = text.slice(0, 30).toLowerCase();
      if (!map.has(prefix)) map.set(prefix, []);
      map.get(prefix)!.push(row);
    }
    return Array.from(map.values()).filter(g => g.length > 0);
  }
}

interface MemoryRow {
  id: string;
  raw_input: string | null;
  summary: string | null;
  n_refs: number;
  consolidation: number;
  created_at: number;
  namespace: string;
}
