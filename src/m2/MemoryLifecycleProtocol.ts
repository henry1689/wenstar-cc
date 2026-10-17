/**
 * MemoryLifecycleProtocol — 长期记忆生命周期协议 (V12.0 P2-5)
 * =============================================================
 * 定义黑钻/梦境/年轮之间的晋升、巩固、遗忘流转规则。
 * 此前这些规则散落在 MemoryAssessor / M7 / M8 / SleepTimeConsolidator 中。
 *
 * 生命周期图:
 *
 *   砂金 (conversations)
 *     │ calcium >= threshold
 *     ▼
 *   金库 (memories)
 *     │ 梦境巩固 (M7) + 年轮锚定 (M8)
 *     ▼
 *   黑钻 (black_diamond) ← 永久高价值
 *     │ 选择性遗忘
 *     ▼
 *   归档 (suppressed/archived)
 *
 * 各阶段职责:
 *   M9 工作记忆: 本轮临时上下文，60s 定时刷新
 *   砂金 conversations: 完整对话原文，无截断，原始可追溯
 *   金库 memories: 语义片段 + 24D 向量, 2000字+ (已修复截断)
 *   梦境 M7: 离线归纳、冲突整理、情绪残留处理
 *   年轮 M8: 人生阶段性锚点、关键事件标记
 *   黑钻: 永久高价值信念/事实/知识，终身保留
 */

/** 记忆生命周期阶段 */
export type LifecycleStage =
  | 'working'       // M9 工作记忆
  | 'sand'          // 砂金库 conversations
  | 'gold'          // 金库 memories
  | 'dreaming'      // M7 梦境处理中
  | 'landmark'      // M8 年轮锚定
  | 'diamond'       // 黑钻永久
  | 'suppressed'    // 选择性遗忘
  | 'archived';     // 归档

/** 晋升条件 */
export interface PromotionRule {
  from: LifecycleStage;
  to: LifecycleStage;
  conditions: string[];
  schedule: string;
  handler: string;
}

/** 生命周期流转规则 — 唯一真相源 */
export const LIFECYCLE_RULES: readonly PromotionRule[] = [
  {
    from: 'working', to: 'gold',
    conditions: ['calciumScore >= 0.25 (M3_CONFIG)', 'hasMeaningfulEntity'],
    schedule: '每轮对话即时 / 60s 定时刷新',
    handler: 'M9 WorkingMemory → M2 writeMemory',
  },
  {
    from: 'sand', to: 'gold',
    conditions: ['calciumScore >= 0.15', 'content.length >= 10'],
    schedule: '30min 定时 (MemoryAssessor.sandToGold)',
    handler: 'MemoryAssessor.runSandToGold → 写入 memories',
  },
  {
    from: 'gold', to: 'dreaming',
    conditions: ['任何金库记忆都有资格进入梦境'],
    schedule: '10s SWR 心跳 (HippocampusRhythmCoordinator)',
    handler: 'M7 ConsolidationQueue → 梦境列队处理',
  },
  {
    from: 'gold', to: 'landmark',
    conditions: ['calcium >= 0.65 OR reinforcement >= 1.5 OR recallCount >= 3 + effectiveStrength > 0.5'],
    schedule: '30s 心跳 (ConsolidationQueue)',
    handler: 'M8 ConsolidationQueue → 地标标记',
  },
  {
    from: 'gold', to: 'diamond',
    conditions: ['calciumScore >= 4.5', 'recallCount >= 5'],
    schedule: '2h 定时 (MemoryAssessor.goldToDiamond)',
    handler: 'MemoryAssessor.runGoldToDiamond → BlackDiamondGate',
  },
  {
    from: 'gold', to: 'suppressed',
    conditions: ['decay 到 calcium < 0.05', '无 landmark 标记'],
    schedule: '24h 定时 (MemoryAssessor.runDecay)',
    handler: 'MemoryAssessor → 标记 lifecycle_state=suppressed',
  },
  {
    from: 'suppressed', to: 'archived',
    conditions: ['suppressed 状态持续 90+ 天'],
    schedule: '24h 定时 (DailyMaintenance)',
    handler: 'assembleHippocampus → 清理过期 suppressed',
  },
] as const;

/**
 * 地标晋升闸门（2026-10-18，业主批准方案A-①a）
 * ============================================================
 * 实测缺陷：全库 8957/11157 = 80% 记忆被标地标（阿珍 614/618 = 99.4%），
 *   「地标=少数重要记忆」的稀缺语义名存实亡 ——
 *   `WHERE is_landmark=1 ORDER BY calcium DESC` 的召回路径退化为纯钙化排序，
 *   而 95% 记忆钙化 < 1 ⇒ 区分度归零。
 * 根因：实现（ConsolidationQueue calcium>=0.25 / M8 任意 recent[0]）远松于
 *   本文档规则（LIFECYCLE_RULES gold→landmark）——文档-实现漂移。
 * 本函数把文档契约变成**可执行判据**（单一真源，所有晋升路径必须消费）：
 *   ① calcium >= 0.65；或 ② reinforcement >= 1.5；或 ③ recallCount >= 3 且 strength > 0.5。
 * 不满足者绝不标地标（宁缺勿滥 —— 地标是稀缺信号，不是荣誉勋章）。
 */
export const LANDMARK_RULE = {
  minCalcium: 0.65,
  minReinforcement: 1.5,
  minRecallCount: 3,
  minStrengthForRecallPath: 0.5,
} as const;

export function isLandmarkWorthy(record: {
  calcium_score?: number;
  reinforcement_accumulator?: number;
  recall_count?: number;
  effective_strength?: number;
}): boolean {
  const calcium = Number(record.calcium_score ?? 0);
  const reinforcement = Number(record.reinforcement_accumulator ?? 0);
  const recall = Number(record.recall_count ?? 0);
  const strength = Number(record.effective_strength ?? 0);
  return calcium >= LANDMARK_RULE.minCalcium
    || reinforcement >= LANDMARK_RULE.minReinforcement
    || (recall >= LANDMARK_RULE.minRecallCount && strength > LANDMARK_RULE.minStrengthForRecallPath);
}

/**
 * 检查某条记忆当前所处阶段
 */
export function inferStage(record: {
  memory_type?: string;
  lifecycle_state?: string;
  promoted_to_diamond?: number;
  is_landmark?: number;
  calcium_score?: number;
}): LifecycleStage {
  if (record.promoted_to_diamond) return 'diamond';
  if (record.lifecycle_state === 'suppressed') return 'suppressed';
  if (record.lifecycle_state === 'archived') return 'archived';
  if (record.is_landmark) return 'landmark';
  if (record.memory_type === 'dream') return 'dreaming';
  return 'gold';
}

export default { LIFECYCLE_RULES, inferStage };
