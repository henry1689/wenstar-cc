/**
 * Prefrontal Domain 类型定义 — 前额叶管理域
 * =============================================
 * 定义前额叶内部数据结构：工作记忆槽位、目标栈、约束校验、执行指令。
 *
 * Ref: WS-TIANQUAN-BIONIC-001 §第五部分
 */

import type { SceneSnapshot } from '../temporal/types.js';
import type { DNA } from '../../../m1/types/dna.js';
import type { M3Decision } from '../../../m3/types/perception.js';

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
  rounds: Array<{
    q: string;
    a: string;
    seqPos: number;
    time: number;
    /**
     * 🔴 P145 批 C（2026-11-01）空间对齐 —— 每轮**回答者**的真实身份。
     *
     * 背景：本结构此前只有 q/a，落库时（dialog-group-stage / BlockSummaryService）
     * 只能把回答一律标成「玉瑶」。会晤中阿珍、诗雨的发言因此被记成玉瑶说的，
     * 并随 wiki 摘要进入 B 链路召回入口 —— 主体错乱且不可逆。
     *
     * 全部字段**可选**：旧块（本批之前产生）缺这些字段时，落库侧回退「玉瑶」，
     * 与改动前逐字一致；玉瑶态本身也回退「玉瑶」（speakerUuid 为 null）。
     */
    speakerUuid?: string | null;
    speakerName?: string;
    /** 该轮**业主发言**的听觉范围（room = 全场；seat = 只此一人可闻） */
    audience?: { kind: 'room' } | { kind: 'seat'; uuid: string };
    /** 耳语目标（与 audience.kind==='seat' 同源，便于落库侧快速判定） */
    whisperTo?: string;
  }>;
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

/** PrefrontalCortex 处理输入 (V4.0 Phase 6 扩展: 完整上下文替代 globalThis 传递) */
export interface PrefrontalInput {
  /** 场景快照（Phase 6: 可选，PFC 可在内部分配） */
  snapshot: SceneSnapshot;
  /** 会话标识 */
  sessionId: string;
  /** 原始用户输入 */
  rawInput: string;
  /** V4.0 Phase 3: 外部上下文块（Phase 6 废弃，改为 PFC 内部组装） */
  contextBlocks?: ContextBlock[];
  // ── V4.0 Phase 6: 完整输入上下文（替代 globalThis.__xxx 中转）──
  /** M1 DNA 编码（实体基因、场景标签等） */
  dna?: DNA;
  /** M3 感知三元组（愉悦/唤醒/亲密） */
  perception?: { pleasure: number; arousal: number; intimacy: number };
  /** M3 感知决策 */
  decision?: M3Decision;
  /** M4 检索上下文（记忆列表、摘要、家族上下文等） */
  ctxM4?: any;
  /** 丰富后的对话历史（最近 10 轮） */
  enrichedHistory?: Array<{ role: string; content: string }>;
  /** 当前角色扮演角色名（null=非角色模式） */
  currentRoleplay?: string | null;
  /** 当前角色路由（secretary/lover/counselor/strategist/recaller） */
  currentRole?: string;
  /** M4 检索的情绪记忆列表 */
  emotionalMemories?: any[];
  /** M4 检索的记忆文本片段 */
  memoryFragments?: string[];
  // ── V4.0 Phase 7: 运行时上下文 ──
  /** 时空感知块（天气/模式豁免等，由 chat.ts 构建后传入） */
  temporalBlock?: string;
  /** 气象查询结果（由 chat.ts weatherContext 传入） */
  weatherContext?: string;
  /** 是否启用时空规则引擎 */
  enableTemporalEngine?: boolean;
  /** 🔴 P0-2 会话模式分级: deep=会晤/新话题全量，standard=常规，casual=闲聊精简 */
  depth?: 'deep' | 'standard' | 'casual';
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

/** PrefrontalCortex 处理输出 (V4.0 Phase 6 扩展: 统一组装产物) */
export interface PrefrontalOutput {
  directive: PrefrontalDirective;
  /** 工作记忆当前状态 */
  wmState: WorkingMemoryState;
  // ── V4.0 Phase 6: PFC 统一组装输出（替代 chat.ts 手工拼装 finalKnowledgeText）──
  /** 组装完成的系统提示词（直接传给 M5.orchestrate 第3参数） */
  assembledSystemPrompt?: string;
  /** 组装完成的上下文块文本（CoreMemory + 经验 + 情绪 + 遗忘 + 时空） */
  assembledContext?: string;
  /** PFC 守卫消息（约束违规时返回给 chat.ts 注入到 enrichedWithGuard） */
  guardMessage?: string;
  /** 情绪上下文（供角色路由/安全网使用，从 HeartStateStore 提取） */
  emotionContext?: { pleasure: number; arousal: number; intimacy: number; dominantEmotion?: string };
}
