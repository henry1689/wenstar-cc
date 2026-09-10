/**
 * EntityStrengthTracker — 实体关联强度管理 (含衰减)
 * ===================================================
 * 管理 entity_relations 表中的关联强度:
 *   - boost(): 共现时增加强度 (含自适应学习率)
 *   - decayAll(): 每日衰减 (7天无共现×0.9)
 *   - getStrength(): 查询当前强度
 *
 * 表结构 (使用已有的 entity_relations 表):
 *   entity_a_id, entity_b_id, relation, strength, created_at, updated_at
 */
import type { FusionStorageAdapter } from '../../m2/FusionStorageAdapter.js';
import { LEARNING_CONFIG } from '../../config/learning-config.js';

export class EntityStrengthTracker {
  private storage: FusionStorageAdapter;

  constructor(storage: FusionStorageAdapter) {
    this.storage = storage;
  }

  /**
   * 增强实体关联强度 (累计)
   * 同轮共现 +strength, 同对话组 +strength×0.5
   */
  async boost(
    entityA: string,
    entityB: string,
    strength: number,
    isSameGroup = true,
  ): Promise<void> {
    try {
      const sqlite = this.storage.getSQLite();
      const effectiveStrength = isSameGroup ? strength : strength * 0.5;

      // 确保实体存在
      for (const name of [entityA, entityB]) {
        const existing = sqlite.queryAll('SELECT id FROM entities WHERE name = ? LIMIT 1', [name]);
        if (existing.length === 0) {
          sqlite.writeRaw('INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)', [name, 'person']);
        }
      }

      // 更新或插入关联
      sqlite.writeRaw(
        `INSERT INTO entity_relations (entity_a_id, entity_b_id, relation, strength, updated_at)
         VALUES (
           (SELECT id FROM entities WHERE name = ? LIMIT 1),
           (SELECT id FROM entities WHERE name = ? LIMIT 1),
           'co_occurrence', ?, ?
         )
         ON CONFLICT(entity_a_id, entity_b_id, relation) DO UPDATE SET
           strength = MIN(1.0, strength + ?),
           updated_at = ?`,
        [
          entityA, entityB,
          effectiveStrength, new Date().toISOString(),
          effectiveStrength,
          new Date().toISOString(),
        ],
      );
    } catch (e) {
      console.error('[EntityStrengthTracker] boost 失败:', (e as Error)?.message || e);
    }
  }

  /**
   * 每日衰减: 7天无共现的实体关联强度 ×0.9
   * 应每天调用一次 (由定时任务或 M7 触发)
   */
  async decayAll(): Promise<number> {
    try {
      const sqlite = this.storage.getSQLite();
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      sqlite.writeRaw(
        `UPDATE entity_relations SET strength = MAX(0.01, strength * ?)
         WHERE relation = 'co_occurrence' AND updated_at < ?
         AND strength > 0.01`,
        [LEARNING_CONFIG.ENTITY_DECAY_FACTOR, cutoff],
      );
      const affected = sqlite.queryAll(
        `SELECT changes() as cnt`,
      );
      return (affected[0]?.cnt as number) || 0;
    } catch { return 0; }
  }

  /**
   * 查询实体关联强度
   */
  async getStrength(entityA: string, entityB: string): Promise<number> {
    try {
      const sqlite = this.storage.getSQLite();
      const rows = sqlite.queryAll(
        `SELECT strength FROM entity_relations er
         JOIN entities ea ON er.entity_a_id = ea.id
         JOIN entities eb ON er.entity_b_id = eb.id
         WHERE ea.name = ? AND eb.name = ? AND er.relation = 'co_occurrence'
         LIMIT 1`,
        [entityA, entityB],
      );
      return rows.length > 0 ? (rows[0].strength as number) : 0;
    } catch { return 0; }
  }

  /**
   * 清理低频实体 (7天无提及且强度<0.1的可移除)
   */
  async cleanStale(threshold = 0.1): Promise<number> {
    try {
      const sqlite = this.storage.getSQLite();
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      sqlite.writeRaw(
        `DELETE FROM entity_relations WHERE relation = 'co_occurrence'
         AND strength < ? AND updated_at < ?`,
        [threshold, cutoff],
      );
      const affected = sqlite.queryAll(`SELECT changes() as cnt`);
      return (affected[0]?.cnt as number) || 0;
    } catch { return 0; }
  }
}
