/**
 * Prefrontal Domain 类型定义 — 前额叶管理域
 * =============================================
 * 定义前额叶内部数据结构：工作记忆槽位、目标栈、约束校验、执行指令。
 *
 * Ref: WS-TIANQUAN-BIONIC-001 §第五部分
 */

import type { SceneSnapshot } from '../temporal/types.js';

// ─── 工作记忆 ───

/** 单个工作记忆槽位 */
export interface WorkingMemorySlot {
  /** 槽位编号 1-7 */
  slotId: number;
  /** 当前占用状态 */
  occupied: boolean;
  /** 当前加载的场景快照引用 */
  snapshot?: SceneSnapshot;
  /** 推演状态 */
  status: 'loading' | 'active' | 'discarded';
  /** 加载时间戳（用于 LRU 驱逐） */
  loadedAt: number;
  /** 中间推演结果 */
  intermediateResults: string[];
}

/** 工作记忆全局状态 */
export interface WorkingMemoryState {
  maxSlots: 7;
  activeSlots: number;
  slots: WorkingMemorySlot[];
  evictionPolicy: 'lru' | 'priority' | 'calcium_weighted';
}

// ─── 目标栈 ───

/** 三层目标结构 */
export interface GoalStackState {
  /** 长期目标（跨会话持久化） */
  longTerm: string[];
  /** 短期目标（会话级） */
  session: string | null;
  /** 即时意图（当前轮次） */
  immediate: string | null;
}

// ─── 约束校验 ───

/** 五维约束校验结果（V4.0 扩展为六维：加 knowledgeConsistencyCheck） */
export interface ConstraintResult {
  personaCheck: boolean;
  emotionCheck: boolean;
  safetyCheck: boolean;
  logicCheck: boolean;
  realityCheck: boolean;
  /** V4.0 第六维：知识一致性（第二大脑 vs 第一大脑） */
  knowledgeConsistencyCheck: boolean;
  /** 整体是否通过 */
  passed: boolean;
  /** 违规详情 */
  violations: string[];
}

/** 五维约束校验输入上下文 */
export interface ConstraintInput {
  message: string;
  snapshot: SceneSnapshot | null;
  goalState: GoalStackState;
  emotionVector: Record<string, number>;
  familyContext: Array<{ entity: string; relation: string }>;
  socialContext: Array<{ entity: string; relation: string }>;
  conversationHistory: Array<{ role: string; content: string }>;
  currentRoleplay: string | null;
  isRoleplaying: boolean;
}

// ─── 对话组（事件分割） ───

/** 对话组状态（从 chat.ts 迁移） */
export interface DialogGroupState {
  id: string;
  topic: string;
  locusPath: string;
  rounds: Array<{ q: string; a: string; seqPos: number; time: number }>;
  perceptions: Record<string, number>[];
  maxCalcium: number;
  maxCalciumRound: number;
  entities: string[];
  startTime: number;
  rpChar?: string;
}

// ─── 执行指令 ───

/** 前额域生成的标准化执行指令 */
export interface PrefrontalDirective {
  directiveId: string;
  createdAt: string;

  /** 指令类型 */
  type: 'generate_speech' | 'update_emotion' | 'update_world_model'
      | 'query_memory' | 'store_knowledge' | 'alert_user'
      | 'plan_goal' | 'constraint_violation'
      | 'route_to_gold_vault'           // V4.0: 第二大脑→金库路由
      | 'sync_knowledge_bridge';        // V4.0: 知识库桥接同步

  /** 优先级 */
  priority: 'critical' | 'high' | 'medium' | 'low';

  /** 目标执行模块 */
  targetModule: 'yao_ling' | 'yao_guang' | 'heart' | 'temporal' | 'knowledge';

  /** 指令负载 */
  payload: Record<string, unknown>;

  /** 约束校验结果 */
  constraints: ConstraintResult;

  /** 预期完成时间 ms */
  expectedCompletionMs: number;

  /** 关联元认知复盘标记 */
  metacognitionTag?: string;
}

// ─── 元认知复盘 ───

/** 实际执行结果（反馈给 MetacognitionReview） */
export interface ActualOutcome {
  /** 用户是否接受/满意 */
  userAccepted: boolean;
  /** 情感变化（post - pre） */
  emotionDelta: { pleasure: number; arousal: number; intimacy: number };
  /** 任务是否完成 */
  taskCompleted: boolean;
  /** 用户后续消息的情绪（如果有） */
  followUpSentiment?: 'positive' | 'negative' | 'neutral';
  /** 自由文本备注 */
  notes: string;
}

/** 元认知摘要 */
export interface MetacognitionSummary {
  summaryId: string;
  createdAt: string;
  /** 关联的指令 */
  directiveId: string;
  /** 预测 vs 实际 */
  predictedOutcome: string;
  actualOutcome: string;
  /** 差距分析 */
  gapAnalysis: string;
  /** 改进建议 */
  improvementHint: string;
  /** 是否值得推送梦境引擎优化 */
  worthSubmitting: boolean;
}

// ─── 前额域上下文 ───

/** PrefrontalCortex 处理输入 */
export interface PrefrontalInput {
  snapshot: SceneSnapshot;
  sessionId: string;
  rawInput: string;
  /** V4.0 Phase 3: 外部上下文块（CoreMemory/经验/情绪/时空等），PFC 组装后返回 */
  contextBlocks?: ContextBlock[];
}

/** V4.0 Phase 3: 上下文块 — PFC 组装 LLM 上下文的标准化输入 */
export interface ContextBlock {
  /** 块来源标签 */
  source: 'core_memory' | 'experience' | 'emotion_regulation' | 'forgetting' | 'temporal' | 'guard' | 'somatic';
  /** 块内容 */
  content: string;
  /** 优先级 0-100（越高越靠前） */
  priority: number;
}

/** PrefrontalCortex 处理输出 */
export interface PrefrontalOutput {
  directive: PrefrontalDirective;
  /** 工作记忆当前状态 */
  wmState: WorkingMemoryState;
}
