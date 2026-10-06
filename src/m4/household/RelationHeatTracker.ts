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

    // 从 edges.properties 读取历史数据（🔴 A2：只读「实体 ↔ 用户」的关系边）
    const edges = this._getUserRelationEdges(entity.id);
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

    // 🔴 A2（2026-10-06）：热力只写「实体 ↔ 用户」这一条关系边。
    //   原实现 `_getEdgesForEntity` = `WHERE source_id=? OR target_id=?`（**无排序、无锚定**）后取 `edges[0]`，
    //   实测徐诗雨排第一的边是 `child_of→徐东伟`（她与**父亲**的边）⇒ 100 条亲密互动记录
    //   连同 warmth=soulmate/heat=1.066 被写到了父女边上，最终渲染成
    //   「鸿艺的孩子——亲密互动（热力追踪已确认）」。
    //   没有用户边 ⇒ 不写：宁可无热力，也不把亲密数据落到不相干的边上。
    const edges = this._getUserRelationEdges(entity.id);
    if (edges.length === 0) return;

    // 互动记录只落**一条**规范边（用户→实体），避免 computeHeat 跨边求和时同一互动被重复计数
    const userId = this._getUserNodeId();
    const canonical = edges.find((e) => e.source_id === userId) ?? edges[0];
    const now = new Date().toISOString();
    const props = canonical.properties ? JSON.parse(canonical.properties) : {};
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

    // 先落互动记录再算热力 —— 原实现是「先算后落盘」，computeHeat 读到的一直是落盘前的旧值
    this._updateEdgeProperties(canonical.id, props);

    // 更新热力评分（每条用户边都同步分数；只有规范边带互动记录）
    const state = await this.computeHeat(uuid);
    for (const e of edges) {
      const p = e.id === canonical.id ? props : (e.properties ? JSON.parse(e.properties) : {});
      p._heat_score = state.heatScore;
      p._relation_warmth = state.warmth;
      this._updateEdgeProperties(e.id, p);
    }
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

    const edges = this._getUserRelationEdges(entity.id);
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
    // 已是 X 则跳过
    if (currentCategory === 'X') return null;

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

  /** 用户锚点节点 id（"我"）—— 与 FamilyGraph._ensureSelfNode 同源，不另立常量 */
  private _getUserNodeId(): string | null {
    try {
      const fg = this.familyGraph as any;
      return typeof fg.getUserNodeId === 'function' ? fg.getUserNodeId() : null;
    } catch {
      return null;
    }
  }

  /**
   * 🔴 A2（2026-10-06）：只取「实体 ↔ 用户」的关系边 —— 热力的唯一落点。
   *
   * 原实现 `WHERE source_id = ? OR target_id = ?` 会返回该实体的**全部**边，
   * 调用方再盲取 `edges[0]` ⇒ 热力被写到一条与用户无关的边上（实测是父女边）。
   * 没有用户边时返回空数组，调用方据此**放弃写入**（宁缺勿滥）。
   */
  private _getUserRelationEdges(nodeId: string): Array<{ id: string; source_id: string; properties: string }> {
    try {
      const userId = this._getUserNodeId();
      if (!userId || userId === nodeId) return [];
      return (this.familyGraph as any).query(
        'SELECT id, source_id, properties FROM edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)',
        [nodeId, userId, userId, nodeId]
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
