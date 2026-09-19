/**
 * AutoLearnPlugin V2 — 多维度增量自主学习引擎
 * ============================================
 * 每次对话结束时异步执行：
 *   ① 实体关联强度 (增强: 累计计数+衰减)
 *   ② 情感向量在线校准 (学习率偏移基准)
 *   ③ 收敛速度自适应 (高频×0.5, 低频×2)
 *   ④ 冲突检测 (对立描述标记)
 *   ⑤ 新知识冷启动助推 (72h×1.3)
 *
 * 不阻塞主回复流程（在 respond() 返回后 fire-and-forget）。
 * 适配: 知识库自学习改善方案 Phase 1
 */
import type { FusionStorageAdapter } from '../../m2/FusionStorageAdapter.js';
import type { Perception24D } from '../../m3/types/perception.js';
import type { EntityGene } from '../../m1/types/dna.js';
import { EntityStrengthTracker } from './EntityStrengthTracker.js';
import { EmotionBaseline } from './EmotionBaseline.js';
import { ConflictDetector } from './ConflictDetector.js';
import { LEARNING_CONFIG } from '../../config/learning-config.js';

export class AutoLearnPlugin {
  private storage: FusionStorageAdapter;
  private strengthTracker: EntityStrengthTracker;
  private emotionBaseline: EmotionBaseline;
  private conflictDetector: ConflictDetector;

  /** 每会话话题频次统计 (高频/低频检测) */
  private _topicCounts = new Map<string, { count: number; firstSeen: number }>();

  constructor(storage: FusionStorageAdapter) {
    this.storage = storage;
    this.strengthTracker = new EntityStrengthTracker(storage);
    this.emotionBaseline = new EmotionBaseline(storage);
    this.conflictDetector = new ConflictDetector(storage);
  }

  /**
   * 对话结束时增量学习
   * @param entities 本轮消息中的实体
   * @param perception 当前 24D 感知
   * @param message 用户消息
   */
  async learn(
    entities: EntityGene[],
    perception: Perception24D,
    message: string,
  ): Promise<void> {
    try {
      const sqlite = this.storage.getSQLite();
      const personNames = entities
        .filter(e => e.type === 'person' && e.name !== '我' && e.name.length > 1)
        .map(e => e.name);

      // ── ① 实体关联强度 (增强版: 累计+衰减+自适应学习率) ──
      if (personNames.length >= 2) {
        for (let i = 0; i < personNames.length; i++) {
          for (let j = i + 1; j < personNames.length; j++) {
            const rate = this._getAdaptiveRate(personNames[i], personNames[j]);
            await this.strengthTracker.boost(personNames[i], personNames[j], rate);
          }
        }
      }

      // 非人物实体→人物关联
      const nonPersonEntities = entities
        .filter(e => e.type !== 'person' && e.name !== '某')
        .map(e => e.name);
      for (const p of personNames) {
        for (const np of nonPersonEntities) {
          await this.strengthTracker.boost(p, np, LEARNING_CONFIG.ENTITY_DISCUSSED_STRENGTH);
        }
      }

      // ── ② 情感向量在线校准 ──
      await this.emotionBaseline.update(perception);

      // ── ③ 话题频次统计 (自适应学习率数据源) ──
      const locusPath = (entities as any).locus_path || '';
      if (locusPath) {
        const now = Date.now();
        const existing = this._topicCounts.get(locusPath) || { count: 0, firstSeen: now };
        existing.count++;
        this._topicCounts.set(locusPath, existing);
      }

      // ── ④ 冲突检测 ──
      for (const entity of entities) {
        if (entity.type !== 'person' && entity.type !== 'emotion') continue;
        // 🔴 2026-09-19 户管管理法（写入端修复）：把 EntityGene.uuid 传给冲突检测器。
        //   EntityGene.uuid 是 L3 标注时从 FamilyGraph 解析的**权威户籍值**（见 m1/types/dna.ts:123），
        //   与 SQLiteAdapter 使用 gene.uuid 的既定惯例一致；本处是 ConflictDetector.check 的**唯一调用方**
        //   （全仓 grep 确认），uuid 只能在此传入。pass-through 而不是在检测器内重查 FG，
        //   避免二次解析引入不一致。
        await this.conflictDetector.check(
          entity.name,
          message,
          entity.type,
          perception,
          entity.uuid ?? null,
        );
      }

      // ── ⑤ 新知识冷启动助推 (由 KnowledgeEngine 在检索时独立处理) ──
      // 此处只需确保 knowledge_base.created_at 正确，检索时机由 KnowledgeEngine 决定

      console.log(`[AutoLearn V2] 更新: ${personNames.length}实体, ${nonPersonEntities.length}关联, 情感基准校准`);
    } catch (err) {
      console.warn('[AutoLearn V2] 学习失败:', err);
    }
  }

  /**
   * 自适应学习率: 高频话题降速, 低频话题加速
   * 基于话题路径 (locus_path) 的频次统计
   */
  private _getAdaptiveRate(entityA: string, entityB: string): number {
    const base = LEARNING_CONFIG.ENTITY_CO_OCCUR_STRENGTH;

    // 简单启发: 同一对话组高频共现 → 降低学习率
    const key = `${entityA}:${entityB}`;
    const stat = this._topicCounts.get(key);
    if (!stat) return base;

    const hoursElapsed = (Date.now() - stat.firstSeen) / 3_600_000;
    const freqPerHour = hoursElapsed > 0 ? stat.count / hoursElapsed : stat.count;

    // 高频 (>5次/小时) → 学习率×0.5
    if (freqPerHour > 5) return base * 0.5;
    // 低频 (<0.2次/小时) → 学习率×2
    if (freqPerHour < 0.2) return Math.min(base * 2, 1.0);
    return base;
  }

  /** 获取当前情感基准 (供外部读取) */
  async getEmotionBaseline(): Promise<{ pleasure: number; arousal: number; intimacy: number } | null> {
    return this.emotionBaseline.get();
  }

  /** 重置会话级统计 (每次新对话开始时调用) */
  resetSession(): void {
    this._topicCounts.clear();
  }
}
