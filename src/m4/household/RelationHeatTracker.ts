/**
 * RelationHeatTracker — 关系热力追踪与自动升级引擎
 *
 * 定位：根据用户与实体的互动频次和情绪强度，自动计算关系热力值，
 * 并在达到阈值时自动升级关系状态。
 *
 * 架构原则：
 * - 热力升级只影响门阀的数据访问权限和称谓语气
 * - 不改变 FG 关系边的客观事实（mother_of 永远是 mother_of）
 * - 热力值存储在 edges.properties 的 _heat_score 和 _relation_warmth 字段
 *
 * 公式: heat = 频次因子 × 情绪因子 × 衰减因子
 */

import type { FamilyGraph } from './FamilyGraph.js';

/** 关系热力状态 */
export interface RelationHeatState {
  uuid: string;
  heatScore: number;
  warmth: 'distant' | 'friendly' | 'trusted' | 'intimate' | 'soulmate';
  interactionCount30d: number;
  avgIntimacy: number;
  lastInteraction: string;
}

/** 升级结果 */
export interface UpgradeResult {
  upgraded: boolean;
  from: string;
  to: string;
  previousHeat: number;
  newHeat: number;
}

export class RelationHeatTracker {
  private familyGraph: FamilyGraph;

  constructor(familyGraph: FamilyGraph) {
    this.familyGraph = familyGraph;
  }

  // ═══════════════════════════════════════════════════════════════
  // 热力计算
  // ═══════════════════════════════════════════════════════════════

  /**
   * 计算指定 UUID 的当前热力值
   */
  async computeHeat(uuid: string): Promise<RelationHeatState> {
    const entity = this.familyGraph.getEntityByUUID(uuid);
    const defaultState: RelationHeatState = {
      uuid,
      heatScore: 0,
      warmth: 'distant',
      interactionCount30d: 0,
      avgIntimacy: 0,
      lastInteraction: '',
    };

    if (!entity) return defaultState;

    // 从 edges.properties 读取历史数据
    const edges = this._getEdgesForEntity(entity.id);
    let interactionCount30d = 0;
    let totalIntimacy = 0;
    let intimacySamples = 0;
    let lastInteraction = '';

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 86400_000;

    for (const edge of edges) {
      const props = edge.properties ? JSON.parse(edge.properties) : {};
      const interactions = props._interactions || [];
      for (const ix of interactions) {
        const ixTime = new Date(ix.timestamp || 0).getTime();
        if (ixTime > thirtyDaysAgo) {
          interactionCount30d++;
          if (typeof ix.intimacy === 'number') {
            totalIntimacy += ix.intimacy;
            intimacySamples++;
          }
        }
        if (ix.timestamp && ix.timestamp > lastInteraction) {
          lastInteraction = ix.timestamp;
        }
      }
    }

    const avgIntimacy = intimacySamples > 0 ? totalIntimacy / intimacySamples : 0;

    // 频次因子: min(count/30, 1.0)
    const frequencyFactor = Math.min(interactionCount30d / 30, 1.0);

    // 情绪因子: avg(intimacy) + 1 (映射到 0~2)
    const emotionFactor = Math.max(0, avgIntimacy + 1);

    // 衰减因子: 按最近交互距离
    let decayFactor = 1.0;
    if (lastInteraction) {
      const daysSince = (now - new Date(lastInteraction).getTime()) / 86400_000;
      if (daysSince > 30) decayFactor = 0.7;
      else if (daysSince > 7) decayFactor = 0.9;
    }

    const heatScore = Math.round(frequencyFactor * emotionFactor * decayFactor * 1000) / 1000;

    const warmth = this._heatToWarmth(heatScore);

    return {
      uuid,
      heatScore,
      warmth,
      interactionCount30d,
      avgIntimacy: Math.round(avgIntimacy * 100) / 100,
      lastInteraction,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 热力更新（每次对话后调用）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 记录一次互动并更新热力
   */
  async updateHeat(
    uuid: string,
    perception: { intimacy?: number; pleasure?: number; arousal?: number }
  ): Promise<void> {
    const entity = this.familyGraph.getEntityByUUID(uuid);
    if (!entity) return;

    const edges = this._getEdgesForEntity(entity.id);
    // 🔴 只写到一条边（第一条 = 最核心的关系边），避免同一互动被 computeHeat 重复计数
    if (edges.length === 0) return;

    const edge = edges[0];
    const now = new Date().toISOString();
    const props = edge.properties ? JSON.parse(edge.properties) : {};
    if (!props._interactions) props._interactions = [];

    // 追加本次互动
    props._interactions.push({
      timestamp: now,
      intimacy: perception.intimacy ?? 0,
      pleasure: perception.pleasure ?? 0,
      arousal: perception.arousal ?? 0,
    });

    // 只保留最近 100 条（控制数据量）
    if (props._interactions.length > 100) {
      props._interactions = props._interactions.slice(-100);
    }

    // 更新热力评分
    const state = await this.computeHeat(uuid);
    props._heat_score = state.heatScore;
    props._relation_warmth = state.warmth;

    this._updateEdgeProperties(edge.id, props);
  }

  // ═══════════════════════════════════════════════════════════════
  // 关系升级检查
  // ═══════════════════════════════════════════════════════════════

  /**
   * 检查是否需要升级关系状态。
   * 升级只影响 warmth 标签——不改变 FG 关系边类型。
   */
  async checkUpgrade(uuid: string): Promise<UpgradeResult | null> {
    const prevState = await this.computeHeat(uuid);
    const prevWarmth = prevState.warmth;

    // 无需升级的场景
    if (prevState.heatScore === 0 && prevWarmth === 'distant') return null;

    const newHeat = prevState.heatScore; // computeHeat 已即时计算

    // 检查是否跨越阈值
    const newWarmth = this._heatToWarmth(newHeat);
    if (newWarmth === prevWarmth) return null;

    // 更新 edges 中的 warmth 标签
    const entity = this.familyGraph.getEntityByUUID(uuid);
    if (!entity) return null;

    const edges = this._getEdgesForEntity(entity.id);
    for (const edge of edges) {
      const props = edge.properties ? JSON.parse(edge.properties) : {};
      props._heat_score = newHeat;
      props._relation_warmth = newWarmth;
      this._updateEdgeProperties(edge.id, props);
    }

    return {
      upgraded: true,
      from: prevWarmth,
      to: newWarmth,
      previousHeat: prevState.heatScore,
      newHeat,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // X-情人 自动升级
  // ═══════════════════════════════════════════════════════════════

  /**
   * 检查是否应升级为 X-情人。
   * 触发条件：热力 ≥ 0.8（intimate）且当前分类非 A（亲属）、非 X（已是情人）。
   * 陌生人、同事、朋友都可以通过热力升级为情人。
   */
  async checkXUpgrade(uuid: string): Promise<UpgradeResult | null> {
    const state = await this.computeHeat(uuid);
    if (state.heatScore < 0.8) return null;

    const entity = this.familyGraph.getEntityByUUID(uuid);
    if (!entity) return null;

    const currentCategory = entity.category || '';
    if (currentCategory === 'A' || currentCategory === 'X') return null;

    // V4.0: 仅更新 category 列，TXS-ID 终身不变
    try {
      (this.familyGraph as any).run(
        'UPDATE nodes SET category = ? WHERE id = ?',
        ['X', entity.id]
      );
    } catch { return null; }

    // V4.0: 记录分类变更到 dossier (通过 setCategory 统一入口)
    try {
      (this.familyGraph as any).setCategory?.(
        entity.name || (entity as any).node_name || '',
        'X',
        `热力升级: heat=${state.heatScore}, warmth=${state.warmth}`
      );
    } catch { /* 非关键 */ }

    return {
      upgraded: true,
      from: currentCategory || 'G',
      to: 'X',
      previousHeat: state.heatScore,
      newHeat: state.heatScore,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════════════════════════════

  private _heatToWarmth(heat: number): RelationHeatState['warmth'] {
    if (heat > 1.0) return 'soulmate';
    if (heat >= 0.8) return 'intimate';
    if (heat >= 0.5) return 'trusted';
    if (heat >= 0.2) return 'friendly';
    return 'distant';
  }

  private _getEdgesForEntity(nodeId: string): Array<{ id: string; properties: string }> {
    try {
      return (this.familyGraph as any).query(
        'SELECT id, properties FROM edges WHERE source_id = ? OR target_id = ?',
        [nodeId, nodeId]
      ) || [];
    } catch {
      return [];
    }
  }

  private _updateEdgeProperties(edgeId: string, props: Record<string, any>): void {
    try {
      (this.familyGraph as any).run(
        'UPDATE edges SET properties = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(props), new Date().toISOString(), edgeId]
      );
    } catch { /* 非关键 */ }
  }
}

export default RelationHeatTracker;
