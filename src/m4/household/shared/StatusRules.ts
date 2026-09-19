/**
 * StatusRules — 实体生命周期状态流转规则
 *
 * FamilyGraph._checkStatusDowngrade 和 LifecycleManager.runDaily 各自硬编码了
 * 相同的 90天→dormant、365天→archived 阈值。本模块提供唯一常量和方法。
 *
 * 批12 新增：candidate(观察区) —— 弱证据实体先入观察区，累积证据后晋升 active，
 * 超期无提及则转 void。见 FamilyGraph._accumulateCandidateEvidence。
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
  /**
   * 批12: 观察区(candidate)存活期 —— 弱证据实体超过这些天仍无新提及，
   * 判定为非真人实体（滑窗片段），自动清除为 void。
   */
  CANDIDATE_EXPIRE_DAYS: 30,
} as const;

/**
 * 批13(F2): 解析「最后活跃时间」—— 生命周期判定的唯一基准来源。
 *
 * 背景：原先各调用点统一读 properties.last_mentioned，但该字段由
 * updatePersonProfile 合并写入，存在被旧值覆盖的顺序问题；而每次提及都刷新的
 * evidence.lastSeen 却无人读取，导致「刚被提及过的实体仍在按旧时间计时」。
 *
 * 规则：evidence.lastSeen 优先（它是本轮真实活动的直接证据）；缺失时回退
 * last_mentioned（兼容历史数据与未进入观察区的实体）。
 *
 * @returns ISO 时间串；两者皆无则 null（调用方应跳过该实体）
 */
export function resolveLastActivityAt(props: any): string | null {
  if (!props || typeof props !== 'object') return null;
  const ev = props.evidence;
  if (ev && typeof ev === 'object' && typeof ev.lastSeen === 'string' && ev.lastSeen) {
    return ev.lastSeen;
  }
  return typeof props.last_mentioned === 'string' && props.last_mentioned ? props.last_mentioned : null;
}

/**
 * 批13(F2): 是否豁免超期回收（用户决策 A —— 保守边界）。
 *
 * 「已由离线终审判定为 noise 的观察区实体」不再参与 candidate → void 的自动回收，
 * 转为留给批14 的人工清单。理由：真人被误 void 不可恢复（连边一起删），
 * 代价远大于噪声多留一阵。
 *
 * 注意：豁免只针对【自动回收】；人工确认后仍可显式 void（setEntityStatus）。
 */
export function isExemptFromExpiry(status: string, props: any): boolean {
  if (status !== 'candidate') return false;
  const judge = props && typeof props === 'object' ? props._judge : null;
  return !!(judge && judge.verdict === 'noise');
}

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
  // deceased/archived/void 不可自动变更
  if (currentStatus === 'deceased') return { changed: false };
  if (currentStatus === 'archived') return { changed: false };
  if (currentStatus === 'void') return { changed: false };

  // 批12: candidate(观察区) → void（长期无新提及 ⇒ 判定为非真人实体）
  // 放在 active/dormant 规则之前，且 candidate 不走 dormant/archived 路径。
  if (currentStatus === 'candidate' && daysSinceLastMention > STATUS_THRESHOLDS.CANDIDATE_EXPIRE_DAYS) {
    return {
      changed: true,
      from: 'candidate',
      to: 'void',
      reason: `观察区超过${daysSinceLastMention}天无新提及，判定为非真人实体`,
    };
  }

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
