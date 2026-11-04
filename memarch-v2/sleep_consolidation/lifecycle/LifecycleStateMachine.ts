/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / lifecycle/LifecycleStateMachine
 *
 * 生命周期状态机：fresh → weakening → expiring → tombstone → purged
 *                  fresh → consolidated（高显著性直接晋升）
 *
 * 状态转换规则（遵循主设计文档第五章）：
 *   - fresh:           新写入， consolidation < 0.2
 *   - weakening:       consolidation 衰减至 0.2~0.5，或连续 N 个周期未被激活
 *   - expiring:        consolidation < 0.2，或显著性持续偏低
 *   - consolidated:    consolidation ≥ 0.7，且经历过至少 3 个睡眠周期存活
 *   - tombstone:       标记删除，保留元数据（tombstones 表）
 *   - purged:          物理删除（过 purge_after 后）
 */

import type { LifecycleState } from '../types.js';

export interface TransitionInput {
  currentState: LifecycleState;
  consolidation: number;       // 巩固度 [0,1]
  activation: number;           // 激活度 [0,1]
  sleepCyclesSurvived: number;  // 存活睡眠周期数
  salience: number;             // 显著性 [0,1]
  nRefs: number;                // 被引用次数
  isLandmark: boolean;          // 地标记忆（黑钻）豁免
  anchorExempt: boolean;        // A 层豁免
  daysSinceLastRecall: number;  // 距上次回忆天数
}

export interface TransitionResult {
  nextState: LifecycleState;
  shouldPromote: boolean;       // 是否晋升（向上走）
  shouldDemote: boolean;        // 是否降级（向下走）
  reason: string;               // 转换原因
  deltaConsolidation?: number;  // 巩固度变化建议
}

export class LifecycleStateMachine {
  // 阈值常量（可调）
  private readonly THRESHOLDS = {
    consolidatedMin: 0.7,        // consolidation ≥ 0.7 → consolidated
    weakeningMax: 0.5,           // consolidation ≤ 0.5 → weakening 区间
    expiringMax: 0.2,            // consolidation ≤ 0.2 → expiring
    minCyclesForConsolidation: 3, // 至少存活 3 个睡眠周期
    saliencePromoteThreshold: 0.85, // 高显著性直接晋升 consolidated
    noRecallDaysWeakening: 7,    // 7 天未回忆 → weakening
    noRecallDaysExpiring: 30,    // 30 天未回忆 → expiring
  };

  /**
   * 状态推进核心算法
   * 每次睡眠周期对每条记忆调用一次
   */
  transition(input: TransitionInput): TransitionResult {
    const {
      currentState,
      consolidation,
      activation,
      sleepCyclesSurvived,
      salience,
      nRefs,
      isLandmark,
      anchorExempt,
      daysSinceLastRecall,
    } = input;

    // 黑钻 / 锚点记忆豁免衰减，永不降级
    if (isLandmark || anchorExempt) {
      return {
        nextState: currentState === 'fresh' ? 'consolidated' : currentState,
        shouldPromote: currentState === 'fresh',
        shouldDemote: false,
        reason: 'landmark/anchor exempt',
      };
    }

    // tombstone 和 purged 是终态
    if (currentState === 'tombstone' || currentState === 'purged') {
      return { nextState: currentState, shouldPromote: false, shouldDemote: false, reason: 'terminal state' };
    }

    // === 晋升路径：向上走 ===
    // 高显著性 + 足够周期 → 直接 consolidated
    if (
      salience >= this.THRESHOLDS.saliencePromoteThreshold &&
      sleepCyclesSurvived >= this.THRESHOLDS.minCyclesForConsolidation &&
      consolidation >= this.THRESHOLDS.weakeningMax
    ) {
      return {
        nextState: 'consolidated',
        shouldPromote: true,
        shouldDemote: false,
        reason: `high salience=${salience.toFixed(2)}, survived ${sleepCyclesSurvived} cycles`,
        deltaConsolidation: +(0.7 - consolidation).toFixed(3),
      };
    }

    // consolidation 达标 + 周期数够 → consolidated
    if (
      consolidation >= this.THRESHOLDS.consolidatedMin &&
      sleepCyclesSurvived >= this.THRESHOLDS.minCyclesForConsolidation &&
      currentState !== 'consolidated'
    ) {
      return {
        nextState: 'consolidated',
        shouldPromote: true,
        shouldDemote: false,
        reason: `consolidation=${consolidation.toFixed(2)} ≥ 0.7, cycles=${sleepCyclesSurvived}`,
      };
    }

    // === 降级路径：向下走 ===
    // consolidation 极低 → expiring
    // 🔴 不再判 `!== 'tombstone'`：本函数开头（终态分支）已对 tombstone/purged 提前 return，
    //    走到这里 currentState 已不可能是 tombstone —— 该条件恒真，是死代码。
    if (consolidation <= this.THRESHOLDS.expiringMax && currentState !== 'expiring') {
      return {
        nextState: 'expiring',
        shouldPromote: false,
        shouldDemote: true,
        reason: `consolidation=${consolidation.toFixed(2)} ≤ 0.2`,
      };
    }

    // 长时间未回忆 → weakening → expiring
    if (daysSinceLastRecall >= this.THRESHOLDS.noRecallDaysExpiring && currentState !== 'expiring') {
      return {
        nextState: 'expiring',
        shouldPromote: false,
        shouldDemote: true,
        reason: `no recall for ${daysSinceLastRecall} days`,
      };
    }

    if (
      daysSinceLastRecall >= this.THRESHOLDS.noRecallDaysWeakening &&
      currentState === 'fresh' &&
      consolidation < this.THRESHOLDS.weakeningMax
    ) {
      return {
        nextState: 'weakening',
        shouldPromote: false,
        shouldDemote: true,
        reason: `no recall for ${daysSinceLastRecall} days, low consolidation`,
      };
    }

    // === 默认：小幅巩固度推进 ===
    const deltaConsolidation = this.calcDeltaConsolidation(activation, nRefs);
    const newConsolidation = Math.min(1, Math.max(0, consolidation + deltaConsolidation));

    // 状态不变，返回当前状态
    return {
      nextState: currentState,
      shouldPromote: false,
      shouldDemote: false,
      reason: 'steady state',
      deltaConsolidation: +deltaConsolidation.toFixed(4),
    };
  }

  /** 计算巩固度增量（睡眠巩固效应） */
  private calcDeltaConsolidation(activation: number, nRefs: number): number {
    // 激活度越高、被引用越多，巩固度增长越快（类似记忆强化）
    const baseGrowth = 0.02; // 基础生长
    const activationBoost = activation * 0.05;
    const refBoost = Math.min(nRefs, 10) * 0.005;
    return baseGrowth + activationBoost + refBoost;
  }

  /** 是否应该进入 tombstone（待清理） */
  shouldEnterTombstone(input: TransitionInput): boolean {
    return (
      input.currentState === 'expiring' &&
      input.consolidation <= 0.05 &&
      input.daysSinceLastRecall >= 60
    );
  }
}
