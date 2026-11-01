/**
 * emotion-decay — 24D 情感衰减引擎
 *
 * 神经递质式递归衰减：每个维度有独立半衰期。
 * 模拟人体神经递质代谢：安全感半衰期 72h，唤醒度半衰期 2h。
 *
 * E_new = clamp(E_base × e^(-Δt/τ) + ΔE_stim × k_margin, 0, 100)
 *   τ = τ_base × k_relation × k_personality
 *   k_margin = 1 - |E_base - 50| / 100
 *   k_personality 初始 1.0，后续通过人格配置调整
 *
 * 附加基线规则：长期无刺激时向人格基线缓慢回落，非归零。
 */
import type { EmotionState24 } from '../../bus/types.js';
import { DIM_DECAY_CLASS, DECAY_HALFLIFE, type DecayClass } from './stimulus-table.js';

/** 人格基线（默认值，后续可通过人格配置覆盖） */
const DEFAULT_BASELINE: number[] = [
  // joy    sad    anger  fear   surp   disg   calm   anx
  0.3,    0,     0,     0,     0.1,   0,     0.5,   0,
  // aff    trust  intim  resp
  0.2,    0.3,   0.1,   0.2,
  // arou   fatig  excit  bored
  0.1,    0.1,   0.1,   0,
  // dom    compl  warmth  cold
  0,      0.1,   0.3,   0,
  // nost   curi   shy   jeal
  0,      0.2,   0,     0,
];

/** 基线回归速率（每小时向基线靠近的比例） */
const BASELINE_RETURN_RATE = 0.005; // 每小时 0.5%，约 200 小时回归到基线

export interface DecayInput {
  current: EmotionState24;       // 当前情绪状态分量集
  delta: Partial<EmotionState24>; // 本轮刺激增量
  deltaHours: number;              // 距上次更新的时间差（小时）
  relationStage: string;           // 关系阶段
  personalityFactor?: number;      // 人格系数，默认 1.0
  emotionProfile?: 'default' | 'sensitive' | 'steady';
}

export interface DecayOutput {
  vector: EmotionState24;
  decayed: boolean;                // 是否发生了衰减变化
  appliedDelta: boolean;           // 是否应用了刺激
}

/**
 * 应用 24D 衰减 + 刺激
 *
 * E_new = clamp(E_base × e^(-Δt/τ) + ΔE × k_margin, 0, 100)
 */
export function applyDecay(input: DecayInput): DecayOutput {
  const current = objectToArray(input.current);
  const deltaArr = objectToArray(input.delta);
  const { deltaHours, relationStage } = input;
  const kPersonality = input.personalityFactor ?? 1.0;

  // 关系阶段 → 情绪类别系数（在 stimulus-table 中已计算，这里只用 k_personality）
  // τ = τ_base × k_relation × k_personality
  // 注意：k_relation 已在 getStimulusDelta 中应用，此处不需要重复

  // 人格配置文件（可选）
  const profileMultiplier = getProfileMultiplier(input.emotionProfile);

  const result: number[] = [];
  let decayed = false;
  let appliedDelta = false;

  for (let i = 0; i < 24; i++) {
    const baseVal = current[i];
    const decayClass: DecayClass = DIM_DECAY_CLASS[i];
    const tauBase = DECAY_HALFLIFE[decayClass];

    // τ = τ_base × k_personality × profile
    const tau = tauBase * kPersonality * profileMultiplier[i];
    const effectiveTau = Math.max(0.1, tau); // 防止除零

    // 衰减: E_base × e^(-Δt/τ)
    const decayFactor = Math.exp(-deltaHours / effectiveTau);
    const decayedVal = baseVal * decayFactor;

    if (Math.abs(decayedVal - baseVal) > 0.01) decayed = true;

    // 基线回归：长期无刺激时缓慢向基线靠拢
    const baseline = DEFAULT_BASELINE[i];
    const baselinePull = (baseline - decayedVal) * Math.min(1, deltaHours * BASELINE_RETURN_RATE);

    let newVal = decayedVal + baselinePull;

    // 刺激增量
    const deltaVal = deltaArr[i];
    if (Math.abs(deltaVal) > 0.01) {
      // 边际递减已经在 getStimulusDelta 中应用
      newVal += deltaVal;
      appliedDelta = true;
    }

    // clamp [0, 100]
    result.push(clamp(newVal, 0, 100));
  }

  return {
    vector: arrayToObject(result),
    decayed,
    appliedDelta,
  };
}

/**
 * 仅衰减（无刺激，用于长时间无对话的批量回补）
 */
export function applyDecayOnly(current: EmotionState24, deltaHours: number): EmotionState24 {
  return applyDecay({
    current,
    delta: {} as Partial<EmotionState24>,
    deltaHours,
    relationStage: 'stranger',
  }).vector;
}

// ── 工具函数 ──

const DIM_KEYS: (keyof EmotionState24)[] = [
  'joy', 'sadness', 'anger', 'fear', 'surprise', 'disgust', 'calm', 'anxiety',
  'affection', 'trust', 'intimacy', 'respect',
  'arousal', 'fatigue', 'excitement', 'boredom',
  'dominance', 'compliance', 'warmth', 'coldness',
  'nostalgia', 'curiosity', 'shyness', 'jealousy',
];

function objectToArray(vec: Partial<EmotionState24>): number[] {
  return DIM_KEYS.map(k => (vec[k] ?? 0) as number);
}

function arrayToObject(arr: number[]): EmotionState24 {
  const obj: any = {};
  for (let i = 0; i < 24; i++) {
    obj[DIM_KEYS[i]] = clamp(Math.round(arr[i] * 100) / 100, 0, 100);
  }
  return obj as EmotionState24;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 人格倍率配置 */
function getProfileMultiplier(profile?: string): number[] {
  // 默认全 1.0
  const base = new Array(24).fill(1.0);
  if (profile === 'sensitive') {
    // 敏感人格：情绪波动更大（衰减更慢）
    for (let i = 0; i < 24; i++) base[i] = 0.8; // 衰减到 80%
  } else if (profile === 'steady') {
    // 稳定人格：情绪更平稳（衰减更快）
    for (let i = 0; i < 24; i++) base[i] = 1.3; // 衰减到 130%
  }
  return base;
}

/** 导出维度键名（供外部调试） */
export function getDimKeys(): typeof DIM_KEYS {
  return DIM_KEYS;
}
