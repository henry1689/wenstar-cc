/**
 * 边缘系统层类型定义 — S1 骨架期
 *
 * 情感/关系状态全部收敛至此。
 * S2 充实神经递质衰减 + 关系突触模型。
 */
import type { EmotionState24, RelationState, Atmosphere, MemoryPermission } from '../../bus/types.js';

// ── 全局状态快照 ──
export interface HeartGlobalState {
  emotionVector: EmotionState24;           // 情绪状态分量集（S2 做衰减；🔴 P076 原 24D 命名废除）
  relationState: RelationState;              // 关系阶段
  atmosphere: Atmosphere;                    // 对话氛围
  memoryPermission: MemoryPermission;        // 记忆权限
  relationMetrics: RelationMetrics;          // 关系数值指标
  updatedAt: string;
}

// ── 关系数值指标 ──
export interface RelationMetrics {
  trust: number;          // 信任度 0-100
  intimacy: number;       // 亲密度 0-100
  rapport: number;        // 默契度 0-100（S2 新增：对话匹配度累积）
  crack: number;          // 裂痕值 0-100
  positiveStreak: number; // 连续积极轮次
  sharedEvents: number;   // 共享事件计数
}

// ── 情感刺激增量（用于仿生钩子） ──
export interface EmotionDelta {
  vector: Partial<EmotionState24>;
  intensity: number;
}

// ── 状态变更审计日志 ──
export interface StateChangeLog {
  timestamp: number;
  triggerEvent: string;
  traceId: string;
  changes: Array<{
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
}

// ── 默认状态工厂 ──
export function defaultHeartState(): HeartGlobalState {
  return {
    emotionVector: {
      joy: 30, sadness: 0, anger: 0, fear: 0,
      surprise: 10, disgust: 0, calm: 50, anxiety: 0,
      affection: 20, trust: 30, intimacy: 10, respect: 20,
      arousal: 10, fatigue: 10, excitement: 10, boredom: 0,
      dominance: 0, compliance: 10, warmth: 30, coldness: 0,
      nostalgia: 0, curiosity: 20, shyness: 0, jealousy: 0,
    },
    relationState: 'stranger' as RelationState,
    atmosphere: 'neutral' as Atmosphere,
    memoryPermission: 'sand' as MemoryPermission,
    relationMetrics: {
      trust: 15,
      intimacy: 5,
      rapport: 0,
      crack: 0,
      positiveStreak: 0,
      sharedEvents: 0,
    },
    updatedAt: new Date().toISOString(),
  };
}
