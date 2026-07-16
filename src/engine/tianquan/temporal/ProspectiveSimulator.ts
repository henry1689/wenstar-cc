/**
 * ProspectiveSimulator.ts — 前瞻性模拟器 (V3.1)
 * ==============================================
 * 仿人脑海马体核心高阶功能：用旧的记忆碎片拼装未来场景。
 *
 * 不是调LLM做开放想象（太重），而是做模式匹配推理——
 * 从过去相似场景的发展轨迹中，提取最可能的结局模式。
 *
 * 触发方式: API 调用（/api/simulate?q=...），不阻塞日常对话。
 * δ 节律预计算高频场景的模拟缓存，降低在线延迟。
 *
 * 使用:
 *   const sim = new ProspectiveSimulator(sqlite);
 *   const result = sim.simulate({ topic: '工作', entities: ['老板'], emotion: 'neg' }, '今天不加班');
 *   // → { predictedOutcome, confidence, basisMemories, alternatives }
 */
import type { SQLiteAdapter } from '../../../m2/SQLiteAdapter.js';

export interface SimulationResult {
  /** 预测的最可能结局 */
  predictedOutcome: string;
  /** 置信度 [0,1] */
  confidence: number;
  /** 作为预测依据的记忆ID */
  basisMemories: string[];
  /** 备选结局 */
  alternatives: string[];
  /** 相似场景数 */
  matchedScenes: number;
}

export class ProspectiveSimulator {
  private sqlite: SQLiteAdapter;

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
  }

  /**
   * 前瞻性模拟
   * @param context 当前上下文 { topic, entities, emotion }
   * @param proposedAction 用户需要预判的行为，如"不加班"、"辞职"、"搬家"
   */
  simulate(
    context: { topic: string; entities: string[]; emotion: string },
    proposedAction: string,
  ): SimulationResult {
    const result: SimulationResult = {
      predictedOutcome: '',
      confidence: 0,
      basisMemories: [],
      alternatives: [],
      matchedScenes: 0,
    };

    try {
      // 1. 从 memories 查相似话题 + 相似情绪的场景
      const likeClause = context.entities.map(() => 'entity_names LIKE ?').join(' OR ');
      const params: string[] = [];
      for (const e of context.entities.slice(0, 3)) {
        params.push(`%${e}%`);
      }

      const topicClause = context.topic ? 'raw_input LIKE ?' : '1=1';
      if (context.topic) params.push(`%${context.topic}%`);

      const sql = `SELECT id, raw_input, calcium_score, entity_names, created_at, perception_json
        FROM memories WHERE (${likeClause} OR ${topicClause})
        AND lifecycle_state != 'suppressed'
        ORDER BY created_at DESC LIMIT 20`;

      // 合并参数：先 entity 的 LIKE 参数，再 topic 的
      const rows = this.sqlite.queryAll(sql, params.length > 0 ? params : undefined);
      if (!rows || rows.length < 2) return result;

      result.matchedScenes = rows.length;

      // 2. 对每个相似场景，查它的后续发展（时间+1h、+1d、+1w 的消息）
      const outcomes: Array<{ scene: string; trend: 'positive' | 'negative' | 'neutral'; delta: number }> = [];

      for (const row of rows.slice(0, 10)) {
        try {
          const memId = (row as any).id;
          const createdAt = new Date((row as any).created_at || Date.now());
          const perc = JSON.parse((row as any).perception_json || '{}');
          const origPleasure = perc.pleasure || 0;
          const scene = ((row as any).raw_input || '').substring(0, 50);

          // 查询该场景之后 1 小时到 1 周内的后续消息
          const afterStart = new Date(createdAt.getTime() + 3600000).toISOString();
          const afterEnd = new Date(createdAt.getTime() + 7 * 86400000).toISOString();

          const followUps = this.sqlite.queryAll(
            `SELECT perception_json FROM memories WHERE created_at > ? AND created_at < ? AND id != ? ORDER BY created_at ASC LIMIT 5`,
            [afterStart, afterEnd, memId]
          );

          if (followUps && followUps.length > 0) {
            let totalDelta = 0;
            for (const fu of followUps) {
              const fuPerc = JSON.parse((fu as any).perception_json || '{}');
              totalDelta += (fuPerc.pleasure || 0) - origPleasure;
            }
            const avgDelta = totalDelta / followUps.length;
            const trend = avgDelta > 0.1 ? 'positive' : avgDelta < -0.1 ? 'negative' : 'neutral';
            outcomes.push({ scene, trend, delta: avgDelta });
            result.basisMemories.push(memId);
          }
        } catch (e) { console.warn(`[ProspectiveSimulator] 操作失败`, (e as Error)?.message || e); }
      }

      if (outcomes.length === 0) return result;

      // 3. 统计结局分布
      const posCount = outcomes.filter(o => o.trend === 'positive').length;
      const negCount = outcomes.filter(o => o.trend === 'negative').length;
      const neuCount = outcomes.filter(o => o.trend === 'neutral').length;

      const total = outcomes.length;
      result.confidence = Math.min(0.8, total / 15); // 越多样本越可信，上限0.8

      // 4. 生成预测
      if (posCount > negCount && posCount > neuCount) {
        result.predictedOutcome = `${posCount}/${total} 次类似场景后情绪好转。预判：${proposedAction}后，较大概率情绪改善。`;
        const bestScene = outcomes.filter(o => o.trend === 'positive').sort((a, b) => b.delta - a.delta)[0];
        if (bestScene) result.predictedOutcome += ` 参考：'${bestScene.scene}' 之后情绪明显回升。`;
      } else if (negCount > posCount && negCount > neuCount) {
        result.predictedOutcome = `${negCount}/${total} 次类似场景后情绪恶化。预判：${proposedAction}可能带来更多压力。`;
        const worstScene = outcomes.filter(o => o.trend === 'negative').sort((a, b) => a.delta - b.delta)[0];
        if (worstScene) result.predictedOutcome += ` 参考：'${worstScene.scene}' 之后情绪走低。`;
      } else {
        result.predictedOutcome = `结果不确定（${posCount}好转/${negCount}恶化/${neuCount}不变）。预判：${proposedAction}的影响取决于具体情境。`;
      }

      // 5. 备选场景（趋势相反的那组）
      if (posCount > 0 && negCount > 0) {
        result.alternatives.push('也有' + negCount + '次类似场景后情绪未能改善');
      }
      if (neuCount > total * 0.3) {
        result.alternatives.push('还有' + neuCount + '次类似场景后情绪无明显变化');
      }

    } catch (err) {
      console.warn('[ProspectiveSimulator] 模拟失败:', err);
    }

    return result;
  }

  /**
   * δ 节律预计算: 对高频话题提前生成模拟缓存，写入知识库
   */
  async precomputeHighFreqScenes(topN = 10): Promise<number> {
    try {
      // 从 hippocampal_index 取钙化最高的上下文签名
      const rows = this.sqlite.queryAll(
        "SELECT context_signature, calcium_boost, experience_summary FROM hippocampal_index WHERE calcium_boost > 0.5 ORDER BY calcium_boost DESC LIMIT ?",
        [topN]
      );
      let computed = 0;
      for (const row of rows) {
        try {
          const sig = (row as any).context_signature as string;
          if (sig.startsWith('exp:')) continue; // 跳过经验条目
          const topics = sig.split('|').filter(Boolean);
          const result = this.simulate(
            { topic: topics[0] || '', entities: topics.slice(1), emotion: 'neu' },
            '类似情况',
          );
          if (result.confidence > 0.3) {
            // 预计算结果存入知识库
            this.sqlite.writeRaw(
              `INSERT OR REPLACE INTO knowledge_base (id, title, content, source_type, tags, created_at, updated_at, locked, classification, classification_pending, interaction_type)
               VALUES (?, ?, ?, 'prospective_simulation', ?, ?, ?, 1, '前瞻模拟', 0, 'other')`,
              [`ps_${sig.substring(0, 12)}`, `模拟: ${topics[0] || sig}`, result.predictedOutcome,
               JSON.stringify(['prospective_simulation', 'precompute']),
               new Date().toISOString(), new Date().toISOString()]
            );
            computed++;
          }
        } catch (e) { console.warn(`[ProspectiveSimulator] 操作失败`, (e as Error)?.message || e); }
      }
      return computed;
    } catch { return 0; }
  }
}
