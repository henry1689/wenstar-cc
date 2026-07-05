/**
 * MemoryAssessor — 三库自动流转调度器
 *
 * v2: 所有硬编码阈值/周期从 MemoryConfig 读取。
 *     新增幂等校验，防止重复晋升。
 */
import type { FusionStorageAdapter } from '../../m2/FusionStorageAdapter.js';
import { autoPromoteCandidatesV2 } from './VaultManager.js';
import { MEMORY_CONFIG } from '../../config/MemoryConfig.js';

export class MemoryAssessor {
  private storage: FusionStorageAdapter;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private started = false;

  constructor(storage: FusionStorageAdapter) {
    this.storage = storage;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    console.log('[MemoryAssessor] 启动三库流转调度器');

    this.schedule('sandToGold', MEMORY_CONFIG.sandToGold.intervalMs, () => this.runSandToGold());
    this.schedule('goldToDiamond', MEMORY_CONFIG.goldToDiamond.intervalMs, () => this.runGoldToDiamond());
    this.schedule('decay', MEMORY_CONFIG.decay.intervalMs, () => this.runDecay());
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.started = false;
  }

  private schedule(name: string, interval: number, fn: () => Promise<void>): void {
    const tick = () => {
      fn().catch(err => console.warn(`[MemoryAssessor] ${name} 失败:`, err));
      this.timers.push(setTimeout(tick, interval));
    };
    this.timers.push(setTimeout(tick, Math.random() * 60000 + 5000));
  }

  // ── ① 砂金库→金库 ──

  private async runSandToGold(): Promise<void> {
    const cfg = MEMORY_CONFIG.sandToGold;
    try {
      const sqlite = this.storage.getSQLite();
      const recentConvs = sqlite.queryAll(
        `SELECT id, role, content, calcium_score, entity_json, dna_root_id, timestamp
         FROM conversations
         WHERE is_promoted = 0 AND calcium_score >= ?
         ORDER BY calcium_score DESC LIMIT ?`,
        [cfg.minCalciumScore, cfg.batchSize]
      ) as any[];

      if (recentConvs.length === 0) {
        console.log('[MemoryAssessor] 砂金→金库: 无待晋升数据');
        return;
      }

      let promoted = 0;
      sqlite.writeRaw('BEGIN');

      for (const conv of recentConvs) {
        if (conv.role !== 'user') continue;
        const text = (conv.content || '') as string;
        if (text.length < cfg.minContentLength) continue;

        const dnaRootId = conv.dna_root_id || `sand_fallback_${Date.now()}`;
        const memoryId = `mem_${dnaRootId}`;

        try {
          // 幂等：已存在则跳过
          const exist = sqlite.queryAll('SELECT id FROM memories WHERE id = ? LIMIT 1', [memoryId]);
          if (exist.length > 0) continue;

          sqlite.writeRaw(
            `INSERT INTO memories
             (id, raw_input, entity_genes, created_at, calcium_score, calcium_level, effective_strength, dna_root_id, strength_updated_at, namespace)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [memoryId, text.substring(0, 500),
             conv.entity_json || '[]',
             new Date().toISOString(),
             conv.calcium_score,
             Math.min(3, Math.floor(conv.calcium_score)),
             Math.min(1.0, conv.calcium_score / 10),
             dnaRootId,
             new Date().toISOString(),
             'default']
          );
          sqlite.writeRaw('UPDATE conversations SET is_promoted = 1 WHERE id = ?', [conv.id]);
          promoted++;
        } catch { /* 去重跳过 */ }
      }

      sqlite.writeRaw('COMMIT');
      if (promoted > 0) {
        console.log(`[MemoryAssessor] 砂金→金库: ${promoted} 条 (calcium>=${cfg.minCalciumScore})`);
      }
    } catch (err) {
      console.warn('[MemoryAssessor] 砂金→金库失败:', err);
    }
  }

  // ── ② 金库→黑钻 ──

  private async runGoldToDiamond(): Promise<void> {
    try {
      const sqlite = this.storage.getSQLite();
      const entries = autoPromoteCandidatesV2(sqlite, MEMORY_CONFIG.goldToDiamond.batchSize);
      if (entries.length > 0) {
        console.log(`[MemoryAssessor] 金库→黑钻: ${entries.length} 条`);
      }
    } catch (err) {
      console.warn('[MemoryAssessor] 金库→黑钻失败:', err);
    }
  }

  // ── ③ 钙化分衰减 ──

  private async runDecay(): Promise<void> {
    const dc = MEMORY_CONFIG.decay;
    try {
      const sqlite = this.storage.getSQLite();
      const now = new Date().toISOString();

      // 强烈情感记忆 (calcium >= 3) → 极慢衰减
      sqlite.writeRaw(
        `UPDATE memories SET calcium_score = ROUND(MAX(?, calcium_score - ?), 1),
         effective_strength = ROUND(MAX(?, effective_strength * ?), 4),
         strength_updated_at = ?
         WHERE calcium_score > 0 AND is_promoted = 0 AND calcium_score >= 3.0`,
        [MEMORY_CONFIG.recall.calciumMin, dc.highCalciumDecay,
         dc.strengthFloor, dc.highStrengthFactor, now]
      );

      // 工作相关记忆 → 慢衰减
      sqlite.writeRaw(
        `UPDATE memories SET calcium_score = ROUND(MAX(?, calcium_score - ?), 1),
         effective_strength = ROUND(MAX(?, effective_strength * ?), 4),
         strength_updated_at = ?
         WHERE calcium_score > 0 AND is_promoted = 0 AND calcium_score < 3.0
         AND (COALESCE(narrative_tag, '') LIKE '%工作%' OR COALESCE(narrative_tag, '') LIKE '%项目%'
              OR COALESCE(narrative_tag, '') LIKE '%公司%' OR COALESCE(narrative_tag, '') LIKE '%会议%')`,
        [MEMORY_CONFIG.recall.calciumMin, dc.workDecay,
         dc.strengthFloor, dc.workStrengthFactor, now]
      );

      // 普通中性记忆 → 正常衰减
      sqlite.writeRaw(
        `UPDATE memories SET calcium_score = ROUND(MAX(?, calcium_score - ?), 1),
         effective_strength = ROUND(MAX(?, effective_strength * ?), 4),
         strength_updated_at = ?
         WHERE calcium_score > 0 AND is_promoted = 0 AND calcium_score < 3.0
         AND (COALESCE(narrative_tag, '') NOT LIKE '%工作%' AND COALESCE(narrative_tag, '') NOT LIKE '%项目%'
              AND COALESCE(narrative_tag, '') NOT LIKE '%公司%' AND COALESCE(narrative_tag, '') NOT LIKE '%会议%')`,
        [MEMORY_CONFIG.recall.calciumMin, dc.normalDecay,
         dc.strengthFloor, dc.normalStrengthFactor, now]
      );

      console.log('[MemoryAssessor] 钙化分衰减完成');
    } catch (err) {
      console.warn('[MemoryAssessor] 钙化分衰减失败:', err);
    }
  }

  async triggerSandToGold(): Promise<number> {
    await this.runSandToGold();
    const sqlite = this.storage.getSQLite();
    const count = sqlite.queryAll('SELECT COUNT(*) as c FROM memories') as any[];
    return count[0]?.c || 0;
  }

  async triggerGoldToDiamond(): Promise<number> {
    await this.runGoldToDiamond();
    const sqlite = this.storage.getSQLite();
    const count = sqlite.queryAll('SELECT COUNT(*) as c FROM black_diamond') as any[];
    return count[0]?.c || 0;
  }
}
