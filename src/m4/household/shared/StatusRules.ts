/**
 * StatusRules — 实体生命周期状态流转规则
 *
 * FamilyGraph._checkStatusDowngrade 和 LifecycleManager.runDaily 各自硬编码了
 * 相同的 90天→dormant、365天→archived 阈值。本模块提供唯一常量和方法。
 *
 * 使用方：
 *   - FamilyGraph._checkStatusDowngrade → transitionStatus()
 *   - LifecycleManager.runDaily → transitionStatus()
 */

/** 生命周期阈值常量 */
export const STATUS_THRESHOLDS = {
  /** 连续多少天无交互 → 转入蛰伏 (dormant) */
  DORMANT_AFTER_DAYS: 90,
  /** 连续多少天无交互 → 转入封存 (archived) */
  ARCHIVE_AFTER_DAYS: 365,
} as const;

/** 状态流转结果 */
export type StatusTransition =
  | { changed: false }
  | { changed: true; from: string; to: string; reason: string };

/**
 * 根据实体当前状态和距上次交互天数，计算目标状态。
 * 不执行 SQL 写入——由调用方决定是否 persist。
 *
 * @param currentStatus - 当前状态
 * @param daysSinceLastMention - 距上次提及的天数
 * @returns 需要转换到的新状态，若无变化返回 null
 */
export function computeTargetStatus(
  currentStatus: string,
  daysSinceLastMention: number
): StatusTransition {
  // deceased/archived 不可自动变更
  if (currentStatus === 'deceased') return { changed: false };
  if (currentStatus === 'archived') return { changed: false };

  // active → dormant (>90天)
  if (currentStatus === 'active' && daysSinceLastMention > STATUS_THRESHOLDS.DORMANT_AFTER_DAYS) {
    return {
      changed: true,
      from: 'active',
      to: 'dormant',
      reason: `连续${daysSinceLastMention}天无交互，自动转入蛰伏`,
    };
  }

  // dormant → active (近期有交互)
  if (currentStatus === 'dormant' && daysSinceLastMention < STATUS_THRESHOLDS.DORMANT_AFTER_DAYS) {
    return {
      changed: true,
      from: 'dormant',
      to: 'active',
      reason: `近期有交互(${daysSinceLastMention}天内)，自动恢复活跃`,
    };
  }

  // dormant → archived (超365天)
  if (currentStatus === 'dormant' && daysSinceLastMention > STATUS_THRESHOLDS.ARCHIVE_AFTER_DAYS) {
    return {
      changed: true,
      from: 'dormant',
      to: 'archived',
      reason: `超过${daysSinceLastMention}天无交互，自动封存`,
    };
  }

  return { changed: false };
}
