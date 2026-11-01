/**
 * stimulus-table — 24D 情感刺激量表
 *
 * 每个事件类型对应 24 维刺激基准值。
 * 日常高频对话直接查表，零 LLM 调用。
 * 复杂/陌生语义才走 LLM 感知兜底。
 *
 * S2 定稿参数：
 *   ΔE_actual = base × intensity × k_trust × k_relation × k_margin
 *   k_margin = 1 - |E_base - 50| / 100 (边际递减，韦伯定律)
 */
import type { EmotionState24 } from '../../bus/types.js';

// ── 事件类型枚举 ──
export type StimulusType =
  | 'praise'           // 夸赞/喜欢/感谢
  | 'tease'            // 调侃/傲娇
  | 'casual_chat'      // 普通闲聊
  | 'cold'             // 冷淡/回避
  | 'hurtful'          // 伤害/攻击
  | 'apology'          // 道歉
  | 'vulnerable'       // 脆弱倾诉
  | 'question'         // 提问/好奇
  | 'adult_flirt'      // 调情
  | 'adult_dominant'   // 性支配
  | 'adult_submissive' // 性臣服
  | 'adult_explicit'   // 露骨性表达
  | 'intimate_act'     // 亲密互动
  | 'silence'          // 沉默/无输入
  | 'reunion';         // 久别重逢

// ── 24D 刺激基准值 ──
// 范围 [-10, 10]，正=促进，负=抑制，0=无影响
// 排布: [joy, sadness, anger, fear, surprise, disgust, calm, anxiety,
//        affection, trust, intimacy, respect,
//        arousal, fatigue, excitement, boredom,
//        dominance, compliance, warmth, coldness,
//        nostalgia, curiosity, shyness, jealousy]

type StimulusVector = [
  number, number, number, number, number, number, number, number,
  number, number, number, number, number, number, number, number,
  number, number, number, number, number, number, number, number,
];

const STIMULUS_BASE: Record<StimulusType, StimulusVector> = {
  // ═══ 正向互动 ═══
  praise:      [ 4, -1, -1, -1,  2, -1,  2, -2,
                  6,  4,  2,  4,  2, -1,  3, -1,
                 -1,  0,  4, -1,  0,  0,  2, -1 ],

  tease:       [ 3,  0,  0,  0,  1,  0,  0,  0,
                  2,  1,  1,  0,  4,  0,  4,  0,
                  2, -1,  2,  0,  0,  1,  1,  0 ],

  casual_chat: [ 1,  0,  0,  0,  0,  0,  1,  0,
                  0,  1,  0,  1,  0,  0,  1,  0,
                  0,  0,  1,  0,  0,  1,  0,  0 ],

  question:    [ 0,  0,  0,  0,  1,  0,  0,  0,
                  0,  0,  0,  1,  2,  0,  2, -1,
                  0,  0,  1,  0,  0,  3,  0,  0 ],

  vulnerable:  [ -1,  2,  0,  0,  0,  0, -2,  2,
                  4,  3,  2,  2, -1,  1, -1,  0,
                 -2,  2,  0,  0,  0,  0,  0,  0 ],

  // ═══ 负向互动 ═══
  cold:        [ -2,  1,  1,  0,  0,  1, -2,  2,
                 -4, -3, -2, -3, -1,  0, -2,  2,
                  0,  0, -3,  2,  0,  0,  0,  1 ],

  hurtful:     [ -5,  3,  4,  2,  0,  3, -4,  4,
                 -7, -6, -4, -5,  3,  2, -1,  0,
                  3, -2, -5,  3,  0,  0,  0,  3 ],

  apology:     [ 1, -1, -1,  0,  0, -1,  2, -1,
                  3,  5,  2,  3, -2,  0, -1,  0,
                 -2,  1,  0, -1,  0,  0,  0, -1 ],

  // ═══ 亲密互动 ═══
  adult_flirt:   [ 4,  0,  0,  0,  2,  0, -1,  1,
                    3,  1,  4,  0,  6, -1,  5, -1,
                    1, -1,  3,  0,  0,  1,  2,  0 ],

  adult_dominant:[ 3,  0,  0,  0,  1,  0, -1,  1,
                    2,  0,  4,  0,  6, -1,  5,  0,
                    5, -3,  2,  0,  0,  0,  0,  0 ],

  adult_submissive:[ 3,  0,  0,  0,  1,  0,  2, -1,
                      4,  3,  5,  2,  4,  0,  4,  0,
                     -5,  6,  3,  0,  0,  0,  1,  0 ],

  adult_explicit: [ 5,  0,  0,  0,  1,  0, -1,  1,
                     4,  1,  6,  0,  8, -1,  7, -2,
                     0,  0,  3,  0,  0,  0,  1,  0 ],

  intimate_act:  [ 5,  0,  0,  0,  1,  0,  2, -1,
                    6,  3,  7,  2,  5, -1,  5, -1,
                    0,  1,  4,  0,  0,  0,  2, -1 ],

  // ═══ 特殊状态 ═══
  silence:     [ 0,  0,  0,  0,  0,  0,  0,  0,
                  0, -1,  0,  0, -1,  1,  0,  1,
                  0,  0,  0,  0,  0, -1,  0,  0 ],

  reunion:     [ 5, -2,  0,  0,  4,  0,  1, -2,
                  7,  4,  5,  3,  4, -2,  5, -2,
                  0,  1,  4, -1,  3,  2,  0, -1 ],
};

/** 半衰期分类（用于 decay 引擎查表） */
export type DecayClass = 'steady' | 'negative' | 'acute' | 'cognitive' | 'social';

export const DIM_DECAY_CLASS: DecayClass[] = [
  // joy    sad    anger  fear   surp   disg   calm   anx
  'acute','negative','negative','negative','acute','negative','steady','negative',
  // aff    trust  intim  resp
  'steady','steady','steady','steady',
  // arou   fatig  excit  bored
  'acute','steady','acute','acute',
  // dom    compl  warmth  cold
  'cognitive','social','social','social',
  // nost   curi   shy   jeal
  'cognitive','cognitive','social','negative',
];

/** 半衰期基准值（小时） */
export const DECAY_HALFLIFE: Record<DecayClass, number> = {
  steady:   72,   // 稳态关系类：信任/亲密度/安全感
  negative: 48,   // 负向滞留类：悲伤/委屈/嫉妒
  acute:    2,    // 急性唤醒类：兴奋/惊讶/烦躁
  cognitive: 120, // 认知特质类：好奇/怀旧/平静
  social:   12,   // 社交表层类：暖意/疏离/顺从
};

/** 关系阶段系数 k_relation（三阶段 × 三情绪类型） */
export type EmotionClass = 'positive_steady' | 'negative_retain' | 'acute_arousal';

export const RELATION_COEFF: Record<string, Record<EmotionClass, number>> = {
  stranger: { positive_steady: 0.5, negative_retain: 1.2, acute_arousal: 1.0 },
  familiar: { positive_steady: 1.0, negative_retain: 1.0, acute_arousal: 1.0 },
  intimate: { positive_steady: 2.0, negative_retain: 0.8, acute_arousal: 1.0 },
};

/** 维度 → 情绪类别映射 */
export function getEmotionClass(dimIndex: number): EmotionClass {
  const dc = DIM_DECAY_CLASS[dimIndex];
  switch (dc) {
    case 'steady': return 'positive_steady';
    case 'negative': return 'negative_retain';
    default: return 'acute_arousal';
  }
}

// ── 维度键名（用于数组↔对象转换） ──
const DIM_KEYS: (keyof EmotionState24)[] = [
  'joy', 'sadness', 'anger', 'fear', 'surprise', 'disgust', 'calm', 'anxiety',
  'affection', 'trust', 'intimacy', 'respect',
  'arousal', 'fatigue', 'excitement', 'boredom',
  'dominance', 'compliance', 'warmth', 'coldness',
  'nostalgia', 'curiosity', 'shyness', 'jealousy',
];

function arrayToObject(arr: number[]): EmotionState24 {
  const obj: any = {};
  for (let i = 0; i < 24; i++) {
    obj[DIM_KEYS[i]] = arr[i];
  }
  return obj as EmotionState24;
}

// ── 核心函数：获取实际刺激增量 ──

export interface StimulusParams {
  type: StimulusType;
  intensity: number;        // 0-1，事件强度
  trustFactor: number;      // 0-1，信任调制
  relationStage: string;    // 'stranger' | 'familiar' | 'intimate'
  currentEmotion: EmotionState24;  // 当前情绪状态分量（用于边际递减）
}

export function getStimulusDelta(params: StimulusParams): EmotionState24 {
  const base = STIMULUS_BASE[params.type];
  if (!base) {
    // 未知事件类型返回零向量
    return new Array(24).fill(0) as unknown as EmotionState24;
  }

  const current = params.currentEmotion;
  const k_trust = 0.5 + params.trustFactor * 0.5;  // [0.5, 1.0]

  const result: number[] = [];
  for (let i = 0; i < 24; i++) {
    const baseVal = base[i];
    if (baseVal === 0) { result.push(0); continue; }

    // 边际递减
    const currentVal = Object.values(current)[i] as number;
    const k_margin = 1 - Math.abs(currentVal - 50) / 100;

    // 关系系数
    const emoClass = getEmotionClass(i);
    const k_relation = RELATION_COEFF[params.relationStage]?.[emoClass] ?? 1.0;

    // ΔE = base × intensity × k_trust × k_relation × k_margin
    const delta = baseVal * params.intensity * k_trust * k_relation * k_margin;
    result.push(Math.round(delta * 10) / 10);
  }

  return arrayToObject(result);
}

/** 获取基础刺激值（用于调试） */
export function getBaseStimulus(type: StimulusType): StimulusVector | null {
  return STIMULUS_BASE[type] ?? null;
}
