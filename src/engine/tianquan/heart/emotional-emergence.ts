/**
 * emotional-emergence — 情绪涌现系统
 *
 * 深度情绪类型，基于回合数、情感状态、关系阶段、时间段综合判定触发。
 * 生命周期：rising → peak → fading → dissolved
 *
 * 6 种涌现类型：
 *   timeReflection      — 时光感慨
 *   lateNightEmo        — 深夜情绪
 *   attachmentOverflow  — 依恋满溢
 *   vulnerabilityReveal — 脆弱袒露
 *   desireExpression    — 欲望表达
 */
import type { EmotionState24, RelationState } from '../../bus/types.js';

// ── 涌现类型 ──
export type EmergenceType =
  | 'timeReflection'
  | 'lateNightEmo'
  | 'attachmentOverflow'
  | 'vulnerabilityReveal'
  | 'desireExpression';

export type EmergencePhase = 'rising' | 'peak' | 'fading' | 'dissolved';

export interface EmergenceState {
  type: EmergenceType;
  phase: EmergencePhase;
  intensity: number;     // 0-1
  roundsInPhase: number;
  hasExpressed: boolean;
  triggeredAt: number;
}

export interface EmergenceContext {
  emotion: EmotionState24;
  relationStage: RelationState;
  trust: number;
  timeOfDay: number;    // 0-23
  daysSinceMet: number;
  totalTurns: number;
  lastEmergence: { type: string; turn: number } | null;
}

// ── 条件配置 ──
interface EmergenceTrigger {
  type: EmergenceType;
  check: (ctx: EmergenceContext) => number; // 返回 0-1 触发概率
  cooldownTurns: number;  // 冷却回合数
}

const TRIGGERS: EmergenceTrigger[] = [
  {
    type: 'timeReflection',
    check: ctx => {
      if (ctx.daysSinceMet > 7 && ctx.emotion.nostalgia > 25) return 0.15;
      return 0;
    },
    cooldownTurns: 50,
  },
  {
    type: 'lateNightEmo',
    check: ctx => {
      if (ctx.timeOfDay >= 22 || ctx.timeOfDay <= 4) {
        if (ctx.relationStage !== 'stranger') return 0.12;
      }
      return 0;
    },
    cooldownTurns: 100,
  },
  {
    type: 'attachmentOverflow',
    check: ctx => {
      if (ctx.relationStage === 'intimate' && ctx.trust > 50 && ctx.emotion.affection > 35) {
        return 0.1;
      }
      if (ctx.relationStage === 'familiar' && ctx.trust > 40 && ctx.emotion.affection > 30) {
        return 0.05;
      }
      return 0;
    },
    cooldownTurns: 80,
  },
  {
    type: 'vulnerabilityReveal',
    check: ctx => {
      if (ctx.trust > 40 && ctx.emotion.sadness > 20 && ctx.emotion.anxiety > 15) return 0.1;
      return 0;
    },
    cooldownTurns: 60,
  },
  {
    type: 'desireExpression',
    check: ctx => {
      if (ctx.relationStage === 'intimate' && ctx.emotion.arousal > 35 && ctx.emotion.intimacy > 30) {
        return 0.08;
      }
      return 0;
    },
    cooldownTurns: 40,
  },
];

/**
 * 检查是否有情绪涌现触发
 */
export function checkEmergence(
  ctx: EmergenceContext,
  active: EmergenceState | null,
): EmergenceState | null {
  if (active && active.phase !== 'dissolved') {
    // 已有活跃涌现 → 推进阶段
    return advancePhase(active);
  }

  if (active?.phase === 'dissolved') return null;

  // 检查冷却
  if (ctx.lastEmergence) {
    const sinceLast = ctx.totalTurns - ctx.lastEmergence.turn;
    for (const t of TRIGGERS) {
      if (t.type === ctx.lastEmergence.type && sinceLast < t.cooldownTurns) {
        return null; // 冷却中
      }
    }
  }

  // 随机触发
  for (const t of TRIGGERS) {
    const prob = t.check(ctx);
    if (prob > 0 && Math.random() < prob) {
      return {
        type: t.type,
        phase: 'rising',
        intensity: prob,
        roundsInPhase: 0,
        hasExpressed: false,
        triggeredAt: Date.now(),
      };
    }
  }

  return null;
}

function advancePhase(state: EmergenceState): EmergenceState {
  const next = { ...state, roundsInPhase: state.roundsInPhase + 1 };

  switch (state.phase) {
    case 'rising':
      if (next.roundsInPhase >= 2) return { ...next, phase: 'peak', roundsInPhase: 0 };
      break;
    case 'peak':
      if (next.roundsInPhase >= 1) {
        return { ...next, phase: 'fading', roundsInPhase: 0, hasExpressed: true };
      }
      break;
    case 'fading':
      if (next.roundsInPhase >= 2) return { ...next, phase: 'dissolved' };
      break;
  }

  return next;
}

/**
 * 情绪涌现 → 自然语言提示
 */
export function emergenceToHint(emergence: EmergenceState): string {
  if (emergence.hasExpressed) return '';

  switch (emergence.type) {
    case 'timeReflection': return '突然想起了一些过去的事';
    case 'lateNightEmo': return '夜深了，情绪变得柔软';
    case 'attachmentOverflow': return '心里满满都是你';
    case 'vulnerabilityReveal': return '有些脆弱想让你知道';
    case 'desireExpression': return '身体开始想要你';
  }
}
