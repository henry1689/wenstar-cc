/**
 * Temporal Domain 类型定义 — 海马时序域
 * =============================================
 * 定义海马体→前额叶的唯一数据契约：SceneSnapshot。
 *
 * Ref: WS-TIANQUAN-BIONIC-001 §第五部分
 */

import type { DNA } from '../../../m1/types/dna.js';
import type { PerceptionState24 } from '../../../m3/types/perception.js';
import type { MemorySummary, M4Context } from '../../../m4/types/index.js';

// ─── 场景快照（海马→前额唯一输出） ───

export interface SceneSnapshot {
  /** 快照唯一标识（基于上下文签名的哈希） */
  snapshotId: string;

  /** 上下文签名（用于稀疏索引 lookup） */
  contextSignature: string;

  /** 时间锚点 */
  temporal: {
    /** 快照创建时间 ISO 8601 */
    createdAt: string;
    /** 会话标识 */
    sessionId: string;
    /** 时段 */
    timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
    /** 星期几 0-6 */
    dayOfWeek: number;
  };

  /** 空间锚点 */
  spatial: {
    /** 场景地图聚类标签 */
    sceneLabel: string;
    /** 父场景 */
    parentScene?: string;
    /** 位置指纹哈希 */
    locationHash?: string;
  };

  /** 实体锚点 */
  entities: {
    /** 参与人物名称 */
    persons: string[];
    /** 话题关键词（≤5个） */
    topics: string[];
    /** 关键物体/工具/产品 */
    objects: string[];
  };

  /** 经验摘要（≤200 tokens，θ 节律快速注入 LLM 上下文） */
  experienceSummary: string;

  /** 情绪快照（来自 Heart 域附加） */
  emotion: {
    pleasure: number;      // [-1, 1]
    arousal: number;       // [-1, 1]
    intimacy: number;      // [0, 1]
    trend: 'rising' | 'falling' | 'stable';
  };

  /** 关联记忆指针（知识库中的记忆ID列表，非原始内容） */
  memoryPointers: string[];

  /** 关联知识库条目 */
  knowledgeRefs: string[];

  /** 关联家族图谱事件 */
  fgEventRefs: string[];

  /** 钙化分数（海马判断此场景的重要性） */
  calciumScore: number;

  /** 新颖性评估 */
  novelty: {
    level: 'novel' | 'familiar' | 'routine';
    similarity: number;    // [0, 1] 与最近似记忆的相似度
    multiplier: number;    // 对钙化的乘数影响
  };

  /** 情绪调节建议（来自 EmotionRegulator，可选） */
  emotionRegulation?: {
    suggestedShift: { pleasure: number; arousal: number; intimacy: number };
    confidence: number;
    basis: string;
    shouldSoothe: boolean;
  };

  /** M4 检索质量元数据 */
  retrievalMeta?: {
    totalCandidates: number;
    avgMatchScore: number;
    strategiesUsed: string[];
    dgDeduped: number;
    ca3CompletedDimensions: string[];
    indexHit: boolean;
  };
}

// ─── Builder 输入材料 ───

export interface SceneSnapshotMaterials {
  /** M4 检索输出的记忆列表 */
  memories: DNA[];
  /** M4 上下文（含决策、摘要、FG上下文） */
  m4Context: M4Context;
  /** 当前感知向量 */
  perception: PerceptionState24;
  /** 会话ID */
  sessionId: string;
  /** 用户原始输入 */
  rawInput: string;
  /** 提取的实体名称 */
  entities: Array<{ name: string; type: string }>;
  /** 当前时间（ISO 8601，可选，不传则取 Date.now()） */
  now?: string;
  /** 位置指纹（可选） */
  locationFingerprint?: string;
  /** 海马三突触结果（可选） */
  hippocampalResult?: {
    indexHit: boolean;
    dgDeduped: number;
    ca3CompletedDimensions: string[];
    ca3EnhancedQuery: string;
    finalIds: string[];
  };
}

// ─── 情绪趋势 ───

export type EmotionTrend = 'rising' | 'falling' | 'stable';

// ─── 新颖性级别 ───

export type NoveltyLevel = 'novel' | 'familiar' | 'routine';

// ─── 时段 ───

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

/** 根据小时数推导时段 */
export function hourToTimeOfDay(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

// ─── 可序列化快照（用于存储/传输） ───

export interface SerializedSceneSnapshot extends Omit<SceneSnapshot, 'emotionRegulation'> {
  emotionRegulation?: string; // JSON-stringified
}
