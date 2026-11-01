/**
 * 全局事件类型定义 — S1 骨架期
 *
 * 分层事件体系，覆盖全链路所有关键节流点
 * 每层对应一个处理阶段，payload 不跨越职责边界
 */

// ═══════════════════════════════════════════════
// 意图类型枚举
// ═══════════════════════════════════════════════

export type IntentType =
  | 'casual_chat'           // 普通闲聊
  | 'knowledge_query'       // 知识/记忆查询
  | 'memory_operation'      // 记忆增删改指令
  | 'rp_trigger'            // 角色扮演触发/切换
  | 'system_command'        // 系统命令（清空、设置等）
  | 'boundary_violation'    // 越界/违禁内容
  | 'out_of_scope';         // 无效/越界输入

export type RelationState = 'stranger' | 'familiar' | 'intimate';
export type Atmosphere = 'warm' | 'neutral' | 'cool';
export type MemoryPermission = 'sand' | 'gold' | 'diamond';

// ═══════════════════════════════════════════════
// 输入侧事件
// ═══════════════════════════════════════════════

export interface UserInputEvent {
  type: 'user:input';
  traceId: string;
  timestamp: number;
  sessionId: string;
  payload: {
    content: string;
    channel: 'text' | 'voice' | 'system' | 'phone';
    clientMsgId?: string;
    testMode?: boolean;
    context?: {
      scene?: string;
      rpMode?: string;
    };
  };
}

// ═══════════════════════════════════════════════
// 分类/意图侧事件
// ═══════════════════════════════════════════════

export interface IntentClassifiedEvent {
  type: 'intent:classified';
  traceId: string;
  timestamp: number;
  sessionId: string;
  payload: {
    rawInput: string;
    intent: IntentType;
    subIntent?: string;
    confidence: number;       // 纯规则为 1.0
    source: 'rule' | 'llm_fallback';
    shouldBypassLLM: boolean; // 是否无需 LLM 直接处理
  };
}

// ═══════════════════════════════════════════════
// 感知侧事件
// ═══════════════════════════════════════════════

export interface PerceptionAnalyzedEvent {
  type: 'perception:analyzed';
  traceId: string;
  timestamp: number;
  sessionId: string;
  payload: {
    semanticEmbedding?: number[];  // 本地嵌入模型生成（S3 接入）
    emotionTags: string[];
    sceneRecognition: string;
    familyGraphHit?: string[];
    entities: string[];
  };
}

// ═══════════════════════════════════════════════
// 记忆侧事件
// ═══════════════════════════════════════════════

export interface MemoryBlock {
  id: string;
  content: string;
  type: 'dialog' | 'event' | 'knowledge' | 'person';
  library: 'sand' | 'gold' | 'diamond';
  timestamp: number;
  importance: number;
  retrievalScore?: number;
}

export interface MemoryRetrievedEvent {
  type: 'memory:retrieved';
  traceId: string;
  timestamp: number;
  sessionId: string;
  payload: {
    shortTerm: MemoryBlock[];
    longTerm: MemoryBlock[];
    familyGraphRelated: MemoryBlock[];
    totalCount: number;
    retrievalScore: number;
  };
}

// ═══════════════════════════════════════════════
// 状态侧事件
// ═══════════════════════════════════════════════

/** 🔴 P076 乙方案（业主裁决 2026-10-24）：原 EmotionVector24D 去量纲化改名——
 *  本结构是 24 项**情绪状态分量清单**（非测量维度），量纲命名除 40D 外清零（40D 量纲统一法令）。 */
export interface EmotionState24 {
  // 基础情绪
  joy: number; sadness: number; anger: number; fear: number;
  surprise: number; disgust: number; calm: number; anxiety: number;
  // 关系维度
  affection: number; trust: number; intimacy: number; respect: number;
  // 唤醒维度
  arousal: number; fatigue: number; excitement: number; boredom: number;
  // 社交维度
  dominance: number; compliance: number; warmth: number; coldness: number;
  // 附加维度
  nostalgia: number; curiosity: number; shyness: number; jealousy: number;
}

export interface HeartStateUpdatedEvent {
  type: 'heart:state_updated';
  traceId: string;
  timestamp: number;
  sessionId: string;
  payload: {
    emotionVector: EmotionState24;
    relationState: RelationState;
    atmosphere: Atmosphere;
    memoryPermission: MemoryPermission;
  };
}

// ═══════════════════════════════════════════════
// 生成侧事件
// ═══════════════════════════════════════════════

export interface PromptFragment {
  id: string;
  category: 'personality' | 'emotion' | 'memory' | 'scene' | 'role' | 'instruction';
  content: string;
  priority: number;
}

export interface GenerationRequestEvent {
  type: 'generation:request';
  traceId: string;
  timestamp: number;
  sessionId: string;
  payload: {
    promptFragments: PromptFragment[];
    roleContext: string;
    stream: boolean;
  };
}

export interface GenerationResultEvent {
  type: 'generation:result';
  traceId: string;
  timestamp: number;
  sessionId: string;
  payload: {
    content: string;
    finishReason: string;
  };
}

// ═══════════════════════════════════════════════
// 输出侧事件
// ═══════════════════════════════════════════════

export interface OutputFinalizedEvent {
  type: 'output:finalized';
  traceId: string;
  timestamp: number;
  sessionId: string;
  payload: {
    content: string;
    renderType: 'text' | 'dialog' | 'action';
    shouldPersist: boolean;
  };
}

// ═══════════════════════════════════════════════
// 系统事件
// ═══════════════════════════════════════════════

export interface SystemErrorEvent {
  type: 'system:error';
  traceId: string;
  timestamp: number;
  sessionId: string;
  payload: {
    module: string;
    message: string;
    level: 'warn' | 'error' | 'fatal';
    originalEvent?: string;
  };
}

// ═══════════════════════════════════════════════
// 定时器事件
// ═══════════════════════════════════════════════

export interface TimerExpiredEvent {
  type: 'timer:expired';
  traceId: string;
  timestamp: number;
  sessionId: string;
  payload: {
    taskId: string;
    contextSnapshot: string;
    snapshotTTL: number;
  };
}

// ═══════════════════════════════════════════════
// 联合事件类型
// ═══════════════════════════════════════════════

export type EngineEvent =
  | UserInputEvent
  | IntentClassifiedEvent
  | PerceptionAnalyzedEvent
  | MemoryRetrievedEvent
  | HeartStateUpdatedEvent
  | GenerationRequestEvent
  | GenerationResultEvent
  | OutputFinalizedEvent
  | SystemErrorEvent
  | TimerExpiredEvent;
