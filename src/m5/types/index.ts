// M5 表达生成层类型定义
// Ref: M5-design-v1.md §2-§4

import type { M3Action, M3Context } from '../../m3/types/perception.js';

export interface CognitionObject {
  current: {
    action: M3Action[];
    emotion_summary: string;
    key_entities: string[];
    calcium_level: number;
    /** 感知维度快照 — 用于情绪镜像 */
    raw_input: string;
    perception_snapshot: {
      pleasure: number;
      arousal: number;
      intimacy: number;
      sexual_attraction: number;
      sensory_craving: number;
      energy_merge: number;
      possessiveness: number;
      ecstasy: number;
      sincerity: number;
      aggression: number;
      dominance: number;
      safety: number;
    };
  };
  history: {
    has_relevant_history: boolean;
    summary: string;
    time_span: string;
  };
  family?: {
    has_family_context: boolean;
    relationships: string[];
  };
  strategy_hint: {
    tone: 'warm' | 'neutral' | 'serious' | 'intimate';
    depth: 'shallow' | 'medium' | 'deep';
    urgency: 'low' | 'medium' | 'high';
  };
}

export interface StrategyConfig {
  strategy_id: string;
  params: {
    tone: string;
    emotion_color?: string;
    /** P1-2: 由 M3 感知维度计算的生成温度 */
    temperature?: number;
    max_length: number;
    include_entity: string[];
    include_history: boolean;
    include_family: boolean;
  };
  description: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;  // ISO 8601 时间戳
  /** V12.2: 实体归属UUID — 跨重启时保留对话归属信息 */
  belongEntityUuid?: string;
}

/**
 * 🔴 P1-5: LLM 流式 token 增量。
 * 服务端已完成思维链剥离，仅推送可安全展示的答案增量（thinking 不推——人设安全）。
 * 流式预览 ≈ M5 校准前草稿；最终文本以 done 帧 reply 覆盖气泡。
 */
export interface LLMTokenDelta {
  /** 可安全展示的答案增量（已剥离思维链前缀） */
  text?: string;
}

export interface LLMProvider {
  generate(params: {
    strategy: StrategyConfig;
    cognition: CognitionObject;
    conversationHistory?: ConversationTurn[];
    /** 知识库内容（注入到系统提示层） */
    knowledgeBase?: string;
    /** 当前系统时间（Asia/Shanghai） */
    currentTime?: string;
    /** 用户本轮原始输入（未经过 M1-M4 管线处理，用于精确关键词匹配） */
    userMessage?: string;
    /** P0: 角色路由结果（由 M5Orchestrator 预先计算，避免耦合在 LLM Provider 内部） */
    role?: import('../../app/role/RoleClassifier.js').RoleType;
    /** 🆕 V4.0: 是否处于实体会晤模式 */
    isEntityMeeting?: boolean;
    /** 🔴 P1-5 流式: 可选回调，服务端按 token 增量推送（已剥离思维链）。返回契约不变 */
    onToken?: (delta: LLMTokenDelta) => void;
    /**
     * 🔴 V25(2026-09-13) 重试降级参数: 覆盖本次调用的场景默认 reasoning_effort。
     *
     * 用途单一 —— **空回复重试**。思维链泄漏的根因不是判据不够，而是 content 为空：
     * V4-flash 把"打算怎么写"整段写进 reasoning，思维链吃光 max_tokens → 最终稿无处安放。
     * 此时**同参重试**只会复现同样的输出（M5Orchestrator 原实现即如此，重试形同虚设）；
     * 降 effort 才能让模型把最终稿落进 content，从源头消除"从 reasoning 里猜答案"的需求。
     */
    reasoningEffortOverride?: string;
  }): Promise<{ text: string; usage?: { prompt: number; completion: number } }>;

  /** 切换角色 (可选实现) */
  setPersona?(persona: import('../../app/persona/types.js').IPersona): void;

  /** V3.2: 原始 LLM 调用（绕过 persona 和角色路由），供提取/分析类任务使用 */
  rawCall?(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, maxTokens: number, temperature: number): Promise<string>;
}
